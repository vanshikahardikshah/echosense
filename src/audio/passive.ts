import { getFFT } from '../dsp/fft';

export type SoundClass = 'impact' | 'glass' | 'scream' | 'voice' | 'knock' | 'sustained' | 'other';

export interface AudioFeatures {
  t: number;
  /** Level of audible sound (60 Hz - 16 kHz), dB re full-scale sine RMS. */
  levelDb: number;
  /** Adaptive ambient floor, same units. */
  floorDb: number;
  low: number; // 60-400 Hz energy fraction
  mid: number; // 400-2500 Hz
  high: number; // 2.5-8 kHz
  air: number; // 8-16 kHz
  centroid: number; // Hz
  flatness: number; // 0..1
  flux: number; // dB, positive spectral change
  harmonicity: number; // 0..1
  f0: number; // Hz (0 when not harmonic)
  /** Log-mel energies (dB), 32 bands 60 Hz - 8 kHz: one spectrogram column. */
  mel: Float32Array;
}

export interface SoundEvent {
  t: number;
  cls: SoundClass;
  confidence: number;
  aboveFloorDb: number;
  peakDb: number;
  duration: number;
  /** True when the event is one of a regular series (music beat, hammering). */
  repetitive: boolean;
  evidence: string;
  /** What the sound recognition model heard around this event, when it is running. */
  ai?: { group: string; score: number; words: string; top: { name: string; score: number }[] };
  /** The model judged it harmless (a snap, a tap, talking, TV): not treated as an impact. */
  benign?: boolean;
  /** How long the phone held the event back before sending it (to wait for the model), ms. */
  lateMs?: number;
}

const MEL_BANDS = 32;

function hzToMel(f: number): number {
  return 2595 * Math.log10(1 + f / 700);
}
function melToHz(m: number): number {
  return 700 * (10 ** (m / 2595) - 1);
}

interface Segment {
  start: number;
  frames: AudioFeatures[];
  peakIdx: number;
  quietFrames: number;
}

/**
 * Passive acoustic event detection on the audible band (the sonar band above
 * 17.5 kHz is ignored, so the two sensing modes never interfere).
 *
 * Every frame yields interpretable features: band energy split, spectral
 * centroid and flatness, onset flux and autocorrelation harmonicity/pitch.
 * Onsets above an adaptive ambient floor are segmented and classified by their
 * acoustic structure: an impact is a sudden, short, low-frequency, inharmonic
 * burst; breaking glass is a sharp high-frequency ringing transient; a scream
 * is sustained, loud and strongly harmonic at a high pitch. Only features and
 * labels leave this module: raw audio is never stored or transmitted.
 */
export class PassiveAudio {
  private readonly n: number;
  private readonly fs: number;
  private readonly win: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private readonly pow: Float64Array;
  private readonly melW: { lo: number; hi: number; w: Float64Array }[] = [];
  private prevMel: Float32Array | null = null;
  private floorDb = NaN;
  private prevLevel = -120;
  private seg: Segment | null = null;
  private busyUntil = -1;
  private suppressUntil = -1;
  private recentImpacts: number[] = [];
  private readonly calib: number;
  private readonly kBand: (f: number) => number;

