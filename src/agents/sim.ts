import { Rng } from '../sim/random';
import type { SoundGroup } from '../audio/soundLabels';
import type { HomeMap } from './cartographer';
import type { AlertObs, SoundObs, StreamSample } from './types';

/**
 * Evidence level simulator for the agent layer.
 *
 * It produces exactly what the hub receives from real phones (telemetry
 * samples, classified sound events, on-device alerts) for a home with three
 * phones, so the agents and the baselines run on the same code path as live.
 * The raw signal processing (sonar, audio classifier) is validated separately
 * against a physical acoustic simulation in test/; here the inputs are the
 * phones' outputs, with realistic noise, misses and misclassifications.
 *
 * Physics kept on purpose: sound falls off 6 dB per doubling of distance,
 * sonar only sees within about 3 m and not through furniture, a phone that
 * moves sees its own room echo change, and each phone's on-device verdict is
 * computed by the same rule the phone app uses.
 */

export type PState = 'walk' | 'still' | 'sit' | 'floor';
export type EventKind = 'fall' | 'collapse' | 'flinch' | 'sit' | 'bend' | 'none';

export interface SimPhone {
  nodeId: string;
  name: string;
  x: number;
  y: number;
  imu: boolean;
  occluded?: boolean;
  compromised?: 'fake_fall' | 'hide';
}

export interface SoundSpec {
  at: number;
  from: 'person' | 'media' | { phone: number } | [number, number];
  level: number;
  cls: SoundObs['cls'];
  repetitive?: boolean;
  prob?: number;
  /** What the phone's sound model calls it, and how often it gets it right. */
  ai?: { group: SoundGroup; p: number };
}

export interface ScenarioSpec {
  key: string;
  title: string;
  description: string;
  emergency: boolean;
  person: {
    from: [number, number];
    to: [number, number];
    at: [number, number];
    before: PState;
    after: PState;
    event: EventKind;
    /** Probability the event motion actually happens (e.g. a flinch). */
    eventProb?: number;
    /** Probability the person walks away a few seconds after the event. */
    resumeProb?: number;
  };
  sounds: SoundSpec[];
  media?: [number, number];
  knock?: number;
  occluded?: number[];
  /** Area no phone can see into (hallway, another room): x0, y0, x1, y1. */
  outOfView?: [number, number, number, number];
  compromised?: { phone: number; kind: 'fake_fall' | 'hide' };
  screamProb?: number;
  /** Written after the agents were tuned and never used to adjust them. */
  heldOut?: boolean;
}

export const ROOM = { w: 5, d: 4 };
export const LAYOUT: SimPhone[] = [
  { nodeId: 'sim-1', name: 'Phone 1', x: 0.4, y: 0.4, imu: true },
  { nodeId: 'sim-2', name: 'Phone 2', x: 4.6, y: 0.4, imu: true },
  { nodeId: 'sim-3', name: 'Phone 3', x: 2.5, y: 3.6, imu: true },
];

export const T0 = 100000;
const START = T0 - 14000;
const END = T0 + 16000;
const DT = 125;
const SEE_M = 3.0;

