import { DirectPathAligner } from './aligner';
import { BreathingAnalyzer, BreathingEstimate } from './breathing';
import { Band, ChirpDesign, choosePeriod, designChirp, speedOfSound } from './chirp';
import { Biquad, BiquadBank, emaAlpha, percentile } from './filters';
import { MatchedFilter } from './matchedFilter';
import { RangeDopplerImage, RangeDopplerMap } from './rangeDoppler';
import { Detection, RangeTracker, Track } from './tracker';

export interface SonarConfig {
  fs: number;
  band: Band;
  /** Chirp period in samples (power of two). Defaults to the smallest giving >= 3.5 m of range. */
  period?: number;
  maxRange: number;
  minRange: number;
  tempC: number;
  phaseReference: boolean;
  /** Detection threshold on clutter-removed SNR, dB. */
  detectDb: number;
  /** Doppler-high-passed motion level (dB over floor) above which motion counts as gross body motion. */
  grossMotionDb: number;
  displayCells: number;
}

export const DEFAULT_SONAR: Omit<SonarConfig, 'fs' | 'band'> = {
  maxRange: 3.2,
  minRange: 0.2,
  tempC: 21,
  phaseReference: true,
  detectDb: 12,
  grossMotionDb: 12,
  displayCells: 96,
};

export type SonarPhase = 'acquiring' | 'equalizing' | 'learning' | 'running';

export interface SonarFrame {
  t: number;
  index: number;
  phase: SonarPhase;
  locked: boolean;
  /** Direct path amplitude, dB re full-scale chirp. */
  directDb: number;
  /** Direct path over the profile noise floor, dB: a health metric for speaker/mic coupling. */
  linkSnrDb: number;
  detections: Detection[];
  tracks: Track[];
  primary: Track | null;
  /** Strongest clutter-removed echo in the sensing zone, dB over the per-bin noise floor. */
  motionDb: number;
  /** Fraction of zone bins above the detection threshold (whole-body motion is wide). */
  motionSpread: number;
  /** Change of the static scene in the last ~20 s, dB over noise (someone new and still). */
  staticChangeDb: number;
  staticChangeRange: number;
  /** Doppler-high-passed (fast) motion, dB over floor: walking, gestures, falls. */
  fastMotionDb: number;
  /** Range of the strongest fast motion, metres. */
  fastMotionRange: number;
  /** Frame discarded because of a broadband acoustic transient (outputs are held). */
  interference: boolean;
  grossMotion: boolean;
  /** Clutter-removed SNR (dB) per display cell from 0 to maxRange: one echogram row. */
  echoRow: Float32Array;
  /** Aligned raw profile magnitude (dB re direct path) per display cell. */
  profileRow: Float32Array;
  breathing: BreathingEstimate;
  realigned: boolean;
}

/**
 * Real-time active sonar: chirp design, matched filtering, direct-path
 * alignment, clutter removal, adaptive per-bin noise floors, peak detection,
 * multi-target tracking, respiration and range-Doppler imaging.
 */
export class SonarProcessor {
  readonly cfg: SonarConfig;
  readonly design: ChirpDesign;
  readonly n: number;
  readonly fps: number;
  readonly c: number;
  readonly binRange: number;
  readonly minBin: number;
  readonly maxBin: number;
  readonly resolutionBins: number;
  readonly wavelength: number;

  private readonly mf: MatchedFilter;
  private readonly aligner: DirectPathAligner;
  private readonly tracker: RangeTracker;
  private readonly breathingAnalyzer: BreathingAnalyzer;
  private readonly rd: RangeDopplerMap;
  private readonly rdStartBin: number;