  constructor(fs: number, n: number) {
    this.fs = fs;
    this.n = n;
    this.win = new Float64Array(n);
    for (let i = 0; i < n; i++) this.win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * (i + 0.5)) / n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.pow = new Float64Array(n / 2 + 1);
    this.kBand = (f: number) => Math.min(n / 2, Math.max(0, Math.round((f * n) / fs)));
    const m0 = hzToMel(60);
    const m1 = hzToMel(8000);
    const edges = Array.from({ length: MEL_BANDS + 2 }, (_, i) => melToHz(m0 + ((m1 - m0) * i) / (MEL_BANDS + 1)));
    for (let b = 0; b < MEL_BANDS; b++) {
      const lo = this.kBand(edges[b]);
      const mid = this.kBand(edges[b + 1]);
      const hi = Math.max(mid + 1, this.kBand(edges[b + 2]));
      const w = new Float64Array(hi - lo + 1);
      for (let k = lo; k <= hi; k++) {
        w[k - lo] = k <= mid ? (k - lo + 1) / (mid - lo + 1) : (hi - k + 1) / (hi - mid + 1);
      }
      this.melW.push({ lo, hi, w });
    }
    // Calibrate so a full-scale 1 kHz sine reads -3.01 dB.
    const s = new Float64Array(n);
    for (let i = 0; i < n; i++) s[i] = Math.sin((2 * Math.PI * 1000 * i) / fs);
    this.calib = 0;
    const raw = this.bandPowerRaw(s);
    this.calib = -3.0103 - 10 * Math.log10(raw);
  }

  /** Ignore events until time t (e.g. while the phone itself is speaking). */
  suppress(untilT: number): void {
    this.suppressUntil = Math.max(this.suppressUntil, untilT);
    this.seg = null;
  }

  private bandPowerRaw(x: ArrayLike<number>): number {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      this.re[i] = x[i] * this.win[i];
      this.im[i] = 0;
    }
    getFFT(n).forward(this.re, this.im);
    for (let k = 0; k <= n / 2; k++) this.pow[k] = this.re[k] * this.re[k] + this.im[k] * this.im[k];
    let p = 0;
    for (let k = this.kBand(60); k <= this.kBand(16000); k++) p += this.pow[k];
    return p + 1e-30;
  }

  process(frame: ArrayLike<number>, t: number): { features: AudioFeatures; event: SoundEvent | null } {
    const total = this.bandPowerRaw(frame);
    const levelDb = 10 * Math.log10(total) + this.calib;
    const P = this.pow;
    const sum = (f0: number, f1: number) => {
      let s = 0;
      for (let k = this.kBand(f0); k < this.kBand(f1); k++) s += P[k];
      return s;
    };
    const low = sum(60, 400) / total;
    const mid = sum(400, 2500) / total;
    const high = sum(2500, 8000) / total;
    const air = sum(8000, 16000) / total;
    let cNum = 0;
    let cDen = 0;
    let logSum = 0;
    let linSum = 0;
    let cnt = 0;
    for (let k = this.kBand(60); k <= this.kBand(8000); k++) {
      const f = (k * this.fs) / this.n;
      cNum += f * P[k];
      cDen += P[k];
      if (f >= 200) {
        logSum += Math.log(P[k] + 1e-20);
        linSum += P[k];
        cnt++;
      }
    }
    const centroid = cNum / (cDen + 1e-30);
    const flatness = Math.exp(logSum / cnt) / (linSum / cnt + 1e-30);
    const mel = new Float32Array(MEL_BANDS);
    for (let b = 0; b < MEL_BANDS; b++) {
      const { lo, hi, w } = this.melW[b];
      let s = 0;
      for (let k = lo; k <= hi; k++) s += P[k] * w[k - lo];
      mel[b] = 10 * Math.log10(s + 1e-20) + this.calib;
    }
    let flux = 0;
    if (this.prevMel) for (let b = 0; b < MEL_BANDS; b++) flux += Math.max(0, mel[b] - this.prevMel[b]);
    flux /= MEL_BANDS;
    this.prevMel = mel;
    const { harmonicity, f0 } = this.pitch();

    if (Number.isNaN(this.floorDb)) this.floorDb = levelDb;
    // Asymmetric floor: drops quickly, rises slowly (about 15 s), so loud events don't raise it.
    const d = levelDb - this.floorDb;
    this.floorDb += d < 0 ? 0.08 * d : 0.0015 * Math.min(d, 20);
    const features: AudioFeatures = {
      t,
      levelDb,
      floorDb: this.floorDb,
      low,
      mid,
      high,
      air,
      centroid,
      flatness,
      flux,
      harmonicity,
      f0,
      mel,
    };
    const event = this.segment(features);
    this.prevLevel = levelDb;
    return { features, event };
  }

  /** Autocorrelation pitch from the power spectrum (Wiener-Khinchin), 60 Hz - 5 kHz only. */
  private pitch(): { harmonicity: number; f0: number } {
    const n = this.n;
    const re = this.re;
    const im = this.im;
    const k0 = this.kBand(60);
    const k1 = this.kBand(5000);
    re.fill(0);
    im.fill(0);
    for (let k = k0; k <= k1; k++) {
      re[k] = this.pow[k];
      re[n - k] = this.pow[k];
    }
    getFFT(n).inverse(re, im);
    const r0 = re[0] + 1e-30;
    const lagMin = Math.max(2, Math.floor(this.fs / 1100));
    const lagMax = Math.min(n / 2 - 2, Math.ceil(this.fs / 90));
    let best = 0;
    let bestLag = 0;
    for (let l = lagMin; l <= lagMax; l++) {
      if (re[l] > re[l - 1] && re[l] >= re[l + 1]) {
        // Compensate the Hann-window ACF taper so long lags are not penalised.
        const v = re[l] / r0 / Math.max(0.2, 1 - (1.5 * l) / n);
        if (v > best) {
          best = v;
          bestLag = l;
        }
      }
    }
    // Prefer the shortest lag nearly as good (avoid octave errors).
    if (bestLag > 0) {
      for (let l = lagMin; l < bestLag; l++) {
        if (re[l] > re[l - 1] && re[l] >= re[l + 1]) {
          const v = re[l] / r0 / Math.max(0.2, 1 - (1.5 * l) / n);
          if (v > 0.85 * best && Math.abs(bestLag / l - Math.round(bestLag / l)) < 0.08) {
            bestLag = l;
            best = v;
            break;
          }
        }
      }
    }
    const h = Math.min(1, Math.max(0, best));
    return { harmonicity: h, f0: h > 0.45 && bestLag > 0 ? this.fs / bestLag : 0 };
  }

  private segment(f: AudioFeatures): SoundEvent | null {
    const above = f.levelDb - f.floorDb;
    if (f.t < this.suppressUntil) return null;
    const frameDur = this.n / this.fs;
    if (!this.seg) {
      if (f.t < this.busyUntil) {
        if (above < 8) this.busyUntil = -1;
        return null;
      }
      const jump = f.levelDb - this.prevLevel;
      if (above >= 14 && (f.flux >= 4 || jump >= 8)) {
        this.seg = { start: f.t, frames: [f], peakIdx: 0, quietFrames: 0 };
      }
      return null;
    }
    const s = this.seg;
    s.frames.push(f);
    if (f.levelDb > s.frames[s.peakIdx].levelDb) s.peakIdx = s.frames.length - 1;
    const peak = s.frames[s.peakIdx];
    // End when the level falls 6 dB above floor or 20 dB below the peak.
    if (above < 6 || f.levelDb < peak.levelDb - 22) s.quietFrames++;
    else s.quietFrames = 0;
    const dur = s.frames.length * frameDur;
    if (s.quietFrames >= 3 || dur >= 2.0) {
      this.seg = null;
      const ev = this.classify(s, dur >= 2.0);
      if (dur >= 2.0) this.busyUntil = f.t + 30;
      return ev;
    }
    return null;
  }

  private classify(s: Segment, sustained: boolean): SoundEvent {
    const fr = s.frames;
    const frameDur = this.n / this.fs;
    const active = fr.slice(0, fr.length - s.quietFrames);
    const dur = Math.max(frameDur, active.length * frameDur);
    const peak = fr[s.peakIdx];
    const aboveFloor = peak.levelDb - peak.floorDb;
    const around = fr.slice(Math.max(0, s.peakIdx - 1), s.peakIdx + 2);
    const avg = (key: 'low' | 'mid' | 'high' | 'air' | 'flatness' | 'centroid') =>
      around.reduce((a, x) => a + x[key], 0) / around.length;
    const low = avg('low');
    const mid = avg('mid');
    const high = avg('high');
    const air = avg('air');
    const flat = avg('flatness');
    const attackFrames = s.peakIdx;
    const harmFrames = active.filter((x) => x.harmonicity > 0.55 && x.levelDb > x.floorDb + 10);
    const harmFrac = harmFrames.length / Math.max(1, active.length);
    const f0s = harmFrames.map((x) => x.f0).filter((v) => v > 0).sort((a, b) => a - b);
    const f0 = f0s.length ? f0s[f0s.length >> 1] : 0;
    // Decay: level drop from peak over the following 150 ms.
    const after = fr[Math.min(fr.length - 1, s.peakIdx + Math.round(0.15 / frameDur))];
    const decayDb = peak.levelDb - after.levelDb;

    let cls: SoundClass = 'other';
    let conf = 0.3;
    const ev: string[] = [
      `${aboveFloor.toFixed(0)} dB over ambient`,
      `${(dur * 1000).toFixed(0)} ms`,
      `low ${(low * 100).toFixed(0)}% / high ${((high + air) * 100).toFixed(0)}%`,
    ];
    const centroidPk = avg('centroid');
    const sharpHigh = high + air >= 0.7 || (high + air >= 0.5 && centroidPk >= 3500);
    const peakHarm = around.reduce((a, x) => a + x.harmonicity, 0) / around.length;
    if (sustained) {
      cls = harmFrac > 0.5 && f0 > 350 && aboveFloor > 18 && !sharpHigh ? 'scream' : 'sustained';
      conf = cls === 'scream' ? 0.6 : 0.4;
    } else if (sharpHigh && dur >= 0.1 && aboveFloor >= 15) {
      cls = 'glass';
      conf = Math.min(0.9, 0.35 + 0.8 * (high + air - 0.5) + 0.01 * (aboveFloor - 15));
      ev.push('sharp high-frequency ringing');
    } else if (
      low + mid >= 0.6 &&
      (low >= 0.45 || (low >= 0.25 && peakHarm < 0.4)) &&
      attackFrames <= 3 &&
      dur <= 0.9 &&
      aboveFloor >= 18 &&
      (decayDb >= 8 || (low >= 0.6 && decayDb >= 4))
    ) {
      // Impacts may ring (doors, furniture) so harmonicity is not held against them.
      cls = 'impact';
      conf = Math.min(0.95, 0.45 + 0.5 * (low - 0.25) + 0.015 * (aboveFloor - 18) + 0.01 * Math.min(decayDb, 20));
      ev.push(`decays ${decayDb.toFixed(0)} dB in 150 ms`);
    } else if (harmFrac >= 0.5 && dur >= 0.35 && f0 >= 350 && aboveFloor >= 18) {
      cls = 'scream';
      conf = Math.min(0.95, 0.5 + 0.3 * harmFrac + 0.01 * (aboveFloor - 18));
      ev.push(`harmonic ${(harmFrac * 100).toFixed(0)}% at ${f0.toFixed(0)} Hz`);
    } else if (harmFrac >= 0.35 && f0 > 0 && dur >= 0.15) {
      cls = 'voice';
      conf = 0.5 + 0.3 * harmFrac;
      ev.push(`pitch ${f0.toFixed(0)} Hz`);
    } else if (dur <= 0.25 && attackFrames <= 2 && flat >= 0.15) {
      cls = 'knock';
      conf = 0.5;
    }
    // Regular series of transients (music beat, hammering) are not incidents.
    let repetitive = false;
    if (cls === 'impact' || cls === 'knock') {
      this.recentImpacts = this.recentImpacts.filter((x) => s.start - x < 8);
      this.recentImpacts.push(s.start);
      repetitive = this.recentImpacts.length >= 3;
      if (repetitive) {
        conf *= 0.4;
        ev.push('part of a repeating pattern');
      }
    }
    return {
      t: s.start,
      cls,
      confidence: Math.max(0, Math.min(1, conf)),
      aboveFloorDb: aboveFloor,
      peakDb: peak.levelDb,
      duration: dur,
      repetitive,
      evidence: ev.join(', '),
    };
  }
}
