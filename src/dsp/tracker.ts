export interface Detection {
  range: number; // metres
  snrDb: number;
  power: number;
  bin: number;
  width: number; // metres spanned by the cluster
}

export interface Track {
  id: number;
  range: number;
  velocity: number; // m/s, negative = approaching
  snrDb: number;
  confirmed: boolean;
  hits: number;
  misses: number;
  age: number; // frames
  /** Smoothed variance of the range estimate (m^2). */
  rangeVar: number;
}

interface KF {
  x: [number, number];
  P: [number, number, number, number];
}

/**
 * Multi-target 1-D range tracker: constant-velocity Kalman filter per track,
 * nearest-neighbour gated association, M-of-N confirmation and coasting.
 */
export class RangeTracker {
  private tracks: (Track & { kf: KF; history: number[] })[] = [];
  private nextId = 1;
  private readonly dt: number;
  private readonly q: number;
  private readonly r: number;

  constructor(
    frameRate: number,
    private readonly opts = {
      accelStd: 3.0, // m/s^2 process noise
      measStd: 0.05, // m
      gate: 0.4, // m
      confirmHits: 4,
      confirmWindow: 7,
      maxMisses: 0.6, // seconds
      maxTracks: 4,
    },
    /** Sweep range-Doppler coupling (s): measured range = true range + k * rangeRate. */
    private readonly dopplerCoupling = 0,
  ) {
    this.dt = 1 / frameRate;
    this.q = opts.accelStd * opts.accelStd;
    this.r = opts.measStd * opts.measStd;
  }

  reset(): void {
    this.tracks = [];
  }

  update(dets: Detection[]): Track[] {
    const dt = this.dt;
    // Predict.
    for (const t of this.tracks) {
      const { x, P } = t.kf;
      x[0] += x[1] * dt;
      const q = this.q;
      const dt2 = dt * dt;
      const p00 = P[0] + dt * (P[1] + P[2]) + dt2 * P[3] + (q * dt2 * dt2) / 4;
      const p01 = P[1] + dt * P[3] + (q * dt2 * dt) / 2;
      const p10 = P[2] + dt * P[3] + (q * dt2 * dt) / 2;
      const p11 = P[3] + q * dt2;
      t.kf.P = [p00, p01, p10, p11];
    }
    // Associate: greedy by SNR, nearest predicted track within gate.
    const used = new Set<number>();
    const sorted = [...dets].sort((a, b) => b.snrDb - a.snrDb);
    const assigned = new Map<number, Detection>();
    const births: typeof this.tracks = [];
    for (const d of sorted) {
      let best = -1;
      let bestDist = Infinity;
      for (let i = 0; i < this.tracks.length; i++) {
        if (used.has(i)) continue;
        const t = this.tracks[i];
        const gate = this.opts.gate + Math.abs(t.kf.x[1]) * dt * 2 + 2 * Math.sqrt(t.kf.P[0]);
        const dist = Math.abs(d.range - t.kf.x[0]);
        if (dist < gate && dist < bestDist) {
          bestDist = dist;
          best = i;
        }
      }
      if (best >= 0) {
        used.add(best);
        assigned.set(best, d);
      } else if (this.tracks.length + births.length < this.opts.maxTracks) {
        births.push({
          id: this.nextId++,
          range: d.range,
          velocity: 0,
          snrDb: d.snrDb,
          confirmed: false,
          hits: 1,
          misses: 0,
          age: 1,
          rangeVar: this.r,
          kf: { x: [d.range, 0], P: [this.r * 4, 0, 0, 1] },
          history: [1],
        });
      }
    }
    // Update.
    const maxMissFrames = Math.round(this.opts.maxMisses / dt);
    for (let i = 0; i < this.tracks.length; i++) {
      const t = this.tracks[i];
      const d = assigned.get(i);
      t.age++;
      if (d) {
        const { x, P } = t.kf;
        const r = this.r * (1 + Math.max(0, 15 - d.snrDb) / 5); // weaker echoes are noisier
        const s = P[0] + r;
        const k0 = P[0] / s;
        const k1 = P[2] / s;
        // Undo the chirp's range-Doppler coupling using the current velocity estimate.
        const y = d.range - this.dopplerCoupling * x[1] - x[0];
        x[0] += k0 * y;
        x[1] += k1 * y;
        t.kf.P = [(1 - k0) * P[0], (1 - k0) * P[1], P[2] - k1 * P[0], P[3] - k1 * P[1]];
        t.hits++;
        t.misses = 0;
        t.snrDb += 0.3 * (d.snrDb - t.snrDb);
        t.history.push(1);
      } else {
        t.misses++;
        t.snrDb -= 0.5;
        t.history.push(0);
      }
      if (t.history.length > this.opts.confirmWindow) t.history.shift();
      if (!t.confirmed && t.history.reduce((a, b) => a + b, 0) >= this.opts.confirmHits) t.confirmed = true;
      t.range = t.kf.x[0];
      t.velocity = t.kf.x[1];
      t.rangeVar = t.kf.P[0];
    }
    this.tracks = this.tracks.filter((t) => t.misses <= maxMissFrames && t.range > 0);
    this.tracks.push(...births);
    // Merge tracks that collapsed onto the same target.
    this.tracks.sort((a, b) => b.hits - a.hits);
    const kept: typeof this.tracks = [];
    for (const t of this.tracks) {
      if (kept.some((k) => Math.abs(k.range - t.range) < 0.15)) continue;
      kept.push(t);
    }
    this.tracks = kept;
    return this.tracks.map(({ kf: _kf, history: _h, ...pub }) => ({ ...pub }));
  }

  /** The most credible confirmed track (strongest, then longest-lived). */
  primary(): Track | null {
    let best: (typeof this.tracks)[number] | null = null;
    for (const t of this.tracks) {
      if (!t.confirmed || t.misses > 0) continue;
      if (!best || t.snrDb + 0.02 * t.hits > best.snrDb + 0.02 * best.hits) best = t;
    }
    if (!best) {
      for (const t of this.tracks) if (t.confirmed && (!best || t.hits > best.hits)) best = t;
    }
    if (!best) return null;
    const { kf: _kf, history: _h, ...pub } = best;
    return { ...pub };
  }
}