  private readonly frameBuf: Float64Array;
  private fill = 0;
  private readonly rawRe: Float64Array;
  private readonly rawIm: Float64Array;
  private readonly alRe: Float64Array;
  private readonly alIm: Float64Array;
  private readonly bgRe: Float64Array;
  private readonly bgIm: Float64Array;
  private readonly slowRe: Float64Array;
  private readonly slowIm: Float64Array;
  private readonly dynRe: Float64Array;
  private readonly dynIm: Float64Array;
  private readonly noise: Float64Array;
  private readonly prevRe: Float64Array;
  private readonly prevIm: Float64Array;
  private readonly hpA: BiquadBank;
  private readonly lastAlRe: Float64Array;
  private readonly lastAlIm: Float64Array;
  private readonly gapRe: Float64Array;
  private readonly gapIm: Float64Array;
  private gapFrames = 0;
  private readonly hpB: BiquadBank;
  private readonly diffNoise: Float64Array;
  private readonly fastSmooth: Float64Array;
  private readonly fastTmp: Float64Array;
  private learnDiff: Float32Array | null = null;
  private readonly prevRawRe: Float64Array;
  private readonly prevRawIm: Float64Array;
  private haveRaw = false;
  private impulseFloor = 0;
  private guardFloor = 0;
  private guardHigh = 0;
  private impulseHigh = 0;
  private blankFrames = 0;
  private lastGood: SonarFrame | null = null;
  /** Count of frames discarded because of broadband acoustic interference. */
  blankedFrames = 0;
  private readonly snr: Float64Array;
  private readonly snr2: Float64Array;
  private readonly smooth: Float64Array;
  private learnBuf: Float32Array | null = null;
  private eqAcc: Float64Array | null = null;
  private eqCount = 0;
  private readonly eqFrames: number;
  /** Measured speaker+mic magnitude response across the band (after equalisation phase). */
  channelResponse: Float64Array | null = null;
  equalize = true;
  private learnCount = 0;
  private readonly learnFrames: number;
  private bgInit = false;
  private readonly aBg: number;
  private readonly aSlow: number;
  private readonly aNoise: number;
  private frameIndex = 0;
  private phase: SonarPhase = 'acquiring';
  private linkSnrDb = 0;
  private rdCache: RangeDopplerImage | null = null;

  constructor(cfg: Partial<SonarConfig> & { fs: number; band: Band }) {
    this.cfg = { ...DEFAULT_SONAR, ...cfg } as SonarConfig;
    const { fs } = this.cfg;
    this.c = speedOfSound(this.cfg.tempC);
    this.n = this.cfg.period ?? choosePeriod(fs, 3.5, this.c);
    this.design = designChirp(fs, this.n, this.cfg.band);
    this.fps = fs / this.n;
    this.binRange = this.c / (2 * fs);
    this.wavelength = this.c / this.design.fc;
    this.minBin = Math.max(1, Math.round(this.cfg.minRange / this.binRange));
    const unambiguous = Math.floor(this.n * 0.92);
    this.maxBin = Math.min(unambiguous, Math.round(this.cfg.maxRange / this.binRange));
    this.mf = new MatchedFilter(this.design);
    this.resolutionBins = 2 * this.mf.psfHalfWidth;
    this.aligner = new DirectPathAligner(this.n);
    this.tracker = new RangeTracker(this.fps, undefined, this.mf.dopplerRangeCoupling);
    this.breathingAnalyzer = new BreathingAnalyzer(
      this.fps,
      Math.max(this.minBin, Math.round(0.25 / this.binRange)),
      Math.min(this.maxBin, Math.round(2.2 / this.binRange)),
      (b) => b * this.binRange,
    );
    const binsPerCell = Math.max(1, Math.round(this.resolutionBins / 3));
    this.rdStartBin = this.minBin;
    const rdCells = Math.floor((this.maxBin - this.minBin) / binsPerCell);
    this.rd = new RangeDopplerMap(rdCells, binsPerCell, 64, this.fps, this.wavelength, this.cfg.maxRange);

    const m = this.maxBin + 1;
    this.frameBuf = new Float64Array(this.n);
    this.prevRawRe = new Float64Array(this.n);
    this.prevRawIm = new Float64Array(this.n);
    this.rawRe = new Float64Array(this.n);
    this.rawIm = new Float64Array(this.n);
    this.alRe = new Float64Array(m);
    this.alIm = new Float64Array(m);
    this.bgRe = new Float64Array(m);
    this.bgIm = new Float64Array(m);
    this.slowRe = new Float64Array(m);
    this.slowIm = new Float64Array(m);
    this.dynRe = new Float64Array(m);
    this.dynIm = new Float64Array(m);
    this.noise = new Float64Array(m);
    this.prevRe = new Float64Array(m);
    this.prevIm = new Float64Array(m);
    this.lastAlRe = new Float64Array(m);
    this.lastAlIm = new Float64Array(m);
    this.gapRe = new Float64Array(m);
    this.gapIm = new Float64Array(m);
    // 4th-order Butterworth high-pass at 6 Hz in slow time (two biquads).
    this.hpA = new BiquadBank(Biquad.highpass(this.fps, 6, 0.5412), 2 * m);
    this.hpB = new BiquadBank(Biquad.highpass(this.fps, 6, 1.3066), 2 * m);
    this.diffNoise = new Float64Array(m);
    this.fastSmooth = new Float64Array(m);
    this.fastTmp = new Float64Array(m);
    this.snr = new Float64Array(m);
    this.snr2 = new Float64Array(m);
    this.smooth = new Float64Array(m);
    this.learnFrames = Math.round(3 * this.fps);
    this.eqFrames = Math.round(0.6 * this.fps);
    this.aBg = emaAlpha(1.0, this.fps);
    this.aSlow = emaAlpha(20, this.fps);
    this.aNoise = emaAlpha(10, this.fps);
  }

