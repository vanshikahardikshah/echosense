import { describe, expect, it } from 'vitest';
import { PassiveAudio, SoundEvent } from '../src/audio/passive';
import { Biquad } from '../src/dsp/filters';
import { horizontal, PositionTracker, trilaterate } from '../src/fusion/trilateration';
import { ImuEvent, ImuMonitor } from '../src/motion/imu';
import { Rng } from '../src/sim/random';
import { SCENARIOS } from '../src/sim/scenarios';
import { mixInto, SoundKind, synthesize } from '../src/sim/sounds';
import { runEngine } from './engineHarness';

const FS = 48000;

function classify(kind: SoundKind, seed: number, extra?: (x: Float32Array, rng: Rng) => void): SoundEvent[] {
  const rng = new Rng(seed * 13);
  const x = new Float32Array(12 * FS);
  const lp = Biquad.lowpass(FS, 600);
  const lp2 = Biquad.lowpass(FS, 8000);
  for (let i = 0; i < x.length; i++) x[i] = 2e-3 * (2.1 * lp.process(rng.gauss()) + 0.3 * lp2.process(rng.gauss())) + 2e-4 * rng.gauss();
  mixInto(x, synthesize(kind, FS, rng), 5 * FS);
  extra?.(x, rng);
  const pa = new PassiveAudio(FS, 1024);
  const out: SoundEvent[] = [];
  for (let f = 0; f + 1024 <= x.length; f += 1024) {
    const r = pa.process(x.subarray(f, f + 1024), f / FS);
    if (r.event) out.push(r.event);
  }
  return out;
}

describe('passive acoustic events', () => {
  const first = (k: SoundKind, seed: number) => classify(k, seed)[0]?.cls;
  it.each([1, 2, 3])('classifies a thud as an impact (seed %i)', (s) => expect(first('thud', s)).toBe('impact'));
  it.each([1, 2])('classifies a door slam as an impact (seed %i)', (s) => expect(first('door', s)).toBe('impact'));
  it.each([1, 2])('classifies breaking glass (seed %i)', (s) => expect(first('glass', s)).toBe('glass'));
  it.each([1, 2])('classifies a scream (seed %i)', (s) => expect(first('scream', s)).toBe('scream'));
  it('never calls speech an impact or a scream', () => {
    for (const s of [1, 2, 3]) {
      const evs = classify('speech', s);
      expect(evs.filter((e) => e.cls === 'impact' || e.cls === 'scream')).toHaveLength(0);
    }
  });
  it('treats music as sustained sound, not incidents', () => {
    const evs = classify('music', 1);
    expect(evs.filter((e) => e.cls === 'impact' && !e.repetitive)).toHaveLength(0);
  });
  it('does not call footsteps impacts', () => {
    const evs = classify('footstep', 1, (x, rng) => {
      for (let t = 6; t < 9; t += 0.55) mixInto(x, synthesize('footstep', FS, rng), Math.round(t * FS));
    });
    expect(evs.filter((e) => e.cls === 'impact')).toHaveLength(0);
  });
  it('flags a regular series of thuds as repetitive', () => {
    const evs = classify('thud', 4, (x, rng) => {
      for (const t of [6.5, 8, 9.5]) mixInto(x, synthesize('thud', FS, rng), Math.round(t * FS));
    });
    expect(evs.filter((e) => e.cls === 'impact').some((e) => e.repetitive)).toBe(true);
  });
});

function imuRun(mode: 'room' | 'body', gen: (t: number) => [number, number, number, number]): ImuEvent[] {
  const imu = new ImuMonitor(mode);
  const evs: ImuEvent[] = [];
  for (let t = 0; t < 10; t += 1 / 60) {
    const [ax, ay, az, g] = gen(t);
    const e = imu.process({ t, ax, ay, az, gx: g, gy: 0, gz: 0 });
    if (e) evs.push(e);
  }
  return evs;
}

describe('IMU', () => {
  it('is silent when the phone lies still', () => {
    const rng = new Rng(3);
    expect(imuRun('room', () => [0.02 * rng.gauss(), 0.02 * rng.gauss(), 9.81 + 0.02 * rng.gauss(), 0.3 * rng.gauss()])).toHaveLength(0);
  });
  it('reports a pick-up and, once set down, a settle', () => {
    const evs = imuRun('room', (t) => (t > 3 && t < 5 ? [2 * Math.sin(9 * t), 1.5, 9.81 + 2 * Math.cos(7 * t), 60] : [0, 0, 9.81, 0]));
    expect(evs.map((e) => e.type)).toEqual(['moved', 'settled']);
  });
  it('detects a drop (free fall then impact)', () => {
    const evs = imuRun('room', (t) => {
      if (t > 4 && t < 4.3) return [0, 0, 0.5, 0];
      if (t >= 4.3 && t < 4.35) return [5, 3, 35, 200];
      return [0, 0, 9.81, 0];
    });
    expect(evs.some((e) => e.type === 'drop')).toBe(true);
  });
  it('detects a wearer fall in body mode', () => {
    const evs = imuRun('body', (t) => {
      if (t < 4) return [0.3 * Math.sin(10 * t), 9.81, 0.3, 5]; // upright in a pocket
      if (t < 4.25) return [0, 2, 0.5, 120]; // falling
      if (t < 4.32) return [12, 20, 15, 300]; // impact
      return [0.05, 0.1, 9.81, 0]; // lying, rotated 90 degrees
    });
    expect(evs.some((e) => e.type === 'body_fall')).toBe(true);
  });
});

