import { getFFT } from './fft';

export interface RangeDopplerImage {
  cells: number;
  dopplerBins: number;
  /** cells x dopplerBins, row-major by range cell, dB, Doppler centred (index dopplerBins/2 = 0 m/s). */
  db: Float32Array;
  /** Range-rate in m/s at each Doppler column (negative = approaching). */
  velocities: Float32Array;
  maxRange: number;
}

/**
 * Slow-time FFT over the clutter-removed profile history: every column is a
 * radial velocity, every row a range cell. Walking, sitting down and falling
 * leave distinct micro-Doppler signatures that the range-only view hides.
 */
export class RangeDopplerMap {
  private readonly histRe: Float32Array;
  private readonly histIm: Float32Array;
  private head = 0;
  private filled = 0;
  private readonly win: Float64Array;

  constructor(
    private readonly cells: number,
    private readonly binsPerCell: number,
    private readonly frames: number,
    private readonly fps: number,
    private readonly wavelength: number,
    private readonly maxRange: number,
  ) {
    this.histRe = new Float32Array(cells * frames);
    this.histIm = new Float32Array(cells * frames);
    this.win = new Float64Array(frames);
    for (let i = 0; i < frames; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / frames);
  }

  reset(): void {
    this.histRe.fill(0);
    this.histIm.fill(0);
    this.head = 0;
    this.filled = 0;
  }

  /** dynRe/dynIm: aligned, clutter-removed profile starting at bin `startBin`. */
  push(dynRe: Float64Array, dynIm: Float64Array, startBin: number): void {
    for (let c = 0; c < this.cells; c++) {
      let sr = 0;
      let si = 0;
      const b0 = startBin + c * this.binsPerCell;
      for (let j = 0; j < this.binsPerCell; j++) {
        sr += dynRe[b0 + j];
        si += dynIm[b0 + j];
      }
      this.histRe[c * this.frames + this.head] = sr;
      this.histIm[c * this.frames + this.head] = si;
    }
    this.head = (this.head + 1) % this.frames;
    if (this.filled < this.frames) this.filled++;
  }

  get ready(): boolean {
    return this.filled >= this.frames;
  }

  compute(): RangeDopplerImage {
    const M = this.frames;
    const fft = getFFT(M);
    const re = new Float64Array(M);
    const im = new Float64Array(M);
    const out = new Float32Array(this.cells * M);
    for (let c = 0; c < this.cells; c++) {
      let idx = this.head;
      for (let i = 0; i < M; i++) {
        re[i] = this.histRe[c * M + idx] * this.win[i];
        im[i] = this.histIm[c * M + idx] * this.win[i];
        idx = (idx + 1) % M;
      }
      fft.forward(re, im);
      for (let k = 0; k < M; k++) {
        const shifted = (k + M / 2) % M; // fftshift
        out[c * M + shifted] = 10 * Math.log10(re[k] * re[k] + im[k] * im[k] + 1e-24);
      }
    }
    const velocities = new Float32Array(M);
    for (let j = 0; j < M; j++) {
      const fd = ((j - M / 2) * this.fps) / M;
      // Approaching targets advance the echo phase (positive Doppler) but shrink range.
      velocities[j] = (-fd * this.wavelength) / 2;
    }
    return { cells: this.cells, dopplerBins: M, db: out, velocities, maxRange: this.maxRange };
  }
}
