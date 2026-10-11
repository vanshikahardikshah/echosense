import { describe, expect, it } from 'vitest';
import { bandPlan, designChirp, LOW_BAND, speedOfSound, WIDE_BAND } from '../src/dsp/chirp';
import { FFT, getFFT } from '../src/dsp/fft';
import { MatchedFilter } from '../src/dsp/matchedFilter';
import { SonarProcessor } from '../src/dsp/sonar';
import { FS, simulate } from './helpers';

const C = speedOfSound(21);

describe('FFT', () => {
  it('matches a direct DFT', () => {
    const n = 64;
    const fft = new FFT(n);
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      re[i] = Math.sin(i * 0.37) + 0.3 * Math.cos(i * 1.9);
      im[i] = 0.1 * i;
    }
    const xr = Float64Array.from(re);
    const xi = Float64Array.from(im);
    fft.forward(re, im);
    for (let k = 0; k < n; k++) {
      let sr = 0;
      let si = 0;
      for (let t = 0; t < n; t++) {
        const a = (-2 * Math.PI * k * t) / n;
        sr += xr[t] * Math.cos(a) - xi[t] * Math.sin(a);
        si += xr[t] * Math.sin(a) + xi[t] * Math.cos(a);
      }
      expect(re[k]).toBeCloseTo(sr, 8);
      expect(im[k]).toBeCloseTo(si, 8);
    }
    fft.inverse(re, im);
    for (let i = 0; i < n; i++) expect(re[i]).toBeCloseTo(xr[i], 10);
  });
});

describe('transmit waveform', () => {
  const d = designChirp(FS, 1024, WIDE_BAND);
  it('has a flat in-band line spectrum', () => {
    const mags: number[] = [];
    for (let k = d.kLo; k <= d.kHi; k++) mags.push(Math.hypot(d.specRe[k], d.specIm[k]));
    const max = Math.max(...mags);
    const min = Math.min(...mags);
    expect(20 * Math.log10(max / min)).toBeLessThan(0.1);
  });
  it('puts no energy in the audible band, even when looped', () => {
    const N = 1024 * 8;
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let i = 0; i < N; i++) re[i] = d.samples[i % 1024];
    getFFT(N).forward(re, im);
    let aud = 0;
    let all = 0;
    for (let k = 1; k < N / 2; k++) {
      const p = re[k] ** 2 + im[k] ** 2;
      all += p;
      if ((k * FS) / N < 16000) aud += p;
    }
    expect(10 * Math.log10(aud / all + 1e-30)).toBeLessThan(-100);
  });
  it('band plans for multiple phones do not overlap and stay below Nyquist', () => {
    for (const count of [1, 2, 3]) {
      const plan = bandPlan(count);
      expect(plan.length).toBe(count);
      for (let i = 1; i < plan.length; i++) expect(plan[i].f0).toBeGreaterThan(plan[i - 1].f1);
      for (const b of plan) expect(() => designChirp(48000, 1024, b)).not.toThrow();
    }
    expect(() => designChirp(44100, 1024, WIDE_BAND)).not.toThrow();
  });
});

function profileOf(mf: MatchedFilter, sig: (t: number) => number, n: number): number[] {
  const x = new Float64Array(2 * n);
  for (let i = 0; i < 2 * n; i++) x[i] = sig(i / FS);
  const re = new Float64Array(n);
  const im = new Float64Array(n);
  mf.process(x.subarray(0, n), re, im);
  mf.process(x.subarray(n), re, im);
  return Array.from(re, (v, i) => Math.hypot(v, im[i]));
}