export const SCENARIOS: ScenarioSpec[] = [
  {
    key: 'fall_center',
    title: 'Fall in the middle of the room',
    description: 'Walking, trips and falls; every phone can see.',
    emergency: true,
    person: { from: [1.6, 1.2], to: [2.4, 1.9], at: [2.7, 2.4], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 38, cls: 'impact', ai: { group: 'thud', p: 0.75 } }],
    screamProb: 0.2,
  },
  {
    key: 'fall_corner',
    title: 'Fall seen by one phone',
    description: 'Falls in a corner; only Phone 1 has a view, the others only hear it.',
    emergency: true,
    person: { from: [1.4, 0.9], to: [1.0, 1.0], at: [0.9, 1.5], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 38, cls: 'impact', ai: { group: 'thud', p: 0.75 } }],
    occluded: [2],
  },
  {
    key: 'tv_thud',
    title: 'Action movie on TV',
    description: 'Seated on the couch; the TV plays a loud crash and they flinch.',
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'flinch', eventProb: 0.7 },
    sounds: [{ at: 0, from: 'media', level: 41, cls: 'impact', ai: { group: 'media', p: 0.6 } }],
    media: [4.7, 0.9],
  },
  {
    key: 'phone_knocked',
    title: 'Phone knocked off the table',
    description: 'Walking past, they knock Phone 1 to the floor and keep going.',
    emergency: false,
    person: { from: [0.6, 1.8], to: [1.0, 1.2], at: [1.2, 1.4], before: 'walk', after: 'walk', event: 'none' },
    sounds: [{ at: 120, from: { phone: 0 }, level: 33, cls: 'impact', ai: { group: 'object', p: 0.6 } }],
    knock: 0,
  },
  {
    key: 'dropped_pan',
    title: 'Dropped a pan',
    description: 'Drops something heavy, bends to pick it up, usually walks on.',
    emergency: false,
    person: { from: [1.4, 1.2], to: [2.0, 1.6], at: [2.05, 1.6], before: 'walk', after: 'still', event: 'bend', resumeProb: 0.6 },
    sounds: [{ at: 0, from: 'person', level: 36, cls: 'impact', ai: { group: 'object', p: 0.75 } }],
  },
  {
    key: 'sat_down',
    title: 'Flopped onto the couch',
    description: 'Walks over and drops onto the couch. No bang.',
    emergency: false,
    person: { from: [2.6, 1.0], to: [1.6, 2.2], at: [1.5, 2.4], before: 'walk', after: 'sit', event: 'sit' },
    sounds: [],
  },
  {
    key: 'soft_collapse',
    title: 'Quiet collapse',
    description: 'Slumps to the floor slowly. No loud impact at all.',
    emergency: true,
    person: { from: [1.6, 1.0], to: [2.2, 1.6], at: [2.4, 2.2], before: 'walk', after: 'floor', event: 'collapse' },
    sounds: [{ at: 600, from: 'person', level: 16, cls: 'impact', ai: { group: 'thud', p: 0.5 }, prob: 0.3 }],
  },
  {
    key: 'fake_fall',
    title: 'Hacked phone fakes a fall',
    description: 'Phone 2 is compromised and reports a fall while they walk around.',
    emergency: false,
    person: { from: [1.0, 1.4], to: [2.2, 2.2], at: [2.4, 2.3], before: 'walk', after: 'walk', event: 'none' },
    sounds: [],
    compromised: { phone: 1, kind: 'fake_fall' },
  },
  {
    key: 'hidden_fall',
    title: 'Hacked phone hides a fall',
    description: 'A real fall seen by Phone 1; compromised Phone 2 says all is well; Phone 3 is blocked.',
    emergency: true,
    person: { from: [1.6, 1.0], to: [1.1, 1.4], at: [1.0, 1.9], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 38, cls: 'impact', ai: { group: 'thud', p: 0.75 } }],
    occluded: [2],
    compromised: { phone: 1, kind: 'hide' },
  },
  {
    key: 'fall_tv_on',
    title: 'Real fall while the TV is on',
    description: 'Gets up from the couch during a loud movie and falls.',
    emergency: true,
    person: { from: [1.3, 2.6], to: [1.6, 2.3], at: [2.1, 1.9], before: 'sit', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 36, cls: 'impact', ai: { group: 'thud', p: 0.7 } }],
    media: [4.7, 0.9],
    heldOut: true,
  },
  {
    key: 'fall_hallway',
    title: 'Fall out of every phone\'s view',
    description: 'Falls in the hallway; no sonar can see, every phone hears it.',
    emergency: true,
    person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 38, cls: 'impact', ai: { group: 'thud', p: 0.75 } }],
    outOfView: [4.1, 3.1, 5, 4],
    heldOut: true,
  },
  {
    key: 'door_slam',
    title: 'Door slams while walking',
    description: 'A door slams in the next room while they walk around.',
    emergency: false,
    person: { from: [1.0, 1.2], to: [2.2, 2.0], at: [2.4, 2.2], before: 'walk', after: 'walk', event: 'none' },
    sounds: [{ at: 0, from: [4.9, 3.9], level: 40, cls: 'impact', ai: { group: 'object', p: 0.75 } }],
    heldOut: true,
  },
  {
    key: 'snap_near_phone',
    title: 'Finger snap next to a phone',
    description: 'Sitting quietly; snaps their fingers right next to Phone 1.',
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'none' },
    sounds: [{ at: 0, from: { phone: 0 }, level: 18, cls: 'impact', ai: { group: 'tap', p: 0.85 } }],
  },
  {
    key: 'tap_unseen',
    title: 'Tap on the desk, nobody in view',
    description: 'At a desk out of every sonar view (like the laptop test), taps the desk, then sits silently.',
    emergency: false,
    person: { from: [4.6, 3.6], to: [4.6, 3.6], at: [4.6, 3.6], before: 'sit', after: 'sit', event: 'none' },
    sounds: [{ at: 0, from: 'person', level: 30, cls: 'impact', ai: { group: 'tap', p: 0.8 } }],
    outOfView: [4.1, 3.1, 5, 4],
  },
];

