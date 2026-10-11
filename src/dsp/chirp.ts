import { getFFT } from './fft';

/**
 * Periodic sonar waveform: a band-limited Zadoff-Chu style sweep built in the
 * frequency domain.
 *
 * Every DFT bin inside [f0, f1] carries exactly equal energy with quadratic
 * (Zadoff-Chu) phase. Quadratic phase in frequency is a linear sweep in time
 * (f0 at the start of the period, f1 at the end), so this is a sawtooth FM
 * chirp whose line spectrum is perfectly flat. Two consequences matter:
 * the matched filter's point-spread function is set purely by the analysis
 * window (low range sidelobes), and the waveform stays Doppler tolerant
 * (a moving target shifts the peak slightly instead of smearing it).
 * The signal is periodic in n samples by construction, so the looped buffer
 * has no click at the seam, and it contains no energy below f0.
 */
export interface ChirpDesign {
  fs: number;
  n: number;
  f0: number;
  f1: number;
  fc: number;
  bandwidth: number;
  period: number; // seconds
  kLo: number;
  kHi: number;
  /** Sampled single period, peak amplitude 1. */
  samples: Float64Array;
  /** Complex spectrum of `samples` (length n). */
  specRe: Float64Array;
  specIm: Float64Array;
  /** Peak-to-RMS ratio of the transmit signal (1.414 is a pure sine). */
  crestFactor: number;
  /** Signal value at any real time t (band-limited interpolation, periodic). */
  valueAt(t: number): number;
}

export interface Band {
  f0: number;
  f1: number;
}

/** Wide band for a single node. */
export const WIDE_BAND: Band = { f0: 18000, f1: 20800 };
/**
 * Fallback for devices whose speaker or microphone roll off above 18 kHz
 * (many laptops). Still above speech and most music, but a faint hiss may be
 * audible to children and young adults.
 */
export const LOW_BAND: Band = { f0: 16200, f1: 19000 };

/** Frequency-division plans so several phones can sense the same room without interfering. */
export function bandPlan(count: number): Band[] {
  if (count <= 1) return [WIDE_BAND];
  if (count === 2)
    return [
      // Both halves stay inside 17.8 to 20.85 kHz, the range verified on iPhone
      // speakers and microphones (many phone mics roll off above about 21 kHz).
      { f0: 17800, f1: 19250 },
      { f0: 19400, f1: 20850 },
    ];
  // Three phones: kept below about 20 kHz, where iPhone speakers are still strong. The old top band
  // (19.9 to 20.9 kHz) gave that phone the weakest link in our real room tests.
  return [
    { f0: 17000, f1: 17950 },
    { f0: 18100, f1: 19050 },
    { f0: 19200, f1: 20150 },
  ];
}

const OVERSAMPLE = 64;

export function designChirp(fs: number, n: number, band: Band): ChirpDesign {
  const nyq = fs / 2;
  if (band.f1 >= nyq - 200) throw new Error(`Band upper edge ${band.f1} Hz too close to Nyquist ${nyq} Hz`);
  if (band.f1 <= band.f0) throw new Error('Band must have positive width');
  const df = fs / n;
  const kLo = Math.ceil(band.f0 / df);
  const kHi = Math.floor(band.f1 / df);
  const M = kHi - kLo + 1;
  if (M < 8) throw new Error('Band too narrow for this period length');
  const fft = getFFT(n);

  // Quadratic (Zadoff-Chu root 1) phase across the occupied bins.
  const phase = new Float64Array(M);
  for (let m = 0; m < M; m++) phase[m] = (-Math.PI * m * (m + (M % 2))) / M;

  const re = new Float64Array(n);
  const im = new Float64Array(n);
  const analytic = (): void => {
    re.fill(0);
    im.fill(0);
    for (let m = 0; m < M; m++) {
      re[kLo + m] = 2 * Math.cos(phase[m]);
      im[kLo + m] = 2 * Math.sin(phase[m]);
    }
    fft.inverse(re, im);
  };
  analytic();
  const samples = new Float64Array(n);
  let peak = 0;
  let pow = 0;
  for (let i = 0; i < n; i++) {
    samples[i] = re[i];
    peak = Math.max(peak, Math.abs(re[i]));
  }
  for (let i = 0; i < n; i++) {
    samples[i] /= peak;
    pow += samples[i] * samples[i];
  }
  const crestFactor = 1 / Math.sqrt(pow / n);

  const specRe = Float64Array.from(samples);
  const specIm = new Float64Array(n);
  fft.forward(specRe, specIm);

  // Fine table for band-limited evaluation at arbitrary times (simulation).
  const L = n * OVERSAMPLE;
  const table = new Float64Array(L + 1);
  {
    const big = getFFT(L);
    const tr = new Float64Array(L);
    const ti = new Float64Array(L);
    for (let k = kLo; k <= kHi; k++) {
      tr[k] = specRe[k] * OVERSAMPLE;
      ti[k] = specIm[k] * OVERSAMPLE;
      tr[L - k] = specRe[k] * OVERSAMPLE;
      ti[L - k] = -specIm[k] * OVERSAMPLE;
    }
    big.inverse(tr, ti);
    for (let i = 0; i < L; i++) table[i] = tr[i];
    table[L] = table[0];
  }
  const T = n / fs;
  const valueAt = (t: number): number => {
    let u = ((t % T) + T) % T;
    u = (u / T) * L;
    const i = Math.floor(u);
    const f = u - i;
    return table[i] + f * (table[i + 1] - table[i]);
  };

  const f0 = kLo * df;
  const f1 = kHi * df;
  return {
    fs,
    n,
    f0,
    f1,
    fc: (f0 + f1) / 2,
    bandwidth: f1 - f0,
    period: T,
    kLo,
    kHi,
    samples,
    specRe,
    specIm,
    crestFactor,
    valueAt,
  };
}

/** Speed of sound in air (m/s) at a given temperature in Celsius. */
export function speedOfSound(tempC = 20): number {
  return 331.3 + 0.606 * tempC;
}

/** Pick a power-of-two period length giving at least `minRange` metres of unambiguous range. */
export function choosePeriod(fs: number, minRange: number, c = speedOfSound()): number {
  const needed = (2 * minRange * fs) / c;
  let n = 256;
  while (n < needed) n <<= 1;
  return n;
}