describe('matched filter', () => {
  const d = designChirp(FS, 1024, WIDE_BAND);
  const mf = new MatchedFilter(d);
  const n = d.n;
  it('resolves a static echo at the right lag with low sidelobes', () => {
    const range = 1.5;
    const mag = profileOf(mf, (t) => d.valueAt(t - (2 * range) / C), n);
    const pk = mag.indexOf(Math.max(...mag));
    const expected = ((2 * range) / C) * FS;
    expect(Math.abs(pk - expected)).toBeLessThanOrEqual(1);
    let worst = -200;
    for (let j = 0; j < n; j++) {
      const dd = Math.min(Math.abs(j - pk), n - Math.abs(j - pk));
      if (dd > 3 * mf.psfHalfWidth) worst = Math.max(worst, 20 * Math.log10(mag[j] / mag[pk]));
    }
    expect(worst).toBeLessThan(-30);
  });
  it('keeps sidelobes low for a walking-speed target', () => {
    for (const v of [0.5, 1.2]) {
      const mag = profileOf(mf, (t) => d.valueAt(t - (2 * (1.5 - v * t)) / C), n);
      const pk = mag.indexOf(Math.max(...mag));
      let worst = -200;
      for (let j = 0; j < n; j++) {
        const dd = Math.min(Math.abs(j - pk), n - Math.abs(j - pk));
        if (dd > 3 * mf.psfHalfWidth) worst = Math.max(worst, 20 * Math.log10(mag[j] / mag[pk]));
      }
      expect(worst).toBeLessThan(-28);
    }
  });
  it('ignores loud audible sound completely', () => {
    const mag = profileOf(mf, (t) => 0.8 * Math.sin(2 * Math.PI * 440 * t) + 0.5 * Math.sin(2 * Math.PI * 3000 * t), n);
    expect(Math.max(...mag)).toBeLessThan(1e-4); // -80 dB re direct path
  });
});