export interface PhoneStream {
  phone: SimPhone;
  samples: StreamSample[];
  sounds: SoundObs[];
  alerts: AlertObs[];
}

export interface GeneratedTrial {
  spec: ScenarioSpec;
  phones: SimPhone[];
  streams: PhoneStream[];
}

const lerp = (a: [number, number], b: [number, number], u: number): [number, number] => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
const clampRoom = (p: [number, number]): [number, number] => [Math.max(0.2, Math.min(ROOM.w - 0.2, p[0])), Math.max(0.2, Math.min(ROOM.d - 0.2, p[1]))];

export function generate(spec: ScenarioSpec, seed: number, layout: SimPhone[] = LAYOUT): GeneratedTrial {
  const rng = new Rng(seed * 7919 + spec.key.length * 104729);
  const j = (v: number, s: number) => v + rng.uniform(-s, s);
  const phones: SimPhone[] = layout.map((p, i) => ({
    ...p,
    x: j(p.x, 0.2),
    y: j(p.y, 0.2),
    imu: i === spec.knock ? rng.next() < 0.5 : p.imu,
    occluded: spec.occluded?.includes(i) ?? false,
    compromised: spec.compromised?.phone === i ? spec.compromised.kind : undefined,
  }));
  const P = spec.person;
  const from = clampRoom([j(P.from[0], 0.3), j(P.from[1], 0.3)]);
  const to = clampRoom([j(P.to[0], 0.3), j(P.to[1], 0.3)]);
  const at = clampRoom([to[0] + (P.at[0] - P.to[0]) * rng.uniform(0.7, 1.3), to[1] + (P.at[1] - P.to[1]) * rng.uniform(0.7, 1.3)]);
  const eventHappens = rng.next() < (P.eventProb ?? 1);
  const resumes = rng.next() < (P.resumeProb ?? (P.after === 'walk' ? 1 : 0));
  const resumeAt = T0 + rng.uniform(2500, 4500);
  const walkDir: [number, number] = [rng.uniform(-1, 1), rng.uniform(-1, 1)];
  const media = spec.media ? ([j(spec.media[0], 0.2), j(spec.media[1], 0.2)] as [number, number]) : null;
  // The sound model is running on the phones in most trials (it can fail to load).
  const aiOn = rng.next() < 0.85;
  const hidden = (p: [number, number]) => !!spec.outOfView && p[0] >= spec.outOfView[0] && p[1] >= spec.outOfView[1] && p[0] <= spec.outOfView[2] && p[1] <= spec.outOfView[3];

  type Phase = { pos: [number, number]; state: PState | 'event' };
  const personAt = (t: number): Phase => {
    if (t < T0 - 300) {
      if (P.before === 'walk') return { pos: lerp(from, to, (t - START) / (T0 - 300 - START)), state: 'walk' };
      return { pos: to, state: P.before };
    }
    if (t < T0 + 1200) {
      const ev = eventHappens ? P.event : 'none';
      if (ev === 'none' || (ev === 'flinch' && t > T0 + 500)) {
        const st = P.before;
        return { pos: st === 'walk' ? lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6000) : to, state: st };
      }
      return { pos: lerp(to, at, Math.max(0, Math.min(1, (t - T0 + 300) / 1300))), state: 'event' };
    }
    const settled: PState = eventHappens ? P.after : P.before;
    if (resumes && t >= resumeAt) {
      const base = P.event === 'none' && P.before === 'walk' ? to : at;
      return { pos: lerp(base, clampRoom([base[0] + walkDir[0] * 2, base[1] + walkDir[1] * 2]), (t - resumeAt) / 8000), state: 'walk' };
    }
    if (P.event === 'none' && P.before === 'walk') {
      return { pos: lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6000), state: 'walk' };
    }
    return { pos: eventHappens ? at : to, state: settled };
  };
  // People who are awake shift around every few seconds; someone on the floor after a fall does not.
  const fidgets: [number, number][] = [];
  for (let t = START + rng.uniform(0, 6000); t < END; t += rng.uniform(4000, 13000)) fidgets.push([t, t + rng.uniform(400, 800)]);
  const fidgeting = (t: number) => fidgets.some(([a, b]) => t >= a && t <= b);
  const height = (s: PState | 'event') => (s === 'floor' ? 0.25 : s === 'sit' ? 1.0 : s === 'event' ? 0.7 : 1.25);

  const streams: PhoneStream[] = phones.map((ph, idx) => {
    const samples: StreamSample[] = [];
    const sonarMiss = rng.next() < 0.08;
    const breathes = rng.next() < 0.6;
    let stillSince = -1;
    const knocked = spec.knock === idx;
    const link = rng.uniform(18, 28);
    for (let t = START; t <= END; t += DT) {
      const { pos, state } = personAt(t);
      const d = Math.hypot(pos[0] - ph.x, pos[1] - ph.y);
      const sees = !ph.occluded && !sonarMiss && d <= SEE_M && !hidden(pos);
      let fast: number;
      let motion: number;
      let presence = 'empty';
      let range: number | null = null;
      let confirmed = false;
      let breathing: StreamSample['breathing'] = null;
      let sonarOk = true;
      let staticChangeDb = rng.uniform(0, 4);
      let linkSnrDb = link + rng.uniform(-1.5, 1.5);
      if (sees) {
        const ev = eventHappens ? P.event : 'none';
        if (state === 'walk') [fast, motion, presence] = [rng.uniform(13, 19), rng.uniform(18, 26), 'moving'];
        else if (state === 'event') {
          const burst = ev === 'fall' ? [24, 32] : ev === 'collapse' ? [16, 22] : ev === 'flinch' ? [19, 24] : ev === 'sit' ? [20, 25] : [17, 22];
          [fast, motion, presence] = [rng.uniform(burst[0], burst[1]), rng.uniform(20, 30), 'moving'];
        } else if (state !== 'floor' && fidgeting(t)) [fast, motion, presence] = [rng.uniform(14, 18), rng.uniform(15, 20), 'moving'];
        else [fast, motion, presence] = [rng.uniform(1, state === 'floor' ? 6 : 9), rng.uniform(8, 13), 'still'];
        range = Math.hypot(d, height(state) - 0.75) + rng.gauss() * 0.04;
        confirmed = rng.next() < (state === 'walk' || state === 'event' ? 0.95 : state === 'floor' ? 0.65 : 0.8);
        if (state === 'still' || state === 'sit' || state === 'floor') {
          if (stillSince < 0) stillSince = t;
          if (breathes && t - stillSince > 10000 && rng.next() < 0.9) breathing = { rateBpm: 14 + rng.gauss(), quality: rng.uniform(0.5, 0.8), range };
        } else stillSince = -1;
      } else {
        [fast, motion] = [rng.uniform(0, 4), rng.uniform(2, 7)];
        stillSince = -1;
      }
      if (knocked && t >= T0) {
        if (ph.imu) {
          sonarOk = false;
          presence = 'unknown';
          range = null;
          confirmed = false;
          fast = 0;
          breathing = null;
        } else {
          // Motion sensor permission off: the sonar keeps running on the floor.
          fast = t < T0 + 500 ? rng.uniform(32, 38) : rng.uniform(0, 5);
          staticChangeDb = rng.uniform(18, 26);
          linkSnrDb = rng.uniform(12, 20);
          presence = t < T0 + 500 ? 'moving' : 'empty';
          range = null;
          confirmed = false;
          breathing = null;
        }
      }
      const mediaShare = aiOn ? (media ? rng.uniform(0.45, 0.95) : rng.uniform(0, 0.1)) : undefined;
      samples.push({ t, presence, range, confirmed, snrDb: confirmed ? rng.uniform(16, 26) : 0, fastMotionDb: fast, motionDb: motion, staticChangeDb, linkSnrDb, breathing, sonarOk, media: mediaShare });
    }

    const sounds: SoundObs[] = [];
    const hear = (sx: number, sy: number, level: number, at: number, cls: SoundObs['cls'], repetitive = false, ai?: { group: SoundGroup; p: number }) => {
      const d = Math.hypot(sx - ph.x, sy - ph.y);
      const lvl = level + rng.gauss() * 2 - 20 * Math.log10(Math.max(d, 0.3));
      if (lvl < 6) return;
      let c = cls;
      if (cls === 'impact' && rng.next() < 0.12) c = 'knock';
      const ev: SoundObs = { t: at + rng.uniform(150, 600), cls: c, confidence: rng.uniform(0.55, 0.9), aboveFloorDb: lvl, repetitive };
      if (aiOn && ai) {
        // Right most of the time; otherwise a plausible confusion with a lower score.
        const right = rng.next() < ai.p;
        const wrong: SoundGroup[] = (['thud', 'object', 'tap'] as SoundGroup[]).filter((g) => g !== ai.group);
        const group = right ? ai.group : wrong[Math.floor(rng.next() * wrong.length)];
        const score = right ? rng.uniform(0.35, 0.85) : rng.uniform(0.15, 0.4);
        ev.ai = { group, score, top: [{ name: group, score }] };
        ev.benign = c !== 'scream' && score >= 0.35 && lvl < 30 && ['tap', 'speech', 'media', 'footsteps', 'object'].includes(group);
      }
      sounds.push(ev);
    };
    if (media) {
      for (let t = START; t < END; t += rng.uniform(800, 1400)) hear(media[0], media[1], 26, t, rng.next() < 0.6 ? 'voice' : 'sustained', rng.next() < 0.2, { group: 'media', p: 0.8 });
    }
    for (const s of spec.sounds) {
      if (s.prob !== undefined && rng.next() >= s.prob) continue;
      let src: [number, number];
      if (s.from === 'person') src = personAt(T0 + s.at).pos;
      else if (s.from === 'media') src = media ?? [0, 0];
      else if (Array.isArray(s.from)) src = s.from;
      else src = [phones[s.from.phone].x, phones[s.from.phone].y + 0.15];
      hear(src[0], src[1], s.level + rng.uniform(-3, 3), T0 + s.at, s.cls, s.repetitive, s.ai);
    }
    if (spec.screamProb && eventHappens && seededChance(seed, spec.screamProb)) {
      const p = personAt(T0 + 400).pos;
      hear(p[0], p[1], 40, T0 + 400, 'scream', false, { group: 'distress', p: 0.85 });
    }
    sounds.sort((a, b) => a.t - b.t);

    const alerts: AlertObs[] = [];
    if (knocked && ph.imu) alerts.push({ t: T0 + 250, kind: 'phone_drop', severity: 'warning', title: 'Phone dropped' });
    return { phone: ph, samples, sounds, alerts };
  });

  // Compromised phones rewrite their own stream before anyone sees it.
  for (const s of streams) {
    if (s.phone.compromised === 'fake_fall') fabricateFall(s, rng);
    else if (s.phone.compromised === 'hide') fabricateCalm(s, rng);
  }
  for (const s of streams) s.alerts.push(...localVerdicts(s), ...[]);
  for (const s of streams) s.alerts.sort((a, b) => a.t - b.t);
  return { spec, phones, streams };
}

