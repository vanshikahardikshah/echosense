import { Rng } from './random';
import { SoundEvent } from './sounds';

export type Vec2 = [number, number];
export type Vec3 = [number, number, number];

export interface Reflector {
  p: Vec3;
  /** Echo amplitude at 1 m relative to the direct path (falls off as 1/r^2). */
  amp: number;
}

export type Segment =
  | { kind: 'absent'; dur: number }
  | { kind: 'walk'; dur: number; from: Vec2; to: Vec2; footsteps?: boolean }
  | { kind: 'stand'; dur: number; at: Vec2; bpm?: number }
  | { kind: 'fidget'; dur: number; at: Vec2; bpm?: number }
  | { kind: 'sit'; dur: number; at: Vec2; bpm?: number }
  | { kind: 'fall'; dur: number; at: Vec2; dir?: Vec2; bpm?: number; thud?: boolean }
  | { kind: 'lie'; dur: number; at: Vec2; dir?: Vec2; bpm?: number };

export interface Scenario {
  name: string;
  segments: Segment[];
  sounds?: SoundEvent[];
  /** Ground truth annotations for evaluation. */
  truth?: { t: number; label: string }[];
}

export interface GroundTruth {
  present: boolean;
  /** Horizontal position of the torso. */
  pos: Vec2;
  torsoZ: number;
  posture: 'none' | 'walking' | 'standing' | 'sitting' | 'falling' | 'lying';
  breathingBpm: number;
}

// Echo amplitudes at 1 m, at the microphone, with the direct path at 0.25.
const TORSO_AMP = 0.004;
const HEAD_AMP = 0.0012;
const LIMB_AMP = 0.0008;
const LEG_AMP = 0.0012;

function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]];
}
function norm2(a: Vec2): Vec2 {
  const m = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / m, a[1] / m];
}

/**
 * Kinematic human model built from a few point scatterers (chest, head, arms,
 * legs), with gait, breathing and falls. Positions are metres in the room
 * frame; z is height above the floor.
 */
export class BodyModel {
  private readonly starts: number[] = [];
  readonly duration: number;
  private readonly breathJitter: number;

  constructor(
    readonly scenario: Scenario,
    private readonly phone: Vec3,
    seed = 7,
  ) {
    let t = 0;
    for (const s of scenario.segments) {
      this.starts.push(t);
      t += s.dur;
    }
    this.duration = t;
    this.breathJitter = new Rng(seed).uniform(0, 1000);
  }

  /** Footstep and fall sounds implied by the motion itself. */
  impliedSounds(): SoundEvent[] {
    const out: SoundEvent[] = [];
    this.scenario.segments.forEach((s, i) => {
      const t0 = this.starts[i];
      if (s.kind === 'walk' && s.footsteps !== false) {
        for (let t = t0 + 0.2; t < t0 + s.dur; t += 0.55) out.push({ t, kind: 'footstep' });
      }
      if (s.kind === 'fall' && s.thud !== false) out.push({ t: t0 + 0.72, kind: 'thud' });
    });
    return out;
  }

  private segmentAt(t: number): { seg: Segment; local: number; index: number } | null {
    for (let i = this.starts.length - 1; i >= 0; i--) {
      if (t >= this.starts[i]) {
        const seg = this.scenario.segments[i];
        if (t - this.starts[i] <= seg.dur) return { seg, local: t - this.starts[i], index: i };
        return null;
      }
    }
    return null;
  }

  private breath(t: number, bpm: number, amp: number): number {
    if (bpm <= 0) return 0;
    const f = bpm / 60;
    // Slight rate variability, with asymmetric inhale/exhale.
    const ph = 2 * Math.PI * f * t + 0.3 * Math.sin(2 * Math.PI * 0.05 * t + this.breathJitter);
    return amp * (Math.sin(ph) + 0.25 * Math.sin(2 * ph + 0.5));
  }

  truth(t: number): GroundTruth {
    const r = this.segmentAt(t);
    if (!r || r.seg.kind === 'absent') return { present: false, pos: [99, 99], torsoZ: 0, posture: 'none', breathingBpm: 0 };
    const s = r.seg;
    switch (s.kind) {
      case 'walk': {
        const a = r.local / s.dur;
        return {
          present: true,
          pos: [s.from[0] + (s.to[0] - s.from[0]) * a, s.from[1] + (s.to[1] - s.from[1]) * a],
          torsoZ: 1.25,
          posture: 'walking',
          breathingBpm: 18,
        };
      }
      case 'stand':
      case 'fidget':
        return { present: true, pos: s.at, torsoZ: 1.25, posture: 'standing', breathingBpm: s.bpm ?? 14 };
      case 'sit':
        return { present: true, pos: s.at, torsoZ: 0.8, posture: 'sitting', breathingBpm: s.bpm ?? 13 };
      case 'fall': {
        const dir = norm2(s.dir ?? s.at);
        const u = Math.min(1, r.local / 0.75);
        return {
          present: true,
          pos: [s.at[0] + dir[0] * 0.55 * u, s.at[1] + dir[1] * 0.55 * u],
          torsoZ: 1.25 - 1.05 * u * u,
          posture: u < 1 ? 'falling' : 'lying',
          breathingBpm: s.bpm ?? 20,
        };
      }
      case 'lie':
        return { present: true, pos: s.at, torsoZ: 0.2, posture: 'lying', breathingBpm: s.bpm ?? 16 };
    }
  }

