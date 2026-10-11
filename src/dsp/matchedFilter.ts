import { ChirpDesign } from './chirp';
import { FFT, getFFT } from './fft';

/**
 * Windowed linear matched filter producing a complex (analytic) channel
 * impulse response once per transmit period.
 *
 * For every lag tau in one period we correlate n contiguous received samples
 * r[tau .. tau+n) with the analytic reference period, weighted by a Hann
 * window. Using contiguous samples (rather than a circular wrap of one frame)
 * and tapering the window are both essential for moving targets: a walking
 * person's echo drifts by a fraction of a sample per period, and a rectangular
 * circular correlation turns that into a broadband smear across every range
 * bin. With the taper, sidelobes stay near -35 dB for walking speeds.
 *
 * Because the waveform is a linear sweep, the Hann time window is also a Hann
 * frequency taper. Only bins inside the sonar band are kept, so speech, music
 * and other audible sound are rejected outright. An optional per-bin equaliser
 * (estimated from the direct path at calibration) flattens the phone speaker's
 * high-frequency roll-off.
 */
export class MatchedFilter {
  readonly n: number;
  readonly kLo: number;
  readonly kHi: number;
  /** Half-width (bins) of the point-spread-function mainlobe at -6 dB. */
  readonly psfHalfWidth: number;
  /**
   * Range-Doppler coupling of the sweep: a target with range rate v (m/s)
   * appears shifted by `dopplerRangeCoupling * v` metres.
   */
  readonly dopplerRangeCoupling: number;
  private readonly fft2: FFT;
  private readonly gRe: Float64Array; // conj(FFT_2n(reference)), band bins only
  private readonly gIm: Float64Array;
  private readonly baseRe: Float64Array;
  private readonly baseIm: Float64Array;
  private readonly lo2: number;
  private readonly hi2: number;
  private readonly buf: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private scale = 1;
  /** Guard-band bins (2n grid) beside the sonar band: the transmit signal has no energy there. */
  private readonly guards: [number, number][];
  /** Mean power per guard bin in the last correlation window. */
  lastGuardPower = 0;