function seededChance(seed: number, p: number): boolean {
  return new Rng(seed * 31 + 7).next() < p;
}

/** A compromised phone claiming it watched a fall: internally consistent, but invented. */
export function fabricateFall(s: PhoneStream, rng: Rng, t0 = T0): void {
  const r0 = rng.uniform(1.2, 1.8);
  for (const x of s.samples) {
    const t = x.t;
    x.sonarOk = true;
    x.staticChangeDb = rng.uniform(0, 4);
    if (t < t0 - 300) Object.assign(x, { presence: 'moving', range: r0 + rng.gauss() * 0.05, confirmed: true, fastMotionDb: rng.uniform(13, 18), motionDb: rng.uniform(18, 24), breathing: null });
    else if (t < t0 + 1200) Object.assign(x, { presence: 'moving', range: r0 + 0.4, confirmed: true, fastMotionDb: rng.uniform(26, 31), motionDb: 28 });
    else Object.assign(x, { presence: 'still', range: r0 + 0.6, confirmed: true, fastMotionDb: rng.uniform(1, 5), motionDb: rng.uniform(8, 12) });
  }
  s.sounds = s.sounds.filter((e) => e.t < t0 - 3000 || e.t > t0 + 3000);
  s.sounds.push({ t: t0 + 300, cls: 'impact', confidence: 0.85, aboveFloorDb: rng.uniform(28, 34), repetitive: false });
  s.sounds.sort((a, b) => a.t - b.t);
}

