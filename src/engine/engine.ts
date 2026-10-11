import { AudioFeatures, PassiveAudio, SoundEvent } from '../audio/passive';
import { Band, WIDE_BAND } from '../dsp/chirp';
import { RangeDopplerImage } from '../dsp/rangeDoppler';
import { SonarFrame, SonarProcessor } from '../dsp/sonar';
import { FusionAlert, FusionConfig, FusionEngine, FusionState } from '../fusion/fusion';
import { ImuEvent, ImuMonitor, ImuSample, ImuState } from '../motion/imu';

export interface EngineConfig {
  fs: number;
  band: Band;
  mode: 'room' | 'body';
  fusion: Partial<FusionConfig>;
  /** Seconds of transmitter-off ambient measurement before sonar starts. */
  ambientSeconds: number;
  maxRange: number;
}

export const DEFAULT_ENGINE: Omit<EngineConfig, 'fs'> = {
  band: WIDE_BAND,
  mode: 'room',
  fusion: {},
  ambientSeconds: 0.8,
  maxRange: 3.2,
};

export type EngineStage = 'ambient' | 'warmup' | 'sonar';

export interface TrackView {
  id: number;
  range: number;
  velocity: number;
  snrDb: number;
  confirmed: boolean;
}

export interface EngineSnapshot {
  t: number;
  stage: EngineStage;
  sonarPhase: string;
  fusion: FusionState;
  sonar: {
    fs: number;
    n: number;
    fps: number;
    f0: number;
    f1: number;
    maxRange: number;
    binRange: number;
    /** Range resolution (point-spread mainlobe width at -6 dB), metres. */
    resolution: number;
    linkSnrDb: number;
    directDb: number;
    motionDb: number;
    fastMotionDb: number;
    staticChangeDb: number;
    tracks: TrackView[];
    primary: TrackView | null;
    detections: { range: number; snrDb: number }[];
    ambientUltrasoundDb: number;
    channelResponse: number[] | null;
  };
  /** New echogram rows since the previous snapshot (oldest first). */
  echoRows: Float32Array[];
  profileRow: Float32Array | null;
  breathing: {
    valid: boolean;
    rateBpm: number;
    quality: number;
    range: number;
    stillSeconds: number;
    prominenceDb: number;
    waveform: Float32Array;
  };
  audio: { levelDb: number; floorDb: number; melCols: Float32Array[]; lastEvent: SoundEvent | null };
  imu: ImuState;
  rangeDoppler: RangeDopplerImage | null;
  perf: { msPerFrame: number; frames: number; realtimeFactor: number };
}

/**
 * The on-device sensing engine: one call per audio block runs active sonar,
 * passive acoustics and fusion; IMU samples arrive separately. Produces
 * snapshots for the UI and alerts for the check-in / escalation layer.
 * Runs identically in a Web Worker, on the main thread, or in Node (tests).
 */
export class EchoSenseEngine {
  readonly cfg: EngineConfig;
  sonar: SonarProcessor;
  readonly passive: PassiveAudio;
  readonly imu: ImuMonitor;
  readonly fusion: FusionEngine;
  private stage: EngineStage = 'ambient';
  private samplesSeen = 0;
  private ambientAcc = 0;
  private ambientCount = 0;
  private ambientUltrasoundDb = -120;
  private warmupUntil = 0;
  private audioBuf: Float64Array;
  private audioFill = 0;
  private echoRows: Float32Array[] = [];
  private melCols: Float32Array[] = [];
  private lastProfile: Float32Array | null = null;
  private lastFrame: SonarFrame | null = null;
  private lastFeatures: AudioFeatures | null = null;
  private lastEvent: SoundEvent | null = null;
  private rdTimer = 0;
  private rdImage: RangeDopplerImage | null = null;
  private procMs = 0;
  private frames = 0;
  private sonarPaused = false;