  get currentPhase(): SonarPhase {
    return this.phase;
  }

  /** Period of the transmit signal (to be looped by the audio output). */
  get txPeriod(): Float32Array {
    return Float32Array.from(this.design.samples);
  }

  rangeOfBin(bin: number): number {
    return bin * this.binRange;
  }

  /** Restart alignment and learning (e.g. after the phone was moved). */
  restart(): void {
    this.aligner.reset();
    this.tracker.reset();
    this.breathingAnalyzer.reset();
    this.rd.reset();
    this.mf.reset();
    this.phase = 'acquiring';
    this.bgInit = false;
    this.learnBuf = null;
    this.learnCount = 0;
    this.eqAcc = null;
    this.rdCache = null;
  }

  /** Feed microphone samples; calls onFrame for every completed chirp period. */
  pushSamples(x: ArrayLike<number>, onFrame: (f: SonarFrame) => void): void {
    let i = 0;
    while (i < x.length) {
      const take = Math.min(this.n - this.fill, x.length - i);
      for (let j = 0; j < take; j++) this.frameBuf[this.fill + j] = x[i + j];
      this.fill += take;
      i += take;
      if (this.fill === this.n) {
        this.fill = 0;
        onFrame(this.processFrame(this.frameBuf));
      }
    }
  }

  /** In-band microphone power of the last frame (for ambient-noise calibration). */
  inBandPower(frame: ArrayLike<number>): number {
    return this.mf.inBandPower(frame);
  }

  rangeDoppler(): RangeDopplerImage | null {
    if (!this.rd.ready) return this.rdCache;
    this.rdCache = this.rd.compute();
    return this.rdCache;
  }

