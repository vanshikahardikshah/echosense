import { Biquad } from '../dsp/filters';
import { ChirpDesign, speedOfSound } from '../dsp/chirp';
import { BodyModel, Scenario, Vec3 } from './body';
import { Rng } from './random';
import { mixInto, SoundEvent, synthesize } from './sounds';

export interface StaticReflector {
  range: number;
  amp: number;
}

export interface OtherTransmitter {
  design: ChirpDesign;
  distance: number;
  amp: number;
  /** Seconds into the recording when this phone starts transmitting. */
  startAt?: number;
}

export interface RoomConfig {
  fs: number;
  design: ChirpDesign;
  phone: Vec3;
  /** Output-to-input latency of the audio stack, in samples (any real number). */
  latencySamples: number;
  /** Amplitude of the direct speaker-to-mic path at the microphone. */
  direct: number;
  statics: StaticReflector[];
  reverbCount: number;
  /** Mic self-noise RMS (full band). */
  micNoise: number;
  /** Ambient audible noise RMS (pink-ish, below 8 kHz). */
  ambientNoise: number;
  /** Relative slow amplitude fluctuation of static echoes (air turbulence, HVAC). */
  clutterJitter: number;
  others: OtherTransmitter[];
  /** Simulated dropped audio blocks: at time t, `samples` samples are lost. */
  dropouts: { t: number; samples: number }[];
  tempC: number;
  seed: number;
  /** Time (s) at which the phone starts transmitting (models the muted ambient-calibration step). */
  txOnAt: number;
}

export function defaultRoom(fs: number, design: ChirpDesign, overrides: Partial<RoomConfig> = {}): RoomConfig {
  return {
    fs,
    design,
    phone: [0, 0, 0.75],
    latencySamples: 611.37,
    direct: 0.25,
    // Amplitudes at the microphone (direct path = 0.25).
    statics: [
      { range: 0.09, amp: 0.04 }, // phone body / table surface
      { range: 0.32, amp: 0.008 }, // table edge
      { range: 0.75, amp: 0.003 }, // floor around the table
      { range: 1.45, amp: 0.0012 }, // chair
      { range: 1.9, amp: 0.0015 }, // ceiling
      { range: 2.35, amp: 0.0009 }, // sofa
      { range: 2.9, amp: 0.0012 }, // wall
      { range: 3.6, amp: 0.0008 }, // far wall (wraps beyond range)
    ],
    reverbCount: 160,
    micNoise: 2e-4,
    ambientNoise: 2e-3,
    clutterJitter: 0.0015,
    others: [],
    dropouts: [],
    tempC: 21,
    seed: 11,
    txOnAt: 0,
    ...overrides,
  };
}

/**
 * Renders what the phone microphone hears: the looped chirp through the direct
 * path, static room echoes and diffuse reverberation (exact fractional delays,
 * since the chirp is analytic), a moving human body (time-varying delays give
 * true Doppler and sub-millimetre breathing phase), other phones' chirps,
 * audible sound events, ambient noise and mic self-noise.
 */