describe('trilateration', () => {
  const truth = { x: 1.7, y: 2.2 };
  const nodes = [
    { id: 'a', x: 0, y: 0 },
    { id: 'b', x: 4, y: 0 },
    { id: 'c', x: 0, y: 4 },
  ];
  it('is exact with perfect ranges', () => {
    const p = trilaterate(
      nodes.map((n) => ({ ...n, range: Math.hypot(truth.x - n.x, truth.y - n.y), sigma: 0.1 })),
      null,
    )!;
    expect(Math.hypot(p.x - truth.x, p.y - truth.y)).toBeLessThan(0.01);
    expect(p.gdop).toBeLessThan(2);
  });
  it('degrades gracefully with noisy ranges', () => {
    const rng = new Rng(9);
    const errs: number[] = [];
    for (let i = 0; i < 200; i++) {
      const p = trilaterate(
        nodes.map((n) => ({ ...n, range: Math.hypot(truth.x - n.x, truth.y - n.y) + 0.08 * rng.gauss(), sigma: 0.08 })),
        null,
      )!;
      errs.push(Math.hypot(p.x - truth.x, p.y - truth.y));
    }
    errs.sort((a, b) => a - b);
    expect(errs[errs.length >> 1]).toBeLessThan(0.12);
  });
  it('resolves the two-phone mirror ambiguity with room bounds', () => {
    const two = [
      { id: 'a', x: 0, y: 0 },
      { id: 'b', x: 4, y: 0 },
    ].map((n) => ({ ...n, range: Math.hypot(truth.x - n.x, truth.y - n.y), sigma: 0.1 }));
    const p = trilaterate(two, null, { minX: 0, maxX: 4, minY: 0, maxY: 4 })!;
    expect(Math.hypot(p.x - truth.x, p.y - truth.y)).toBeLessThan(0.01);
  });
  it('converts slant range to floor range', () => {
    expect(horizontal(1.3, 0.5)).toBeCloseTo(1.2, 6);
  });
  it('smooths a moving fix', () => {
    const tr = new PositionTracker();
    let last = { x: 0, y: 0 };
    for (let i = 0; i < 50; i++) last = tr.update({ x: i * 0.02, y: 1 }, i * 0.1);
    expect(last.x).toBeGreaterThan(0.9);
    expect(Math.abs(last.y - 1)).toBeLessThan(0.01);
  });
});

describe('fusion engine on simulated rooms', () => {
  const kinds = (key: string, opts = {}) => {
    const { alerts } = runEngine(SCENARIOS[key], opts);
    return alerts;
  };
  it('detects a fall, checks in and escalates when nobody answers', () => {
    const a = kinds('fall');
    const fall = a.find((x) => x.kind === 'fall');
    expect(fall?.severity).toBe('critical');
    expect(fall!.t).toBeGreaterThan(11);
    expect(fall!.t).toBeLessThan(20);
    expect(a.some((x) => x.kind === 'escalation')).toBe(true);
  }, 120000);
  it('does not escalate when the person answers the check-in', () => {
    const { alerts } = runEngine(SCENARIOS.fall, { respondAt: 22 });
    expect(alerts.some((x) => x.kind === 'fall')).toBe(true);
    expect(alerts.some((x) => x.kind === 'resolved')).toBe(true);
    expect(alerts.some((x) => x.kind === 'escalation')).toBe(false);
  }, 120000);
  it('runs the full investor-demo script correctly', () => {
    const a = kinds('demo');
    const order = a.map((x) => x.kind);
    expect(order[0]).toBe('presence');
    expect(order).toContain('approach');
    expect(order).toContain('breathing');
    expect(order.indexOf('breathing')).toBeLessThan(order.indexOf('fall'));
    expect(a.filter((x) => x.kind === 'fall')).toHaveLength(1);
    const br = a.find((x) => x.kind === 'breathing')!;
    expect(br.title).toMatch(/1[2-5]\/min/);
  }, 120000);
  it('does not call sitting down a fall', () => {
    expect(kinds('sitDown').some((x) => x.kind === 'fall')).toBe(false);
  }, 120000);
  it('does not call a dropped object a fall', () => {
    const a = kinds('droppedObject');
    expect(a.some((x) => x.kind === 'impact')).toBe(true);
    expect(a.some((x) => x.kind === 'fall')).toBe(false);
  }, 120000);
  it('stays calm in an empty room full of TV, music and noise', () => {
    const a = kinds('noisyEmpty');
    expect(a.filter((x) => ['presence', 'approach', 'fall', 'breathing', 'escalation'].includes(x.kind))).toHaveLength(0);
  }, 120000);
  it('ignores a door slam while someone walks through', () => {
    const a = kinds('walkThroughDoor');
    expect(a.some((x) => x.kind === 'fall')).toBe(false);
    expect(a.some((x) => x.kind === 'left')).toBe(true);
  }, 120000);
  it('raises an approach alert', () => {
    expect(kinds('approach').some((x) => x.kind === 'approach')).toBe(true);
  }, 120000);
  it('raises a scream alert', () => {
    expect(kinds('scream').some((x) => x.kind === 'scream')).toBe(true);
  }, 120000);
  it('keeps processing far below real time', () => {
    const { snaps } = runEngine(SCENARIOS.approach);
    expect(snaps[snaps.length - 1].perf.realtimeFactor).toBeLessThan(0.25);
  }, 120000);
});