  processFrame(frame: ArrayLike<number>): SonarFrame {
    const t = this.frameIndex / this.fps;
    const index = this.frameIndex++;
    this.mf.process(frame, this.rawRe, this.rawIm);
    const al = this.aligner.observe(this.rawRe, this.rawIm);
    const cells = this.cfg.displayCells;
    const empty = (): SonarFrame => ({
      t,
      index,
      phase: this.phase,
      locked: al.locked,
      directDb: al.directAmp > 0 ? 20 * Math.log10(al.directAmp) : -120,
      linkSnrDb: this.linkSnrDb,
      detections: [],
      tracks: [],
      primary: null,
      motionDb: 0,
      motionSpread: 0,
      staticChangeDb: 0,
      staticChangeRange: 0,
      fastMotionDb: 0,
      fastMotionRange: 0,
      interference: false,
      grossMotion: false,
      echoRow: new Float32Array(cells),
      profileRow: new Float32Array(cells),
      breathing: this.breathingAnalyzer.current,
      realigned: al.changed,
    });
    if (!al.locked) {
      this.phase = 'acquiring';
      this.haveRaw = false;
      return empty();
    }
    // Impulse blanking. Keys, crinkling plastic, hard impacts and some music
    // carry real ultrasonic energy. A broadband burst raises the frame-to-frame
    // change at every lag at once, including lags where no target can be, so
    // we watch the median change beyond the sensing range and discard (hold)
    // corrupted frames instead of letting them create phantom motion.
    const interference = this.checkImpulse(al.offset);
    if (interference && !al.changed && this.phase !== 'acquiring') {
      this.blankedFrames++;
      if (this.bgInit) this.gapFrames++;
      const held = this.lastGood ? { ...this.lastGood } : empty();
      held.t = t;
      held.index = index;
      held.phase = this.phase;
      held.grossMotion = false;
      held.interference = true;
      held.realigned = false;
      return held;
    }
    if (al.changed) {
      // Latency changed: every per-bin history is now misaligned.
      this.bgInit = false;
      this.tracker.reset();
      this.breathingAnalyzer.reset();
      this.rd.reset();
      if (this.phase === 'acquiring') {
        if (this.equalize) {
          this.phase = 'equalizing';
          this.eqAcc = new Float64Array(this.design.kHi - this.design.kLo + 1);
          this.eqCount = 0;
        } else this.beginLearning();
      }
    }
    if (this.phase === 'equalizing') {
      const mags = this.mf.bandMagnitudes(frame);
      for (let i = 0; i < mags.length; i++) this.eqAcc![i] += mags[i];
      this.eqCount++;
      if (this.eqCount >= this.eqFrames) {
        const acc = this.eqAcc!;
        // Smooth across bins: static echoes add a comb ripple on top of the speaker response.
        const sm = new Float64Array(acc.length);
        for (let i = 0; i < acc.length; i++) {
          let s = 0;
          let c = 0;
          for (let j = Math.max(0, i - 3); j <= Math.min(acc.length - 1, i + 3); j++) {
            s += acc[j];
            c++;
          }
          sm[i] = s / c / this.eqCount;
        }
        this.channelResponse = sm;
        const inv = new Float64Array(sm.length);
        for (let i = 0; i < sm.length; i++) inv[i] = 1 / Math.max(sm[i], 1e-9);
        this.mf.setEqualizer(inv);
        this.eqAcc = null;
        this.beginLearning();
      }
      const f = empty();
      f.phase = this.phase;
      return f;
    }
    this.updateLinkSnr(al.directAmp);
    const m = this.maxBin + 1;
    this.aligner.rotate(this.rawRe, this.rawIm, this.alRe, this.alIm, m, this.cfg.phaseReference);

    if (!this.bgInit) {
      this.bgRe.set(this.alRe);
      this.bgIm.set(this.alIm);
      this.slowRe.set(this.alRe);
      this.slowIm.set(this.alIm);
      this.prevRe.set(this.alRe);
      this.prevIm.set(this.alIm);
      this.lastAlRe.set(this.alRe);
      this.lastAlIm.set(this.alIm);
      this.hpA.reset();
      this.hpB.reset();
      this.fastSmooth.fill(0);
      this.gapFrames = 0;
      this.bgInit = true;
    }
    // Bridge frames discarded by impulse blanking with interpolated profiles so
    // every slow-time filter (Doppler high-pass, backgrounds, breathing,
    // tracker) keeps a uniform timebase and sees no artificial step.
    if (this.gapFrames > 0) {
      const g = Math.min(this.gapFrames, 12);
      for (let j = 1; j <= g; j++) {
        const u = j / (g + 1);
        for (let k = 0; k < m; k++) {
          this.gapRe[k] = this.lastAlRe[k] + (this.alRe[k] - this.lastAlRe[k]) * u;
          this.gapIm[k] = this.lastAlIm[k] + (this.alIm[k] - this.lastAlIm[k]) * u;
        }
        this.advance(this.gapRe, this.gapIm);
        this.breathingAnalyzer.update(this.gapRe, this.gapIm, false);
        if (this.phase === 'running') {
          this.rd.push(this.dynRe, this.dynIm, this.rdStartBin);
          this.tracker.update([]);
        }
      }
      this.gapFrames = 0;
    }
    this.advance(this.alRe, this.alIm);
    this.lastAlRe.set(this.alRe);
    this.lastAlIm.set(this.alIm);

    if (this.phase === 'learning') {
      const buf = this.learnBuf!;
      const lbd = this.learnDiff!;
      for (let k = 0; k < m; k++) {
        buf[k * this.learnFrames + this.learnCount] = this.dynRe[k] ** 2 + this.dynIm[k] ** 2;
        lbd[k * this.learnFrames + this.learnCount] = this.fastTmp[k];
      }
      this.learnCount++;
      // Keep the breathing analyser warm while learning.
      this.breathingAnalyzer.update(this.alRe, this.alIm, false);
      if (this.learnCount >= this.learnFrames) {
        // Robust per-bin floor: 40th percentile ignores brief motion during learning.
        const tmp = new Float32Array(this.learnFrames);
        for (let k = 0; k < m; k++) {
          for (let j = 0; j < this.learnFrames; j++) tmp[j] = buf[k * this.learnFrames + j];
          this.noise[k] = Math.max(percentile(tmp, 40), 1e-14);
          for (let j = 0; j < this.learnFrames; j++) tmp[j] = lbd[k * this.learnFrames + j];
          this.diffNoise[k] = Math.max(percentile(tmp, 50), 1e-14);
        }
        this.smoothNoiseFloor();
        this.learnBuf = null;
        this.learnDiff = null;
        this.phase = 'running';
      }
      const f = empty();
      f.phase = this.phase;
      return f;
    }

    // Per-bin SNR against an adaptive floor; the floor only learns from quiet bins.
    for (let k = 0; k < m; k++) {
      const p = this.dynRe[k] ** 2 + this.dynIm[k] ** 2;
      const s = p / this.noise[k];
      this.snr[k] = s;
      const an = s < 4 ? this.aNoise : this.aNoise * 0.02;
      this.noise[k] += an * (p - this.noise[k]);
      if (this.noise[k] < 1e-14) this.noise[k] = 1e-14;
    }
    this.whiten(this.snr);
    const w = Math.max(1, Math.round(this.resolutionBins / 4));
    this.boxcar(this.snr, this.smooth, w);

    const detections = this.detect();
    let maxS = 0;
    let above = 0;
    const thr = 10 ** (this.cfg.detectDb / 10);
    for (let k = this.minBin; k <= this.maxBin; k++) {
      if (this.smooth[k] > maxS) maxS = this.smooth[k];
      if (this.smooth[k] > thr) above++;
    }
    const motionSpread = above / (this.maxBin - this.minBin + 1);
    const motionDb = 10 * Math.log10(Math.max(maxS, 1e-6));

    // Fast (Doppler high-passed) motion, smoothed over range and ~0.15 s.
    for (let k = 0; k < m; k++) {
      const p = this.fastTmp[k];
      const s = p / this.diffNoise[k];
      const an = s < 4 ? this.aNoise : this.aNoise * 0.02;
      this.diffNoise[k] += an * (p - this.diffNoise[k]);
      if (this.diffNoise[k] < 1e-14) this.diffNoise[k] = 1e-14;
      this.fastTmp[k] = s;
    }
    this.whiten(this.fastTmp);
    this.boxcar(this.fastTmp, this.snr2, w);
    let maxF = 0;
    let maxFBin = 0;
    const af = 0.25;
    for (let k = this.minBin; k <= this.maxBin; k++) {
      this.fastSmooth[k] += af * (this.snr2[k] - this.fastSmooth[k]);
      if (this.fastSmooth[k] > maxF) {
        maxF = this.fastSmooth[k];
        maxFBin = k;
      }
    }
    const fastMotionDb = 10 * Math.log10(Math.max(maxF, 1e-6));
    const grossMotion = fastMotionDb > this.cfg.grossMotionDb;

    const tracks = this.tracker.update(detections);
    const primary = this.tracker.primary();
    this.breathingAnalyzer.update(this.alRe, this.alIm, grossMotion, maxFBin * this.binRange);
    this.rd.push(this.dynRe, this.dynIm, this.rdStartBin);

    // Static scene change (fast vs slow background).
    let sc = 0;
    let scBin = 0;
    for (let k = this.minBin; k <= this.maxBin; k++) {
      const v = ((this.bgRe[k] - this.slowRe[k]) ** 2 + (this.bgIm[k] - this.slowIm[k]) ** 2) / this.noise[k];
      if (v > sc) {
        sc = v;
        scBin = k;
      }
    }

    const echoRow = new Float32Array(cells);
    const profileRow = new Float32Array(cells);
    const ref = Math.hypot(this.alRe[0], this.alIm[0]) + 1e-30;
    for (let c = 0; c < cells; c++) {
      const k0 = Math.floor((c * this.maxBin) / cells);
      const k1 = Math.max(k0 + 1, Math.floor(((c + 1) * this.maxBin) / cells));
      let mx = 0;
      let pm = 0;
      for (let k = k0; k < k1; k++) {
        if (k >= this.minBin && this.smooth[k] > mx) mx = this.smooth[k];
        const mag = Math.hypot(this.alRe[k], this.alIm[k]);
        if (mag > pm) pm = mag;
      }
      echoRow[c] = 10 * Math.log10(Math.max(mx, 1));
      profileRow[c] = 20 * Math.log10(pm / ref + 1e-9);
    }

    const out: SonarFrame = {
      t,
      index,
      phase: this.phase,
      locked: true,
      directDb: 20 * Math.log10(al.directAmp + 1e-12),
      linkSnrDb: this.linkSnrDb,
      detections,
      tracks,
      primary,
      motionDb,
      motionSpread,
      staticChangeDb: 10 * Math.log10(Math.max(sc, 1e-6)),
      staticChangeRange: scBin * this.binRange,
      fastMotionDb,
      fastMotionRange: maxFBin * this.binRange,
      interference: false,
      grossMotion,
      echoRow,
      profileRow,
      breathing: this.breathingAnalyzer.current,
      realigned: al.changed,
    };
    this.lastGood = out;
    return out;
  }