  reflectors(t: number): Reflector[] {
    const r = this.segmentAt(t);
    if (!r || r.seg.kind === 'absent') return [];
    const s = r.seg;
    const phoneXY: Vec2 = [this.phone[0], this.phone[1]];
    const out: Reflector[] = [];
    const towardPhone = (p: Vec3): Vec3 => {
      const d: Vec3 = [this.phone[0] - p[0], this.phone[1] - p[1], this.phone[2] - p[2]];
      const m = Math.hypot(d[0], d[1], d[2]) || 1;
      return [d[0] / m, d[1] / m, d[2] / m];
    };

    const upright = (pos: Vec2, torsoZ: number, bpm: number, gaitPhase: number | null, fidget: boolean, heading: Vec2) => {
      const face = norm2(sub(phoneXY, pos));
      const side: Vec2 = [-heading[1], heading[0]];
      const chestBase: Vec3 = [pos[0] + face[0] * 0.12, pos[1] + face[1] * 0.12, torsoZ + 0.1];
      const tp = towardPhone(chestBase);
      const b = this.breath(t, bpm, 0.0025);
      out.push({ p: [chestBase[0] + tp[0] * b, chestBase[1] + tp[1] * b, chestBase[2] + tp[2] * b], amp: TORSO_AMP });
      out.push({ p: [pos[0], pos[1], torsoZ + 0.5], amp: HEAD_AMP });
      for (const sgn of [-1, 1]) {
        let swing = 0;
        if (gaitPhase !== null) swing = 0.22 * Math.sin(gaitPhase + (sgn > 0 ? 0 : Math.PI));
        if (fidget) swing = 0.18 * Math.sin(2 * Math.PI * 0.8 * t + (sgn > 0 ? 0 : 1.3));
        out.push({
          p: [pos[0] + side[0] * 0.24 * sgn + heading[0] * swing, pos[1] + side[1] * 0.24 * sgn + heading[1] * swing, torsoZ - 0.05],
          amp: LIMB_AMP,
        });
        if (torsoZ > 1.0) {
          const leg = gaitPhase !== null ? 0.28 * Math.sin(gaitPhase + (sgn > 0 ? Math.PI : 0)) : 0;
          out.push({
            p: [pos[0] + side[0] * 0.1 * sgn + heading[0] * leg, pos[1] + side[1] * 0.1 * sgn + heading[1] * leg, 0.5],
            amp: LEG_AMP,
          });
        } else {
          // Seated: thighs forward toward the phone, knees roughly at seat height.
          out.push({ p: [pos[0] + face[0] * 0.4 + side[0] * 0.1 * sgn, pos[1] + face[1] * 0.4 + side[1] * 0.1 * sgn, 0.55], amp: LEG_AMP });
        }
      }
    };

    const lying = (pos: Vec2, dirIn: Vec2, bpm: number) => {
      const dir = norm2(dirIn);
      const chest: Vec3 = [pos[0], pos[1], 0.22];
      const b = this.breath(t, bpm, 0.003);
      out.push({ p: [chest[0], chest[1], chest[2] + b], amp: TORSO_AMP * 1.2 });
      out.push({ p: [pos[0] + dir[0] * 0.55, pos[1] + dir[1] * 0.55, 0.12], amp: HEAD_AMP });
      out.push({ p: [pos[0] - dir[0] * 0.5, pos[1] - dir[1] * 0.5, 0.12], amp: LEG_AMP * 1.5 });
      out.push({ p: [pos[0] - dir[0] * 0.9, pos[1] - dir[1] * 0.9, 0.08], amp: LEG_AMP });
    };

    switch (s.kind) {
      case 'walk': {
        const a = r.local / s.dur;
        const pos: Vec2 = [s.from[0] + (s.to[0] - s.from[0]) * a, s.from[1] + (s.to[1] - s.from[1]) * a];
        const heading = norm2(sub(s.to, s.from));
        upright(pos, 1.25 + 0.02 * Math.sin(4 * Math.PI * 0.9 * r.local), 18, 2 * Math.PI * 0.9 * r.local, false, heading);
        break;
      }
      case 'stand':
        upright(s.at, 1.25, s.bpm ?? 14, null, false, norm2(sub(phoneXY, s.at)));
        break;
      case 'fidget':
        upright(s.at, 1.25, s.bpm ?? 14, null, true, norm2(sub(phoneXY, s.at)));
        break;
      case 'sit': {
        // 1.1 s sit-down transition.
        const u = Math.min(1, r.local / 1.1);
        const z = 1.25 - 0.45 * (0.5 - 0.5 * Math.cos(Math.PI * u));
        upright(s.at, z, s.bpm ?? 13, null, false, norm2(sub(phoneXY, s.at)));
        break;
      }
      case 'fall': {
        const dir = norm2(s.dir ?? s.at);
        const fallT = 0.75;
        if (r.local < fallT) {
          const u = r.local / fallT;
          const pos: Vec2 = [s.at[0] + dir[0] * 0.55 * u, s.at[1] + dir[1] * 0.55 * u];
          const z = 1.25 - 1.05 * u * u;
          upright(pos, z, 0, null, false, dir);
          // Flailing arms during the fall.
          const flail = 0.35 * Math.sin(2 * Math.PI * 2.5 * r.local);
          out.push({ p: [pos[0] + dir[0] * flail, pos[1] + dir[1] * flail, z + 0.3], amp: LIMB_AMP });
        } else {
          lying([s.at[0] + dir[0] * 0.55, s.at[1] + dir[1] * 0.55], dir, s.bpm ?? 20);
        }
        break;
      }
      case 'lie':
        lying(s.at, s.dir ?? s.at, s.bpm ?? 16);
        break;
    }
    return out;
  }
}