  constructor(private readonly design: ChirpDesign) {
    const n = design.n;
    this.n = n;
    this.kLo = design.kLo;
    this.kHi = design.kHi;
    const fft = getFFT(n);
    this.fft2 = getFFT(2 * n);
    // Analytic reference period (positive in-band frequencies, doubled).
    const ar = new Float64Array(n);
    const ai = new Float64Array(n);
    for (let k = this.kLo; k <= this.kHi; k++) {
      ar[k] = 2 * design.specRe[k];
      ai[k] = 2 * design.specIm[k];
    }
    fft.inverse(ar, ai);
    // Hann window, then zero-pad to 2n and transform.
    const pr = new Float64Array(2 * n);
    const pi = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
      pr[i] = ar[i] * w;
      pi[i] = ai[i] * w;
    }
    this.fft2.forward(pr, pi);
    // Keep a small guard around the band in the 2n grid.
    this.lo2 = Math.max(1, 2 * this.kLo - 6);
    this.hi2 = Math.min(n - 1, 2 * this.kHi + 6);
    this.baseRe = new Float64Array(2 * n);
    this.baseIm = new Float64Array(2 * n);
    for (let k = this.lo2; k <= this.hi2; k++) {
      this.baseRe[k] = pr[k];
      this.baseIm[k] = -pi[k];
    }
    const df2 = design.fs / (2 * n);
    const nyq = design.fs / 2;
    const g1: [number, number] = [Math.round(16000 / df2), Math.round((design.f0 - 400) / df2)];
    const g2: [number, number] = [Math.round((design.f1 + 400) / df2), Math.round(Math.min(23000, nyq - 400) / df2)];
    this.guards = [g1, g2].filter(([a, b]) => b - a >= 4);
    this.gRe = Float64Array.from(this.baseRe);
    this.gIm = Float64Array.from(this.baseIm);
    this.buf = new Float64Array(2 * n);
    this.re = new Float64Array(2 * n);
    this.im = new Float64Array(2 * n);
    this.calibrate();
    this.psfHalfWidth = this.measurePsf();
    this.dopplerRangeCoupling = (design.fc * design.period) / design.bandwidth;
  }

  private calibrate(): void {
    this.scale = 1;
    const n = this.n;
    const x = new Float64Array(2 * n);
    for (let i = 0; i < 2 * n; i++) x[i] = this.design.samples[i % n];
    const oRe = new Float64Array(n);
    const oIm = new Float64Array(n);
    this.correlate(x, oRe, oIm);
    this.scale = 1 / (Math.hypot(oRe[0], oIm[0]) || 1);
  }

  private measurePsf(): number {
    const n = this.n;
    const x = new Float64Array(2 * n);
    for (let i = 0; i < 2 * n; i++) x[i] = this.design.samples[(i + n / 2) % n];
    const oRe = new Float64Array(n);
    const oIm = new Float64Array(n);
    this.correlate(x, oRe, oIm);
    let pk = 0;
    let pv = 0;
    for (let i = 0; i < n; i++) {
      const v = Math.hypot(oRe[i], oIm[i]);
      if (v > pv) {
        pv = v;
        pk = i;
      }
    }
    let hw = 0;
    while (hw < n / 4 && Math.hypot(oRe[(pk + hw) % n], oIm[(pk + hw) % n]) > pv / 2) hw++;
    return Math.max(2, hw);
  }

  /**
   * Install a magnitude equaliser (one gain per in-band bin of the n-point
   * grid, kLo..kHi), normally the inverse of the measured speaker+mic
   * response. Gains are normalised to mean 1 and clamped.
   */
  setEqualizer(gains: Float64Array | null): void {
    this.gRe.set(this.baseRe);
    this.gIm.set(this.baseIm);
    if (gains) {
      let mean = 0;
      for (const g of gains) mean += g;
      mean /= gains.length;
      for (let k = this.lo2; k <= this.hi2; k++) {
        const kk = Math.min(this.kHi, Math.max(this.kLo, Math.round(k / 2)));
        const g = Math.min(4, Math.max(0.25, gains[kk - this.kLo] / mean));
        this.gRe[k] *= g;
        this.gIm[k] *= g;
      }
    }
    this.calibrate();
  }

  private correlate(x: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const n2 = 2 * this.n;
    const re = this.re;
    const im = this.im;
    for (let i = 0; i < n2; i++) {
      re[i] = x[i];
      im[i] = 0;
    }
    this.fft2.forward(re, im);
    let gp = 0;
    let gc = 0;
    for (const [a, b] of this.guards) {
      for (let k = a; k <= b; k++) {
        gp += re[k] * re[k] + im[k] * im[k];
        gc++;
      }
    }
    this.lastGuardPower = gc ? gp / gc : 0;
    for (let k = 0; k < n2; k++) {
      if (k < this.lo2 || k > this.hi2) {
        re[k] = 0;
        im[k] = 0;
        continue;
      }
      const a = re[k];
      const b = im[k];
      re[k] = a * this.gRe[k] - b * this.gIm[k];
      im[k] = a * this.gIm[k] + b * this.gRe[k];
    }
    this.fft2.inverse(re, im);
    const s = this.scale;
    for (let i = 0; i < this.n; i++) {
      outRe[i] = re[i] * s;
      outIm[i] = im[i] * s;
    }
  }

  /**
   * Feed the newest n samples. The profile is computed over the previous and
   * the current frame (2n contiguous samples), so it describes the channel
   * during the previous frame. Writes n complex lags into outRe/outIm.
   */
  process(frame: ArrayLike<number>, outRe: Float64Array, outIm: Float64Array): void {
    const n = this.n;
    this.buf.copyWithin(0, n);
    for (let i = 0; i < n; i++) this.buf[n + i] = frame[i];
    this.correlate(this.buf, outRe, outIm);
  }

  reset(): void {
    this.buf.fill(0);
  }

  /** In-band mean power of x (0.5 for a full-scale sine). n samples. */
  inBandPower(x: ArrayLike<number>): number {
    const n = this.n;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[i];
    getFFT(n).forward(re, im);
    let p = 0;
    for (let k = this.kLo; k <= this.kHi; k++) p += re[k] * re[k] + im[k] * im[k];
    return (2 * p) / (n * n);
  }

  /** Magnitude spectrum of x at the in-band bins (kLo..kHi), n samples. */
  bandMagnitudes(x: ArrayLike<number>): Float64Array {
    const n = this.n;
    const re = new Float64Array(n);
    const im = new Float64Array(n);
    for (let i = 0; i < n; i++) re[i] = x[i];
    getFFT(n).forward(re, im);
    const out = new Float64Array(this.kHi - this.kLo + 1);
    for (let k = this.kLo; k <= this.kHi; k++) out[k - this.kLo] = Math.hypot(re[k], im[k]);
    return out;
  }
}