  /** True when this frame (or the next, which shares its correlation window) is corrupted. */
  private checkImpulse(offset: number): boolean {
    const n = this.n;
    let bad = false;
    // Primary detector: energy in the guard bands beside the sonar band. The
    // transmit waveform is strictly band-limited, so anything there is
    // acoustic interference, and it is measured over the exact two-frame
    // window this output was computed from.
    const gp = this.mf.lastGuardPower + 1e-30;
    if (this.guardFloor === 0) this.guardFloor = gp;
    if (gp > 3 * this.guardFloor) {
      // A burst is brief. A level that stays up for ~0.85 s is a new steady
      // source (typically another phone starting its own sonar in the next
      // band), so accept it as the new background instead of blanking forever.
      if (++this.guardHigh >= 40) {
        this.guardFloor = gp;
        this.guardHigh = 0;
      } else bad = true;
    } else {
      this.guardHigh = 0;
      this.guardFloor += 0.05 * (gp - this.guardFloor);
    }
    if (this.haveRaw) {
      const vals: number[] = [];
      // Stop well short of the direct path's leading sidelobes (lags just below n).
      const end = n - 4 * this.mf.psfHalfWidth;
      for (let k = this.maxBin + 8; k < end; k += 2) {
        const j = (offset + k) % n;
        vals.push((this.rawRe[j] - this.prevRawRe[j]) ** 2 + (this.rawIm[j] - this.prevRawIm[j]) ** 2);
      }
      if (vals.length > 4) {
        vals.sort((a, b) => a - b);
        // Lower quartile: a person walking near the edge of range occupies some
        // of these lags, a broadband burst raises all of them.
        const med = vals[vals.length >> 2] + 1e-30;
        if (this.impulseFloor === 0) this.impulseFloor = med;
        if (med > 6 * this.impulseFloor && ++this.impulseHigh >= 40) {
          // Persistent, not a burst: re-baseline.
          this.impulseFloor = med;
          this.impulseHigh = 0;
        } else if (med > 6 * this.impulseFloor) {
          bad = true;
          // The correlation window spans two frames: blank the next one too.
          this.blankFrames = 1;
        } else {
          this.impulseHigh = 0;
          if (!bad) this.impulseFloor += 0.03 * (med - this.impulseFloor);
          if (this.blankFrames > 0) {
            this.blankFrames--;
            bad = true;
          }
        }
      }
    }
    this.prevRawRe.set(this.rawRe);
    this.prevRawIm.set(this.rawIm);
    this.haveRaw = true;
    return bad;
  }