export function renderRoom(cfg: RoomConfig, scenario: Scenario, durationS?: number): { mic: Float32Array; body: BodyModel } {
  const { fs, design } = cfg;
  const c = speedOfSound(cfg.tempC);
  const rng = new Rng(cfg.seed);
  const body = new BodyModel(scenario, cfg.phone, cfg.seed + 1);
  const dur = durationS ?? body.duration;
  const total = Math.round(dur * fs);
  const extra = cfg.dropouts.reduce((a, d) => a + d.samples, 0);
  const out = new Float32Array(total + extra);
  const n = design.n;
  const lat = cfg.latencySamples / fs;
  const onSample = Math.round((cfg.txOnAt + lat) * fs);
  const ramp = Math.round(0.05 * fs);
  const gate = (i: number): number => (i < onSample ? 0 : i < onSample + ramp ? (i - onSample) / ramp : 1);

  // Static part is periodic: compute one period exactly, then tile it.
  const direct = new Float64Array(n);
  const statics = new Float64Array(n);
  const refl: StaticReflector[] = [...cfg.statics];
  for (let i = 0; i < cfg.reverbCount; i++) {
    const r = rng.uniform(1.2, 9);
    refl.push({ range: r, amp: 0.0012 * Math.exp(-r / 3) * rng.uniform(0.2, 1) });
  }
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    direct[i] = cfg.direct * design.valueAt(t - lat - 0.025 / c);
    let s = 0;
    for (const rf of refl) s += rf.amp * design.valueAt(t - lat - (2 * rf.range) / c);
    statics[i] = s * (cfg.direct / 0.25);
  }
  // Slow AR(1) jitter per period.
  let jd = 0;
  let js = 0;
  const rho = 0.97;
  for (let p = 0; p * n < out.length; p++) {
    jd = rho * jd + Math.sqrt(1 - rho * rho) * rng.gauss() * cfg.clutterJitter * 0.25;
    js = rho * js + Math.sqrt(1 - rho * rho) * rng.gauss() * cfg.clutterJitter;
    const base = p * n;
    for (let i = 0; i < n && base + i < out.length; i++) out[base + i] = (direct[i] * (1 + jd) + statics[i] * (1 + js)) * gate(base + i);
  }

  // Dynamic body echoes, positions evaluated every block and interpolated.
  const block = 64;
  const scale = cfg.direct / 0.25;
  for (let b0 = 0; b0 < out.length; b0 += block) {
    const tA = b0 / fs;
    const tB = Math.min(out.length, b0 + block) / fs;
    const ra = body.reflectors(tA);
    const rb = body.reflectors(tB);
    if (ra.length === 0 && rb.length === 0) continue;
    const m = Math.min(ra.length, rb.length);
    for (let k = 0; k < m; k++) {
      const da = dist(ra[k].p, cfg.phone);
      const db = dist(rb[k].p, cfg.phone);
      const amp = (scale * ra[k].amp) / Math.max(da, 0.15) ** 2;
      for (let i = b0; i < Math.min(out.length, b0 + block); i++) {
        const u = (i - b0) / block;
        const r = da + (db - da) * u;
        const t = i / fs;
        out[i] += amp * design.valueAt(t - lat - (2 * r) / c) * gate(i);
      }
    }
  }

  // Other phones (frequency-division multiplexed) heard directly.
  for (const o of cfg.others) {
    const off = rng.uniform(0, o.design.period);
    const start = Math.round((o.startAt ?? 0) * fs);
    for (let i = start; i < out.length; i++) out[i] += o.amp * o.design.valueAt(i / fs - off - o.distance / c);
  }

  // Audible events.
  const sounds: SoundEvent[] = [...(scenario.sounds ?? []), ...body.impliedSounds()];
  for (const s of sounds) mixInto(out, synthesize(s.kind, fs, rng, s.dur, s.level), Math.round(s.t * fs));

  // Ambient (pink-ish below 8 kHz) and mic self-noise.
  const lp1 = Biquad.lowpass(fs, 600);
  const lp2 = Biquad.lowpass(fs, 8000);
  for (let i = 0; i < out.length; i++) {
    const w = rng.gauss();
    const amb = 0.7 * lp1.process(w) * 3 + 0.3 * lp2.process(rng.gauss());
    out[i] += cfg.ambientNoise * amb + cfg.micNoise * rng.gauss();
  }

  // Dropped blocks: remove samples (the recording simply skips ahead).
  let mic = out;
  if (cfg.dropouts.length) {
    const keep: number[] = [];
    const drops = cfg.dropouts.map((d) => ({ start: Math.round(d.t * fs), len: d.samples })).sort((a, b) => a.start - b.start);
    let di = 0;
    for (let i = 0; i < out.length; i++) {
      if (di < drops.length && i >= drops[di].start && i < drops[di].start + drops[di].len) continue;
      if (di < drops.length && i >= drops[di].start + drops[di].len) di++;
      keep.push(out[i]);
    }
    mic = Float32Array.from(keep.slice(0, total));
  } else mic = out.subarray(0, total);

  // Soft clip like a real ADC front end.
  for (let i = 0; i < mic.length; i++) {
    const v = mic[i];
    mic[i] = Math.abs(v) < 0.9 ? v : Math.sign(v) * (0.9 + 0.1 * Math.tanh((Math.abs(v) - 0.9) / 0.1));
  }
  return { mic, body };
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** 16-bit PCM mono WAV encoder (used for Chromium fake-microphone end-to-end tests). */
export function encodeWav(x: Float32Array, fs: number): Uint8Array {
  const n = x.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i));
  };
  w(0, 'RIFF');
  v.setUint32(4, 36 + n * 2, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, fs, true);
  v.setUint32(28, fs * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  w(36, 'data');
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) v.setInt16(44 + i * 2, Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), true);
  return new Uint8Array(buf);
}