  constructor(
    cfg: Partial<EngineConfig> & { fs: number },
    private readonly hooks: {
      onAlert?: (a: FusionAlert) => void;
      /** Requested transmitter gain (0 = muted, 1 = on). */
      onTxGain?: (g: number) => void;
      onSound?: (e: SoundEvent) => void;
    } = {},
  ) {
    this.cfg = { ...DEFAULT_ENGINE, ...cfg };
    this.sonar = new SonarProcessor({ fs: this.cfg.fs, band: this.cfg.band, maxRange: this.cfg.maxRange });
    this.passive = new PassiveAudio(this.cfg.fs, this.sonar.n);
    this.imu = new ImuMonitor(this.cfg.mode);
    this.fusion = new FusionEngine({ ...this.cfg.fusion, mode: this.cfg.mode }, (a) => this.hooks.onAlert?.(a));
    this.audioBuf = new Float64Array(this.sonar.n);
    if (this.cfg.ambientSeconds <= 0) this.startSonar(0);
    else this.hooks.onTxGain?.(0);
  }

  get time(): number {
    return this.samplesSeen / this.cfg.fs;
  }

  get txPeriod(): Float32Array {
    return this.sonar.txPeriod;
  }

  private startSonar(t: number): void {
    this.stage = 'warmup';
    // Allow the output ramp and the audio round trip to settle before listening.
    this.warmupUntil = t + 0.3;
    this.hooks.onTxGain?.(1);
  }

  /** Change mode at runtime (room sensor vs. carried phone). */
  setMode(mode: 'room' | 'body'): void {
    this.cfg.mode = mode;
    this.imu.setMode(mode);
    this.fusion.cfg.mode = mode;
  }

  /** Re-learn the room (after moving the phone or changing the band). */
  recalibrate(band?: Band): void {
    if (band) {
      this.cfg.band = band;
      this.sonar = new SonarProcessor({ fs: this.cfg.fs, band, maxRange: this.cfg.maxRange });
    } else this.sonar.restart();
    this.fusion.setCalibrating(true);
    this.echoRows = [];
    this.rdImage = null;
    this.stage = 'ambient';
    this.ambientAcc = 0;
    this.ambientCount = 0;
    this.hooks.onTxGain?.(0);
  }

  pushAudio(x: ArrayLike<number>): void {
    const n = this.sonar.n;
    let i = 0;
    while (i < x.length) {
      const take = Math.min(n - this.audioFill, x.length - i);
      for (let j = 0; j < take; j++) this.audioBuf[this.audioFill + j] = x[i + j];
      this.audioFill += take;
      i += take;
      if (this.audioFill === n) {
        this.audioFill = 0;
        this.processFrame(this.audioBuf);
      }
    }
  }

  private processFrame(frame: Float64Array): void {
    const start = typeof performance !== 'undefined' ? performance.now() : Date.now();
    const n = this.sonar.n;
    const t = this.samplesSeen / this.cfg.fs;
    this.samplesSeen += n;

    // Passive audio runs at all times (except while the phone itself talks).
    const pa = this.passive.process(frame, t);
    this.lastFeatures = pa.features;
    this.melCols.push(pa.features.mel);
    if (this.melCols.length > 64) this.melCols.shift();
    if (pa.event) {
      this.lastEvent = pa.event;
      this.hooks.onSound?.(pa.event);
      this.fusion.onSound(pa.event);
    }

    if (this.stage === 'ambient') {
      this.ambientAcc += this.sonar.inBandPower(frame);
      this.ambientCount++;
      if (t >= this.cfg.ambientSeconds) {
        this.ambientUltrasoundDb = 10 * Math.log10(this.ambientAcc / Math.max(1, this.ambientCount) + 1e-20);
        this.startSonar(t);
      }
    } else if (this.stage === 'warmup') {
      if (t >= this.warmupUntil) this.stage = 'sonar';
    } else if (!this.sonarPaused) {
      const f = this.sonar.processFrame(frame);
      this.lastFrame = f;
      if (f.phase === 'running') {
        this.echoRows.push(f.echoRow);
        if (this.echoRows.length > 256) this.echoRows.shift();
        this.lastProfile = f.profileRow;
      }
      this.fusion.onSonar(f);
      this.rdTimer++;
      if (this.rdTimer >= 10 && f.phase === 'running') {
        this.rdTimer = 0;
        this.rdImage = this.sonar.rangeDoppler();
      }
    } else this.fusion.tick(t);

    const ms = (typeof performance !== 'undefined' ? performance.now() : Date.now()) - start;
    this.procMs += 0.05 * (ms - this.procMs);
    this.frames++;
  }