/** A compromised phone hiding an incident: claims normal walking and silence. */
export function fabricateCalm(s: PhoneStream, rng: Rng): void {
  const r0 = rng.uniform(1.5, 2.2);
  for (const x of s.samples) {
    Object.assign(x, { sonarOk: true, presence: 'moving', range: r0 + rng.gauss() * 0.1, confirmed: true, fastMotionDb: rng.uniform(13, 17), motionDb: rng.uniform(18, 24), breathing: null });
  }
  s.sounds = [];
  s.alerts = [];
}

/**
 * The phone's own on-device fall rule (same logic as FusionEngine.decide):
 * a burst and an impact followed by stillness is a fall; an impact followed by
 * stillness when the sonar could not see anyone is a possible fall.
 */
export function localVerdicts(s: PhoneStream): AlertObs[] {
  const out: AlertObs[] = [];
  const impacts = s.sounds.filter((e) => e.cls === 'impact' && !e.repetitive && !e.benign && e.confidence >= 0.55);
  let lastFall = -1e12;
  let lastSeen = -1e12;
  const seen = s.samples.filter((x) => x.sonarOk && ((x.confirmed && x.snrDb >= 15) || x.motionDb >= 16 || x.breathing));
  const bursts = s.samples.filter((x) => x.sonarOk && x.fastMotionDb >= 20).map((x) => x.t);
  const anchors = [...impacts.map((e) => e.t), ...bursts].sort((a, b) => a - b);
  let lastAnchor = -1e12;
  for (const t0 of anchors) {
    if (t0 - lastAnchor < 3000) continue;
    lastAnchor = t0;
    const sound = impacts.find((e) => Math.abs(e.t - t0) <= 2000);
    const around = s.samples.filter((x) => x.t >= t0 - 2000 && x.t <= t0 + 1500 && x.sonarOk);
    const after = s.samples.filter((x) => x.t > t0 + 1500 && x.t <= t0 + 6000 && x.sonarOk);
    const sonarOk = around.length > 10;
    const burst = around.reduce((m, x) => Math.max(m, x.fastMotionDb), 0);
    const still = sonarOk && after.length > 10 && after.filter((x) => x.fastMotionDb < 12).length / after.length >= 0.85;
    const presentBefore = around.filter((x) => x.t < t0 - 200 && ((x.confirmed && x.snrDb >= 15) || x.motionDb >= 16)).length > 5;
    for (const x of seen) if (x.t < t0) lastSeen = Math.max(lastSeen, x.t);
    const decideAt = t0 + 6000;
    if (decideAt - lastFall < 30000) continue;
    if (sonarOk && burst >= 20 && sound && still) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: 'fall', severity: 'critical', title: 'Possible fall' });
    } else if (
      sound &&
      still &&
      sound.confidence >= 0.7 &&
      !(sonarOk && presentBefore) &&
      t0 - lastSeen < 90000 &&
      (sound.ai ? sound.ai.group === 'thud' || sound.ai.group === 'distress' : sound.confidence >= 0.85 && sound.aboveFloorDb >= 28)
    ) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: 'fall', severity: 'warning', title: 'Loud impact, then no movement' });
    }
  }
  return out;
}

