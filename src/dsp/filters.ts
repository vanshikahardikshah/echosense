/** RBJ-cookbook biquad, transposed direct form II. */
export class Biquad {
  private b0 = 1; private b1 = 0; private b2 = 0; private a1 = 0; private a2 = 0;
  private z1 = 0; private z2 = 0;

  static lowpass(fs: number, f: number, q = Math.SQRT1_2): Biquad {
    const bq = new Biquad();
    const w = (2 * Math.PI * f) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    bq.b0 = (1 - cw) / 2 / a0;
    bq.b1 = (1 - cw) / a0;
    bq.b2 = (1 - cw) / 2 / a0;
    bq.a1 = (-2 * cw) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  static highpass(fs: number, f: number, q = Math.SQRT1_2): Biquad {
    const bq = new Biquad();
    const w = (2 * Math.PI * f) / fs;
    const cw = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    bq.b0 = (1 + cw) / 2 / a0;
    bq.b1 = -(1 + cw) / a0;
    bq.b2 = (1 + cw) / 2 / a0;
    bq.a1 = (-2 * cw) / a0;
    bq.a2 = (1 - alpha) / a0;
    return bq;
  }

  process(x: number): number {
    const y = this.b0 * x + this.z1;
    this.z1 = this.b1 * x - this.a1 * y + this.z2;
    this.z2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.z1 = 0;
    this.z2 = 0;
  }

  /** Coefficients, so many identical filters can share one design (see BiquadBank). */
  coeffs(): [number, number, number, number, number] {
    return [this.b0, this.b1, this.b2, this.a1, this.a2];
  }
}

/** Many independent channels through the same biquad design, stored in flat arrays. */
export class BiquadBank {
  private readonly c: [number, number, number, number, number];
  private readonly z1: Float64Array;
  private readonly z2: Float64Array;

  constructor(design: Biquad, channels: number) {
    this.c = design.coeffs();
    this.z1 = new Float64Array(channels);
    this.z2 = new Float64Array(channels);
  }

  process(ch: number, x: number): number {
    const [b0, b1, b2, a1, a2] = this.c;
    const y = b0 * x + this.z1[ch];
    this.z1[ch] = b1 * x - a1 * y + this.z2[ch];
    this.z2[ch] = b2 * x - a2 * y;
    return y;
  }

  reset(): void {
    this.z1.fill(0);
    this.z2.fill(0);
  }
}

/** Exponential moving average coefficient for a time constant (seconds) at a given update rate. */
export function emaAlpha(tauSeconds: number, rateHz: number): number {
  return 1 - Math.exp(-1 / (tauSeconds * rateHz));
}

export function median(values: ArrayLike<number>): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : 0.5 * (a[m - 1] + a[m]);
}

export function percentile(values: ArrayLike<number>, p: number): number {
  const a = Array.from(values).sort((x, y) => x - y);
  if (a.length === 0) return 0;
  const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
  return a[idx];
}

export function db(power: number, floor = 1e-20): number {
  return 10 * Math.log10(Math.max(power, floor));
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Parabolic interpolation of a peak at index i in y; returns fractional offset in [-0.5, 0.5]. */
export function parabolicOffset(ym1: number, y0: number, yp1: number): number {
  const d = ym1 - 2 * y0 + yp1;
  if (d === 0) return 0;
  return clamp((0.5 * (ym1 - yp1)) / d, -0.5, 0.5);
}

/** Fixed-capacity ring buffer of numbers. */
export class RingBuffer {
  private readonly buf: Float64Array;
  private head = 0;
  private count = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(x: number): void {
    this.buf[this.head] = x;
    this.head = (this.head + 1) % this.capacity;
    if (this.count < this.capacity) this.count++;
  }

  get length(): number {
    return this.count;
  }

  /** Oldest-to-newest copy of the last `n` values (or all). */
  toArray(n = this.count): Float64Array {
    const m = Math.min(n, this.count);
    const out = new Float64Array(m);
    let idx = (this.head - m + this.capacity) % this.capacity;
    for (let i = 0; i < m; i++) {
      out[i] = this.buf[idx];
      idx = (idx + 1) % this.capacity;
    }
    return out;
  }

  /** Value `k` steps back from the newest (0 = newest). */
  back(k: number): number {
    if (k >= this.count) return NaN;
    return this.buf[(this.head - 1 - k + this.capacity * 2) % this.capacity];
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
  }
}