  /**
   * Per-frame state update shared by real and gap-filling frames: slow-time
   * Doppler high-pass (4th order at 6 Hz: passes walking, gestures and falls,
   * suppresses breathing and swaying by ~60 dB) into fastTmp, and the fast
   * (1 s) and slow (20 s) clutter backgrounds into dyn.
   */
  private advance(re: Float64Array, im: Float64Array): void {
    const m = this.maxBin + 1;
    for (let k = 0; k < m; k++) {
      const yr = this.hpB.process(2 * k, this.hpA.process(2 * k, re[k] - this.prevRe[k]));
      const yi = this.hpB.process(2 * k + 1, this.hpA.process(2 * k + 1, im[k] - this.prevIm[k]));
      this.fastTmp[k] = yr * yr + yi * yi;
    }
    const a = this.aBg;
    const as = this.aSlow;
    for (let k = 0; k < m; k++) {
      const dr = re[k] - this.bgRe[k];
      const di = im[k] - this.bgIm[k];
      this.dynRe[k] = dr;
      this.dynIm[k] = di;
      this.bgRe[k] += a * dr;
      this.bgIm[k] += a * di;
      this.slowRe[k] += as * (re[k] - this.slowRe[k]);
      this.slowIm[k] += as * (im[k] - this.slowIm[k]);
    }
  }