/** The home in the simulator, taught to the Cartographer once: the TV, the sofa, the kitchen counter. */
export const SIM_PLACES: { name: string; kind: 'tv' | 'sofa' | 'kitchen'; at: [number, number]; h: number }[] = [
  { name: 'TV', kind: 'tv', at: [4.7, 0.9], h: 1.25 },
  { name: 'sofa', kind: 'sofa', at: [1.3, 2.6], h: 1.0 },
  { name: 'kitchen counter', kind: 'kitchen', at: [0.7, 1.4], h: 1.25 },
];

/** Marking a place: stand there, and every phone that can see you records the distance (with sonar noise). */
export function simHomeMap(trial: GeneratedTrial): HomeMap {
  const rng = new Rng(trial.phones.length * 977 + 13);
  const map: HomeMap = { phones: {}, places: [], resting: {} };
  for (const p of SIM_PLACES) {
    const ranges: Record<string, number> = {};
    for (const ph of trial.phones) {
      const d = Math.hypot(p.at[0] - ph.x, p.at[1] - ph.y);
      if (d <= SEE_M) ranges[ph.nodeId] = Math.hypot(d, p.h - 0.75) + rng.gauss() * 0.05;
    }
    map.places.push({ id: p.name, name: p.name, kind: p.kind, ranges, createdAt: 0 });
  }
  // Phone 2 sits on the TV stand.
  if (trial.phones[1]) map.phones[trial.phones[1].nodeId] = { label: 'by the TV', near: 'tv' };
  return map;
}
