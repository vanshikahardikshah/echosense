import { Biquad, BiquadBank, emaAlpha, median, parabolicOffset } from './filters';

export interface BreathingEstimate {
  valid: boolean;
  rateBpm: number;
  /** Normalised autocorrelation peak, 0..1. */
  quality: number;
  range: number;
  /** Breathing-band energy at the chosen bin relative to the median bin, dB. */
  prominenceDb: number;
  /** Seconds of uninterrupted stillness the estimate is based on. */
  stillSeconds: number;
  waveform: Float32Array;
}

const EMPTY: BreathingEstimate = {
  valid: false,
  rateBpm: 0,
  quality: 0,
  range: 0,
  prominenceDb: 0,
  stillSeconds: 0,
  waveform: new Float32Array(0),
};

/**
 * Contactless respiration from sub-millimetre chest motion.
 *
 * For every candidate range bin we remove the static echo with a slow complex
 * background, then project the residual onto its principal I/Q axis. For the
 * small displacements of breathing (a few mm, well under half a wavelength of
 * ~9 mm at 19 kHz) that projection is proportional to chest displacement. A
 * 0.1-0.9 Hz band-pass isolates respiration; the bin with the most periodic
 * signal (autocorrelation) wins, and its period gives the breathing rate.
 */
export class BreathingAnalyzer {
  private readonly ch: number;
  private readonly bins: Int32Array;
  private readonly bgRe: Float64Array;
  private readonly bgIm: Float64Array;
  private readonly sxx: Float64Array;
  private readonly syy: Float64Array;
  private readonly sxy: Float64Array;
  private readonly theta: Float64Array;
  private readonly hp: BiquadBank;
  private readonly lp: BiquadBank;
  private readonly bandPow: Float64Array;
  private readonly hist: Float32Array;
  private readonly histLen: number;
  private head = 0;
  private filled = 0;
  private readonly aBg: number;
  private readonly aCov: number;
  private readonly aPow: number;
  private stillFrames = 0;
  private framesSinceEstimate = 0;
  private last: BreathingEstimate = EMPTY;
  private goodStreak = 0;
  private smoothedRate = 0;
  private warm = 0;
  private focusRange = 0;

  constructor(
    private readonly fps: number,
    binStart: number,
    binEnd: number,
    private readonly binToRange: (bin: number) => number,
    decimate = 2,
  ) {
    const list: number[] = [];
    for (let b = binStart; b < binEnd; b += decimate) list.push(b);
    this.bins = Int32Array.from(list);
    this.ch = list.length;
    const c = this.ch;
    this.bgRe = new Float64Array(c);
    this.bgIm = new Float64Array(c);
    this.sxx = new Float64Array(c);
    this.syy = new Float64Array(c);
    this.sxy = new Float64Array(c);
    this.theta = new Float64Array(c);
    this.hp = new BiquadBank(Biquad.highpass(fps, 0.1), c);
    this.lp = new BiquadBank(Biquad.lowpass(fps, 0.9), c);
    this.bandPow = new Float64Array(c);
    this.histLen = Math.round(30 * fps);
    this.hist = new Float32Array(c * this.histLen);
    this.aBg = emaAlpha(8, fps);
    this.aCov = emaAlpha(6, fps);
    this.aPow = emaAlpha(8, fps);
  }

  reset(): void {
    this.bgRe.fill(0);
    this.bgIm.fill(0);
    this.sxx.fill(0);
    this.syy.fill(0);
    this.sxy.fill(0);
    this.theta.fill(0);
    this.hp.reset();
    this.lp.reset();
    this.bandPow.fill(0);
    this.hist.fill(0);
    this.head = 0;
    this.filled = 0;
    this.stillFrames = 0;
    this.last = EMPTY;
    this.goodStreak = 0;
    this.warm = 0;
    this.focusRange = 0;
  }

  /**
   * Feed one aligned complex profile. `grossMotion` interrupts the estimate
   * (walking, gestures). When `motionRange` is given, motion more than 0.6 m
   * from the chest currently being measured is ignored: a hand on the screen
   * or someone across the room should not reset a still person's breathing.
   */
  update(re: Float64Array, im: Float64Array, grossMotion: boolean, motionRange?: number): void {
    const c = this.ch;
    const first = this.warm === 0;
    this.warm++;
    if (grossMotion && motionRange !== undefined && this.focusRange > 0 && Math.abs(motionRange - this.focusRange) > 0.6) {
      grossMotion = false;
    }
    if (grossMotion) {
      this.stillFrames = 0;
      this.goodStreak = 0;
    } else this.stillFrames++;
    for (let i = 0; i < c; i++) {
      const b = this.bins[i];
      const xr = re[b];
      const xi = im[b];
      if (first) {
        this.bgRe[i] = xr;
        this.bgIm[i] = xi;
      }
      // Faster background adaptation during gross motion so the residual recovers quickly.
      const a = grossMotion ? this.aBg * 6 : this.aBg;
      this.bgRe[i] += a * (xr - this.bgRe[i]);
      this.bgIm[i] += a * (xi - this.bgIm[i]);
      const dr = xr - this.bgRe[i];
      const di = xi - this.bgIm[i];
      const ac = this.aCov;
      this.sxx[i] += ac * (dr * dr - this.sxx[i]);
      this.syy[i] += ac * (di * di - this.syy[i]);
      this.sxy[i] += ac * (dr * di - this.sxy[i]);
      let th = 0.5 * Math.atan2(2 * this.sxy[i], this.sxx[i] - this.syy[i]);
      // Keep the axis direction continuous so the projection never flips sign.
      const prev = this.theta[i];
      while (th - prev > Math.PI / 2) th -= Math.PI;
      while (th - prev < -Math.PI / 2) th += Math.PI;
      this.theta[i] = th;
      const s = dr * Math.cos(th) + di * Math.sin(th);
      const y = this.lp.process(i, this.hp.process(i, s));
      this.bandPow[i] += this.aPow * (y * y - this.bandPow[i]);
      this.hist[i * this.histLen + this.head] = y;
    }
    // Track where the strongest breathing-band energy is (the chest being measured).
    let bi = 0;
    for (let i = 1; i < c; i++) if (this.bandPow[i] > this.bandPow[bi]) bi = i;
    this.focusRange = this.warm > this.fps * 4 ? this.binToRange(this.bins[bi]) : 0;
    this.head = (this.head + 1) % this.histLen;
    if (this.filled < this.histLen) this.filled++;
    this.framesSinceEstimate++;
    if (this.framesSinceEstimate >= Math.round(this.fps)) {
      this.framesSinceEstimate = 0;
      this.last = this.estimate();
    }
  }