describe('sonar on a simulated room', () => {
  it('tracks a person walking in, within 0.25 m', () => {
    const { frames, body } = simulate({
      name: 'walk',
      segments: [
        { kind: 'absent', dur: 4 },
        { kind: 'walk', dur: 3.5, from: [3.0, 0.4], to: [0.9, 0.1], footsteps: false },
        { kind: 'stand', dur: 3, at: [0.9, 0.1] },
      ],
    });
    const errs: number[] = [];
    for (const f of frames) {
      if (f.t < 4.6 || f.t > 7.4 || !f.primary || f.interference) continue;
      // The profile describes the previous frame.
      const tr = body.truth(f.t - 1024 / FS);
      const chest = Math.hypot(Math.hypot(tr.pos[0], tr.pos[1]) - 0.12, 1.35 - 0.75);
      errs.push(Math.abs(f.primary.range - chest));
    }
    errs.sort((a, b) => a - b);
    expect(errs.length).toBeGreaterThan(80);
    expect(errs[errs.length >> 1]).toBeLessThan(0.25);
  }, 60000);

  it('measures breathing rate contactlessly (seated, 0.9 m)', () => {
    const { frames } = simulate({
      name: 'sit',
      segments: [
        { kind: 'absent', dur: 3.5 },
        { kind: 'sit', dur: 32, at: [1.0, 0.2], bpm: 15 },
      ],
    });
    const last = frames[frames.length - 1].breathing;
    expect(last.valid).toBe(true);
    expect(Math.abs(last.rateBpm - 15)).toBeLessThan(1.5);
    expect(Math.abs(last.range - 0.9)).toBeLessThan(0.25);
  }, 60000);

  it('measures breathing rate at 2 m standing', () => {
    const { frames } = simulate({
      name: 'stand',
      segments: [
        { kind: 'absent', dur: 3.5 },
        { kind: 'stand', dur: 34, at: [2.0, 0], bpm: 11 },
      ],
    });
    const last = frames[frames.length - 1].breathing;
    expect(last.valid).toBe(true);
    expect(Math.abs(last.rateBpm - 11)).toBeLessThan(1.5);
  }, 60000);

  it('stays quiet in an empty room with loud audible noise', () => {
    const { frames } = simulate(
      { name: 'empty', segments: [{ kind: 'absent', dur: 20 }], sounds: [{ t: 2, kind: 'speech', dur: 6, level: 0.1 }, { t: 9, kind: 'thud' }, { t: 12, kind: 'keys' }] },
      { room: { ambientNoise: 5e-3 } },
    );
    const running = frames.filter((f) => f.phase === 'running');
    const confirmed = running.filter((f) => f.primary && f.primary.confirmed && f.primary.snrDb > 15);
    expect(confirmed.length / running.length).toBeLessThan(0.01);
    expect(running.filter((f) => f.breathing.valid).length).toBe(0);
  }, 60000);

  it('relocks after dropped audio blocks', () => {
    const { frames } = simulate(
      {
        name: 'dropout',
        segments: [
          { kind: 'absent', dur: 4 },
          { kind: 'stand', dur: 14, at: [1.5, 0], bpm: 14 },
        ],
      },
      { room: { dropouts: [{ t: 8.3, samples: 337 }] } },
    );
    expect(frames.some((f) => f.realigned && f.t > 8)).toBe(true);
    const tail = frames.filter((f) => f.t > 12);
    expect(tail.every((f) => f.locked)).toBe(true);
    expect(tail.some((f) => f.primary !== null || f.breathing.valid || f.motionDb > 10)).toBe(true);
  }, 60000);

  it('is not disturbed by another phone transmitting in its own band', () => {
    const [bandA, bandB] = bandPlan(2);
    const sonar = new SonarProcessor({ fs: FS, band: bandA });
    const other = designChirp(FS, sonar.n, bandB);
    const { frames } = simulate(
      { name: 'empty2', segments: [{ kind: 'absent', dur: 14 }] },
      { sonar, room: { others: [{ design: other, distance: 2.5, amp: 0.02 }] } },
    );
    const running = frames.filter((f) => f.phase === 'running');
    expect(running.length).toBeGreaterThan(300);
    expect(running.filter((f) => f.detections.length > 0).length / running.length).toBeLessThan(0.02);
  }, 60000);

  it('keeps working when a second phone starts transmitting after calibration', () => {
    const [bandA, bandB] = bandPlan(2);
    const sonar = new SonarProcessor({ fs: FS, band: bandB });
    const other = designChirp(FS, sonar.n, bandA);
    const { frames } = simulate(
      {
        name: 'late-joiner',
        segments: [
          { kind: 'absent', dur: 6 },
          { kind: 'walk', dur: 3, from: [2.6, 0], to: [1.2, 0], footsteps: false },
          { kind: 'stand', dur: 6, at: [1.2, 0] },
        ],
      },
      // Starts while this phone is still learning the room (worst case).
      { sonar, room: { others: [{ design: other, distance: 1.5, amp: 0.03, startAt: 2.5 }] } },
    );
    const late = frames.filter((f) => f.t > 5);
    expect(late.every((f) => f.phase === 'running')).toBe(true);
    expect(late.filter((f) => f.interference).length / late.length).toBeLessThan(0.05);
    expect(frames.filter((f) => f.t > 7 && f.t < 9).some((f) => f.primary !== null)).toBe(true);
  }, 60000);

  it('works in the lower fallback band used for laptops', () => {
    expect(() => designChirp(44100, 1024, LOW_BAND)).not.toThrow();
    const sonar = new SonarProcessor({ fs: FS, band: LOW_BAND });
    const { frames } = simulate(
      {
        name: 'low-band',
        segments: [
          { kind: 'absent', dur: 4 },
          { kind: 'walk', dur: 3, from: [2.6, 0], to: [1.2, 0], footsteps: false },
          { kind: 'stand', dur: 3, at: [1.2, 0] },
        ],
      },
      { sonar },
    );
    expect(frames.filter((f) => f.t > 5 && f.t < 7.5).some((f) => f.primary !== null && f.primary.confirmed)).toBe(true);
  }, 60000);

  it('estimates range-Doppler with the right sign for a slowly approaching target', () => {
    // Unambiguous Doppler is +/- lambda*fps/4 (about 0.2 m/s), so test a slow approach.
    const { sonar } = simulate({
      name: 'approach',
      segments: [
        { kind: 'absent', dur: 4 },
        { kind: 'walk', dur: 5, from: [2.2, 0], to: [1.6, 0], footsteps: false },
      ],
    });
    const rd = sonar.rangeDoppler();
    expect(rd).not.toBeNull();
    // Energy-weighted mean velocity over the map should be negative (approaching).
    let wsum = 0;
    let vsum = 0;
    const M = rd!.dopplerBins;
    for (let c = 0; c < rd!.cells; c++) {
      for (let j = 0; j < M; j++) {
        if (j === M / 2) continue;
        const w = 10 ** (rd!.db[c * M + j] / 10);
        wsum += w;
        vsum += w * rd!.velocities[j];
      }
    }
    expect(vsum / wsum).toBeLessThan(0);
  }, 60000);
});