  private beginLearning(): void {
    this.phase = 'learning';
    this.bgInit = false;
    this.learnBuf = new Float32Array((this.maxBin + 1) * this.learnFrames);
    this.learnDiff = new Float32Array((this.maxBin + 1) * this.learnFrames);
    this.learnCount = 0;
  }

  private updateLinkSnr(directAmp: number): void {
    // Floor: median magnitude beyond the sensing range (wrapped late reverberation + noise).
    const n = this.n;
    const start = this.maxBin + 8;
    const vals: number[] = [];
    for (let k = start; k < n - 8; k += 3) {
      const j = (this.aligner.offset + k) % n;
      vals.push(Math.hypot(this.rawRe[j], this.rawIm[j]));
    }
    if (vals.length === 0) return;
    vals.sort((x, y) => x - y);
    const floor = vals[vals.length >> 1] + 1e-12;
    const snr = 20 * Math.log10(directAmp / floor);
    this.linkSnrDb = this.linkSnrDb === 0 ? snr : this.linkSnrDb + 0.05 * (snr - this.linkSnrDb);
  }

  /**
   * Spatial whitening: residual acoustic noise in the sonar band lifts every
   * range bin together, while a person lifts only a few. Normalising by the
   * zone median (when it is elevated) removes the uniform part.
   */
  private whiten(x: Float64Array): void {
    const vals: number[] = [];
    for (let k = this.minBin; k <= this.maxBin; k += 3) vals.push(x[k]);
    vals.sort((a, b) => a - b);
    const med = vals[vals.length >> 1];
    if (med > 1.5) {
      const g = 1 / med;
      for (let k = 0; k < x.length; k++) x[k] *= g;
    }
  }

