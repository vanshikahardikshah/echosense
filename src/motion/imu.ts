export interface ImuSample {
  t: number;
  /** Acceleration including gravity, m/s^2. */
  ax: number;
  ay: number;
  az: number;
  /** Rotation rate, deg/s. */
  gx: number;
  gy: number;
  gz: number;
}

export type ImuEventType = 'moved' | 'settled' | 'drop' | 'body_fall';

export interface ImuEvent {
  t: number;
  type: ImuEventType;
  confidence: number;
  detail: string;
}

export interface ImuState {
  available: boolean;
  stationary: boolean;
  /** Seconds since the device last moved. */
  stillFor: number;
  accelG: number;
  gyroDps: number;
}

const G = 9.81;

/**
 * Inertial monitoring with two jobs.
 *
 * Room mode: the phone is a fixed sensor. Any movement invalidates the sonar's
 * learned room background, so we report `moved` and, once the phone is
 * stationary again, `settled` (with the orientation change) to trigger an
 * automatic recalibration. A free-fall followed by an impact is a `drop`.
 *
 * Body mode: the phone is carried. Classic threshold fall detection (after
 * Bourke et al., Gait & Posture 2007): a low-g phase, an impact spike above
 * ~2.5 g, then a sustained orientation change and low activity.
 */
export class ImuMonitor {
  private readonly win: { t: number; a: number; g: number }[] = [];
  private stationary = true;
  private lastMoveT = 0;
  private movingSince = -1;
  private stillSince = -1;
  private settledGravity: [number, number, number] | null = null;
  private gravity: [number, number, number] = [0, 0, G];
  private freeFallStart = -1;
  private freeFallEnd = -1;
  private impactT = -1;
  private impactGravity: [number, number, number] | null = null;
  private lastT = -1;
  private lastEventT = -10;
  private seen = false;
  private latest: ImuSample | null = null;

  constructor(private mode: 'room' | 'body' = 'room') {}

  setMode(mode: 'room' | 'body'): void {
    this.mode = mode;
  }

  state(t: number): ImuState {
    const s = this.latest;
    return {
      available: this.seen,
      stationary: this.stationary,
      stillFor: this.stationary ? t - this.lastMoveT : 0,
      accelG: s ? Math.hypot(s.ax, s.ay, s.az) / G : 1,
      gyroDps: s ? Math.hypot(s.gx, s.gy, s.gz) : 0,
    };
  }

  process(s: ImuSample): ImuEvent | null {
    this.seen = true;
    this.latest = s;
    const dt = this.lastT < 0 ? 0.016 : Math.min(0.1, Math.max(0.001, s.t - this.lastT));
    this.lastT = s.t;
    const a = Math.hypot(s.ax, s.ay, s.az) / G;
    const g = Math.hypot(s.gx, s.gy, s.gz);
    // Gravity estimate (0.5 s low-pass).
    const k = 1 - Math.exp(-dt / 0.5);
    this.gravity = [
      this.gravity[0] + k * (s.ax - this.gravity[0]),
      this.gravity[1] + k * (s.ay - this.gravity[1]),
      this.gravity[2] + k * (s.az - this.gravity[2]),
    ];
    this.win.push({ t: s.t, a, g });
    while (this.win.length && s.t - this.win[0].t > 0.5) this.win.shift();
    let mean = 0;
    for (const w of this.win) mean += w.a;
    mean /= this.win.length;
    let v = 0;
    let gmax = 0;
    for (const w of this.win) {
      v += (w.a - mean) ** 2;
      gmax = Math.max(gmax, w.g);
    }
    const std = Math.sqrt(v / this.win.length);
    const quiet = std < 0.03 && gmax < 5;

    let ev: ImuEvent | null = null;
    const emit = (type: ImuEventType, confidence: number, detail: string) => {
      if (s.t - this.lastEventT < 0.5 && type === 'moved') return;
      this.lastEventT = s.t;
      ev = { t: s.t, type, confidence, detail };
    };

    // Free fall then impact.
    if (a < 0.4) {
      if (this.freeFallStart < 0) this.freeFallStart = s.t;
      this.freeFallEnd = s.t;
    } else if (this.freeFallStart >= 0 && s.t - this.freeFallEnd > 0.8) {
      this.freeFallStart = -1;
    }
    if (a > 2.3 && this.freeFallStart >= 0 && s.t - this.freeFallEnd < 0.8) {
      const ffDur = this.freeFallEnd - this.freeFallStart;
      if (this.mode === 'room' && ffDur >= 0.06) {
        emit('drop', Math.min(0.95, 0.5 + ffDur * 2), `free fall ${(ffDur * 1000).toFixed(0)} ms, impact ${a.toFixed(1)} g`);
      }
      if (this.mode === 'body') {
        this.impactT = s.t;
        this.impactGravity = this.settledGravity ?? [...this.gravity];
      }
      this.freeFallStart = -1;
    } else if (this.mode === 'body' && a > 2.8 && this.impactT < 0) {
      // Hard impact without a clean free-fall phase (stumble).
      this.impactT = s.t;
      this.impactGravity = this.settledGravity ?? [...this.gravity];
    }

    // Body-mode confirmation: orientation change + low activity within 3 s of impact.
    if (this.mode === 'body' && this.impactT >= 0) {
      const since = s.t - this.impactT;
      if (since > 1.0 && std < 0.08 && this.impactGravity) {
        const ang = angleDeg(this.impactGravity, this.gravity);
        if (ang > 40) emit('body_fall', Math.min(0.95, 0.55 + ang / 300), `impact, then ${ang.toFixed(0)} deg orientation change and stillness`);
        this.impactT = -1;
      } else if (since > 3.5) this.impactT = -1;
    }

    // Moved / settled (room-mode sensor integrity).
    if (quiet) {
      this.movingSince = -1;
      if (!this.stationary) {
        if (this.stillSince < 0) this.stillSince = s.t;
        if (s.t - this.stillSince > 1.5) {
          this.stationary = true;
          const ang = this.settledGravity ? angleDeg(this.settledGravity, this.gravity) : 0;
          this.settledGravity = [...this.gravity];
          emit('settled', 0.9, `stationary again (orientation changed ${ang.toFixed(0)} deg)`);
        }
      } else if (!this.settledGravity) this.settledGravity = [...this.gravity];
    } else {
      this.stillSince = -1;
      this.lastMoveT = s.t;
      if (this.stationary) {
        if (this.movingSince < 0) this.movingSince = s.t;
        const strong = std > 0.12 || gmax > 25;
        if (s.t - this.movingSince > 0.15 || strong) {
          this.stationary = false;
          if (this.mode === 'room') emit('moved', strong ? 0.9 : 0.6, strong ? 'phone picked up or bumped' : 'phone shifted');
        }
      }
    }
    return ev;
  }
}

function angleDeg(a: [number, number, number], b: [number, number, number]): number {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const m = Math.hypot(...a) * Math.hypot(...b) || 1;
  return (Math.acos(Math.max(-1, Math.min(1, d / m))) * 180) / Math.PI;
}