  get current(): BreathingEstimate {
    return this.last;
  }

  private series(ch: number, len: number): Float64Array {
    const out = new Float64Array(len);
    const base = ch * this.histLen;
    let idx = (this.head - len + this.histLen) % this.histLen;
    for (let i = 0; i < len; i++) {
      out[i] = this.hist[base + idx];
      idx = (idx + 1) % this.histLen;
    }
    return out;
  }

  private estimate(): BreathingEstimate {
    const fps = this.fps;
    const stillSeconds = this.stillFrames / fps;
    // Need ~3 breaths of clean signal; ignore the band-pass settling period.
    const usable = Math.min(this.filled, this.stillFrames, Math.round(24 * fps));
    if (usable < 10 * fps || this.warm < 12 * fps) {
      this.goodStreak = 0;
      return { ...EMPTY, stillSeconds };
    }
    const med = median(this.bandPow) + 1e-30;
    // Candidate bins: top by breathing-band energy.
    const order = Array.from(this.bandPow.keys()).sort((a, b) => this.bandPow[b] - this.bandPow[a]);
    let best = { q: 0, lag: 0, ch: -1 };
    for (const ch of order.slice(0, 6)) {
      const x = this.series(ch, usable);
      const r = this.acfPeak(x);
      if (r.q > best.q) best = { q: r.q, lag: r.lag, ch };
    }
    if (best.ch < 0 || best.lag <= 0) {
      this.goodStreak = 0;
      return { ...EMPTY, stillSeconds };
    }
    const rate = (60 * fps) / best.lag;
    const prominenceDb = 10 * Math.log10(this.bandPow[best.ch] / med);
    const good = best.q > 0.45 && prominenceDb > 10;
    this.goodStreak = good ? this.goodStreak + 1 : 0;
    if (good) this.smoothedRate = this.goodStreak === 1 ? rate : 0.6 * this.smoothedRate + 0.4 * rate;
    const wf = this.series(best.ch, Math.min(usable, Math.round(20 * fps)));
    let peak = 1e-30;
    for (const v of wf) peak = Math.max(peak, Math.abs(v));
    const waveform = new Float32Array(wf.length);
    for (let i = 0; i < wf.length; i++) waveform[i] = wf[i] / peak;
    return {
      valid: this.goodStreak >= 2,
      rateBpm: good ? this.smoothedRate : rate,
      quality: best.q,
      range: this.binToRange(this.bins[best.ch]),
      prominenceDb,
      stillSeconds,
      waveform,
    };
  }

  /** Normalised autocorrelation peak for periods 1.5-7.5 s (8-40 breaths/min). */
  private acfPeak(x: Float64Array): { q: number; lag: number } {
    const fps = this.fps;
    const n = x.length;
    let mean = 0;
    for (const v of x) mean += v;
    mean /= n;
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x[i] - mean;
    const lagMin = Math.max(2, Math.floor(1.5 * fps));
    const lagMax = Math.min(n - Math.round(2 * fps), Math.ceil(7.5 * fps));
    if (lagMax <= lagMin + 2) return { q: 0, lag: 0 };
    const r = new Float64Array(lagMax + 2);
    for (let l = lagMin - 1; l <= lagMax + 1; l++) {
      let s = 0;
      let e0 = 0;
      let e1 = 0;
      for (let i = 0; i + l < n; i++) {
        s += y[i] * y[i + l];
        e0 += y[i] * y[i];
        e1 += y[i + l] * y[i + l];
      }
      r[l] = s / Math.sqrt(e0 * e1 + 1e-30);
    }
    let maxPeak = 0;
    const peaks: number[] = [];
    for (let l = lagMin; l <= lagMax; l++) {
      if (r[l] > r[l - 1] && r[l] >= r[l + 1] && r[l] > 0.2) {
        peaks.push(l);
        maxPeak = Math.max(maxPeak, r[l]);
      }
    }
    if (peaks.length === 0) return { q: 0, lag: 0 };
    // Prefer the fundamental: the shortest-lag peak that is nearly as strong as the best.
    const l = peaks.find((p) => r[p] >= 0.8 * maxPeak) ?? peaks[0];
    const off = parabolicOffset(r[l - 1], r[l], r[l + 1]);
    return { q: r[l], lag: l + off };
  }
}