  pushImu(s: ImuSample): void {
    const ev = this.imu.process(s);
    if (ev) this.handleImu(ev);
  }

  private handleImu(ev: ImuEvent): void {
    const st = this.imu.state(ev.t);
    this.fusion.onImu(ev, st);
    if (this.cfg.mode !== 'room') return;
    if (ev.type === 'moved' || ev.type === 'drop') {
      this.sonarPaused = true;
      this.fusion.setSonarPaused(true);
    } else if (ev.type === 'settled' && this.sonarPaused) {
      this.sonarPaused = false;
      this.fusion.setSonarPaused(false);
      this.recalibrate();
    }
  }

  /** Suppress passive detection while the phone speaks (check-in prompt). */
  speaking(seconds: number): void {
    this.passive.suppress(this.time + seconds);
    this.fusion.muteUntil(this.time + seconds);
    if (this.fusion.snapshot(this.time).checkIn?.state === 'pending') this.fusion.prompted(this.time);
  }

  /** A sound recognition frame from the AI worker (times in the same audio clock). */
  pushAi(frame: import('../audio/soundLabels').AiFrame): void {
    this.fusion.onAi(frame);
  }

  askCheckIn(reason: string, urgent = false, seconds?: number): void {
    this.fusion.requestCheckIn(this.time, reason, urgent, seconds);
  }

  respond(answer: 'ok' | 'help'): void {
    this.fusion.respond(answer, this.time);
  }

  snapshot(): EngineSnapshot {
    const t = this.time;
    const f = this.lastFrame;
    const view = (tr: { id: number; range: number; velocity: number; snrDb: number; confirmed: boolean }) => ({
      id: tr.id,
      range: tr.range,
      velocity: tr.velocity,
      snrDb: tr.snrDb,
      confirmed: tr.confirmed,
    });
    const rows = this.echoRows;
    this.echoRows = [];
    const mel = this.melCols;
    this.melCols = [];
    const br = f?.breathing;
    const fps = this.sonar.fps;
    const snap: EngineSnapshot = {
      t,
      stage: this.stage,
      sonarPhase: this.sonarPaused ? 'paused' : this.stage === 'sonar' ? (f?.phase ?? 'acquiring') : this.stage,
      fusion: this.fusion.snapshot(t),
      sonar: {
        fs: this.cfg.fs,
        n: this.sonar.n,
        fps,
        f0: this.sonar.design.f0,
        f1: this.sonar.design.f1,
        maxRange: this.cfg.maxRange,
        binRange: this.sonar.binRange,
        resolution: this.sonar.resolutionBins * this.sonar.binRange,
        linkSnrDb: f?.linkSnrDb ?? 0,
        directDb: f?.directDb ?? -120,
        motionDb: f?.motionDb ?? 0,
        fastMotionDb: f?.fastMotionDb ?? 0,
        staticChangeDb: f?.staticChangeDb ?? 0,
        tracks: (f?.tracks ?? []).map(view),
        primary: f?.primary ? view(f.primary) : null,
        detections: (f?.detections ?? []).map((d) => ({ range: d.range, snrDb: d.snrDb })),
        ambientUltrasoundDb: this.ambientUltrasoundDb,
        channelResponse: this.sonar.channelResponse ? Array.from(this.sonar.channelResponse) : null,
      },
      echoRows: rows,
      profileRow: this.lastProfile,
      breathing: br
        ? {
            valid: br.valid,
            rateBpm: br.rateBpm,
            quality: br.quality,
            range: br.range,
            stillSeconds: br.stillSeconds,
            prominenceDb: br.prominenceDb,
            waveform: br.waveform,
          }
        : { valid: false, rateBpm: 0, quality: 0, range: 0, stillSeconds: 0, prominenceDb: 0, waveform: new Float32Array(0) },
      audio: {
        levelDb: this.lastFeatures?.levelDb ?? -120,
        floorDb: this.lastFeatures?.floorDb ?? -120,
        melCols: mel,
        lastEvent: this.lastEvent,
      },
      imu: this.imu.state(t),
      rangeDoppler: this.rdImage,
      perf: {
        msPerFrame: this.procMs,
        frames: this.frames,
        realtimeFactor: this.procMs / ((1000 * this.sonar.n) / this.cfg.fs),
      },
    };
    this.rdImage = null;
    return snap;
  }
}
