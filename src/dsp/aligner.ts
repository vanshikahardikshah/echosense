import { parabolicOffset } from './filters';

export interface AlignState {
  locked: boolean;
  offset: number;
  /** True when the alignment changed this frame (first lock, drift step or relock after a dropout). */
  changed: boolean;
  /** Smoothed magnitude of the direct speaker-to-mic path. */
  directAmp: number;
}

/**
 * Finds and tracks the direct speaker-to-microphone path in the circular
 * correlation profile. The direct path is the strongest, earliest arrival, so
 * its index tells us the unknown output-to-input latency of the audio stack.
 * Rotating every profile so the direct path sits at bin 0 turns lag into range.
 *
 * Handles three real-world failure modes: slow drift between input and output
 * clocks (Bluetooth, external interfaces), dropped audio blocks (sudden jump)
 * and loss of signal (speaker muted, phone covered).
 */
export class DirectPathAligner {
  readonly n: number;
  locked = false;
  offset = 0;
  directAmp = 0;
  private acc: Float64Array;
  private accFrames = 0;
  private driftVotes = 0;
  private driftDir = 0;
  private jumpCandidate = -1;
  private jumpVotes = 0;
  private lostFrames = 0;
  private readonly acquireFrames: number;

  constructor(n: number, acquireFrames = 10) {
    this.n = n;
    this.acc = new Float64Array(n);
    this.acquireFrames = acquireFrames;
  }

  reset(): void {
    this.locked = false;
    this.acc.fill(0);
    this.accFrames = 0;
    this.driftVotes = 0;
    this.jumpCandidate = -1;
    this.jumpVotes = 0;
    this.lostFrames = 0;
    this.directAmp = 0;
  }

  private mag(re: Float64Array, im: Float64Array, i: number): number {
    const j = ((i % this.n) + this.n) % this.n;
    return Math.hypot(re[j], im[j]);
  }

  observe(re: Float64Array, im: Float64Array): AlignState {
    const n = this.n;
    if (!this.locked) {
      for (let i = 0; i < n; i++) this.acc[i] += Math.hypot(re[i], im[i]);
      this.accFrames++;
      if (this.accFrames >= this.acquireFrames) {
        let best = 0;
        for (let i = 1; i < n; i++) if (this.acc[i] > this.acc[best]) best = i;
        // Prefer the earliest arrival within 3 dB of the maximum: a strong
        // table reflection can rival the direct path but always arrives later.
        const thr = this.acc[best] * 0.7;
        const win = Math.min(64, n >> 3);
        let earliest = best;
        for (let d = 1; d <= win; d++) {
          const i = (best - d + n) % n;
          if (this.acc[i] >= thr && this.isLocalMax(this.acc, i)) earliest = i;
        }
        this.offset = earliest;
        this.directAmp = this.acc[earliest] / this.accFrames;
        this.locked = this.directAmp > 0;
        this.acc.fill(0);
        this.accFrames = 0;
        return { locked: this.locked, offset: this.offset, changed: this.locked, directAmp: this.directAmp };
      }
      return { locked: false, offset: this.offset, changed: false, directAmp: 0 };
    }

    let changed = false;
    // Local search around the current offset.
    let bestI = this.offset;
    let bestV = this.mag(re, im, this.offset);
    for (let d = -3; d <= 3; d++) {
      const v = this.mag(re, im, this.offset + d);
      if (v > bestV) {
        bestV = v;
        bestI = this.offset + d;
      }
    }
    if (bestV >= 0.45 * this.directAmp) {
      this.lostFrames = 0;
      this.jumpVotes = 0;
      const frac =
        bestI -
        this.offset +
        parabolicOffset(this.mag(re, im, bestI - 1), bestV, this.mag(re, im, bestI + 1));
      // Hysteresis: only step when the sub-bin peak sits more than 0.75 bins
      // away for many consecutive frames, so noise never causes flicker.
      const dir = frac > 0.75 ? 1 : frac < -0.75 ? -1 : 0;
      if (dir !== 0 && dir === this.driftDir) this.driftVotes++;
      else {
        this.driftDir = dir;
        this.driftVotes = dir !== 0 ? 1 : 0;
      }
      if (this.driftVotes >= 12) {
        this.offset = (this.offset + dir + n) % n;
        this.driftVotes = 0;
        changed = true;
      }
      this.directAmp += 0.02 * (bestV - this.directAmp);
    } else {
      // Direct path vanished locally: look for it elsewhere (dropped samples).
      let g = 0;
      let gv = 0;
      for (let i = 0; i < n; i++) {
        const v = Math.hypot(re[i], im[i]);
        if (v > gv) {
          gv = v;
          g = i;
        }
      }
      if (gv >= 0.45 * this.directAmp) {
        const near = this.jumpCandidate >= 0 && Math.abs(((g - this.jumpCandidate + n + n / 2) % n) - n / 2) <= 2;
        this.jumpVotes = near ? this.jumpVotes + 1 : 1;
        this.jumpCandidate = g;
        if (this.jumpVotes >= 3) {
          this.offset = g;
          this.jumpVotes = 0;
          this.jumpCandidate = -1;
          this.directAmp = gv;
          changed = true;
        }
      }
      this.lostFrames++;
      if (this.lostFrames > 60) {
        this.reset();
        return { locked: false, offset: this.offset, changed: true, directAmp: 0 };
      }
    }
    return { locked: true, offset: this.offset, changed, directAmp: this.directAmp };
  }

  private isLocalMax(a: Float64Array, i: number): boolean {
    const n = this.n;
    return a[i] >= a[(i - 1 + n) % n] && a[i] >= a[(i + 1) % n];
  }

  /**
   * Copy `bins` aligned bins (direct path at 0) into out arrays. When
   * `phaseRef` is set, every bin is rotated by the conjugate phase of the
   * direct path, cancelling common-mode phase jitter of the audio clocks.
   */
  rotate(
    re: Float64Array,
    im: Float64Array,
    outRe: Float64Array,
    outIm: Float64Array,
    bins: number,
    phaseRef = true,
  ): void {
    const n = this.n;
    let pr = 1;
    let pi = 0;
    if (phaseRef) {
      const dr = re[this.offset];
      const di = im[this.offset];
      const m = Math.hypot(dr, di);
      if (m > 0) {
        pr = dr / m;
        pi = -di / m;
      }
    }
    for (let k = 0; k < bins; k++) {
      const j = (this.offset + k) % n;
      const a = re[j];
      const b = im[j];
      outRe[k] = a * pr - b * pi;
      outIm[k] = a * pi + b * pr;
    }
  }
}