  private smoothNoiseFloor(): void {
    // Light smoothing across range: adjacent bins share the same physics.
    const m = this.maxBin + 1;
    const tmp = Float64Array.from(this.noise);
    for (let k = 0; k < m; k++) {
      let s = 0;
      let c = 0;
      for (let j = Math.max(0, k - 2); j <= Math.min(m - 1, k + 2); j++) {
        s += tmp[j];
        c++;
      }
      this.noise[k] = Math.max(tmp[k], (0.5 * s) / c);
    }
  }

  private boxcar(src: Float64Array, dst: Float64Array, half: number): void {
    const m = src.length;
    let acc = 0;
    let cnt = 0;
    for (let k = 0; k < Math.min(m, half); k++) {
      acc += src[k];
      cnt++;
    }
    for (let k = 0; k < m; k++) {
      const add = k + half;
      if (add < m) {
        acc += src[add];
        cnt++;
      }
      const rem = k - half - 1;
      if (rem >= 0) {
        acc -= src[rem];
        cnt--;
      }
      dst[k] = acc / cnt;
    }
  }

  private detect(): Detection[] {
    const s = this.smooth;
    const thr = 10 ** (this.cfg.detectDb / 10);
    const res = this.resolutionBins;
    const guard = res;
    const train = res * 3;
    const out: Detection[] = [];
    for (let k = this.minBin; k <= this.maxBin; k++) {
      if (s[k] < thr) continue;
      let isMax = true;
      for (let j = Math.max(this.minBin, k - res); j <= Math.min(this.maxBin, k + res); j++) {
        if (s[j] > s[k] || (s[j] === s[k] && j < k)) {
          isMax = false;
          break;
        }
      }
      if (!isMax) continue;
      // Cell-averaging CFAR on both sides beyond a guard band.
      let acc = 0;
      let cnt = 0;
      for (let j = k - guard - train; j <= k + guard + train; j++) {
        if (Math.abs(j - k) <= guard || j < this.minBin || j > this.maxBin) continue;
        acc += s[j];
        cnt++;
      }
      const local = cnt > 0 ? acc / cnt : 0;
      if (s[k] < 1.5 * local) continue;
      // Sub-bin centroid over the mainlobe.
      let wsum = 0;
      let rsum = 0;
      let lo = k;
      let hi = k;
      for (let j = Math.max(this.minBin, k - (res >> 1)); j <= Math.min(this.maxBin, k + (res >> 1)); j++) {
        const wgt = Math.max(0, s[j] - thr * 0.5);
        wsum += wgt;
        rsum += wgt * j;
      }
      while (lo > this.minBin && s[lo - 1] > thr * 0.5) lo--;
      while (hi < this.maxBin && s[hi + 1] > thr * 0.5) hi++;
      const bin = wsum > 0 ? rsum / wsum : k;
      out.push({
        range: bin * this.binRange,
        snrDb: 10 * Math.log10(s[k]),
        power: s[k],
        bin,
        width: (hi - lo + 1) * this.binRange,
      });
    }
    out.sort((a, b) => b.snrDb - a.snrDb);
    return out.slice(0, 6);
  }
}
