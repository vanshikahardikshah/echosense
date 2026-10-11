import { Biquad } from '../dsp/filters';
import { Rng } from './random';

/**
 * Procedural sound synthesis for simulation and tests. These are acoustic
 * caricatures with the right spectral/temporal structure (attack, decay,
 * band energy, harmonicity), not recordings.
 */
export type SoundKind =
  | 'thud'
  | 'glass'
  | 'scream'
  | 'speech'
  | 'music'
  | 'footstep'
  | 'keys'
  | 'clap'
  | 'door'
  | 'tv';

export interface SoundEvent {
  t: number;
  kind: SoundKind;
  dur?: number;
  level?: number;
}

type Synth = (fs: number, rng: Rng, dur: number, level: number) => Float32Array;

function env(i: number, fs: number, attack: number, tau: number): number {
  const t = i / fs;
  const a = attack > 0 ? Math.min(1, t / attack) : 1;
  return a * Math.exp(-t / tau);
}

function normalize(x: Float32Array, level: number): Float32Array {
  let peak = 1e-12;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const g = level / peak;
  for (let i = 0; i < x.length; i++) x[i] *= g;
  return x;
}

const thud: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  const lp = Biquad.lowpass(fs, 220, 0.9);
  const lp2 = Biquad.lowpass(fs, 220, 0.9);
  const f0 = rng.uniform(55, 85);
  for (let i = 0; i < n; i++) {
    const nz = lp2.process(lp.process(rng.gauss()));
    const body = Math.sin((2 * Math.PI * f0 * i) / fs) * env(i, fs, 0.002, 0.09);
    x[i] = (2.5 * nz + 0.9 * body) * env(i, fs, 0.003, 0.07);
    // Short mid-frequency contact click.
    if (i < 0.012 * fs) x[i] += 0.15 * rng.gauss() * env(i, fs, 0, 0.004);
  }
  return normalize(x, level);
};

const door: Synth = (fs, rng, dur, level) => {
  const x = thud(fs, rng, dur, 1);
  const f = rng.uniform(140, 260);
  for (let i = 0; i < x.length; i++) {
    x[i] += 0.4 * Math.sin((2 * Math.PI * f * i) / fs) * env(i, fs, 0.004, 0.25);
    x[i] += 0.3 * Math.sin((2 * Math.PI * f * 2.7 * i) / fs) * env(i, fs, 0.004, 0.12);
  }
  return normalize(x, level);
};

const glass: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  const hp = Biquad.highpass(fs, 2500);
  const partials = Array.from({ length: 16 }, () => ({
    f: rng.uniform(2500, 9500),
    tau: rng.uniform(0.08, 0.5),
    a: rng.uniform(0.3, 1),
    start: rng.uniform(0, 0.25),
  }));
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = 0;
    for (const p of partials) {
      if (t < p.start) continue;
      v += p.a * Math.sin(2 * Math.PI * p.f * (t - p.start)) * Math.exp(-(t - p.start) / p.tau);
    }
    v += 2 * hp.process(rng.gauss()) * env(i, fs, 0.001, 0.03);
    x[i] = v;
  }
  return normalize(x, level);
};

const scream: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  const base = rng.uniform(600, 850);
  let ph = 0;
  const formants = [900, 1400, 2800];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const f0 = base * (1 + 0.04 * Math.sin(2 * Math.PI * 5.5 * t)) * (1 - 0.1 * (t / dur));
    ph += (2 * Math.PI * f0) / fs;
    let v = 0;
    for (let h = 1; h <= 8; h++) {
      const fh = f0 * h;
      let w = 0.15;
      for (const F of formants) w += Math.exp(-(((fh - F) / 400) ** 2));
      v += (w / h ** 0.6) * Math.sin(h * ph);
    }
    const a = Math.min(1, t / 0.06) * Math.min(1, (dur - t) / 0.2);
    x[i] = (v + 0.08 * rng.gauss()) * a;
  }
  return normalize(x, level);
};

function vowelSyllable(fs: number, rng: Rng, n: number, f0: number, out: Float32Array, off: number): void {
  const F1 = rng.uniform(400, 800);
  const F2 = rng.uniform(1000, 2300);
  let ph = 0;
  const glide = rng.uniform(-0.15, 0.15);
  for (let i = 0; i < n && off + i < out.length; i++) {
    const t = i / n;
    const f = f0 * (1 + glide * t);
    ph += (2 * Math.PI * f) / fs;
    let v = 0;
    for (let h = 1; h <= 20; h++) {
      const fh = f * h;
      if (fh > 5000) break;
      const w = Math.exp(-(((fh - F1) / 150) ** 2)) + 0.6 * Math.exp(-(((fh - F2) / 200) ** 2)) + 0.05;
      v += (w / h) * Math.sin(h * ph);
    }
    const a = Math.sin(Math.PI * t) ** 0.7;
    out[off + i] += v * a;
  }
}

const speech: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  let i = 0;
  const f0 = rng.uniform(110, 220);
  while (i < n) {
    const syl = Math.round(rng.uniform(0.12, 0.28) * fs);
    vowelSyllable(fs, rng, syl, f0 * rng.uniform(0.85, 1.2), x, i);
    // Fricative/consonant noise burst between some syllables.
    if (rng.next() < 0.4) {
      const hp = Biquad.highpass(fs, 3000);
      const m = Math.round(0.05 * fs);
      for (let j = 0; j < m && i + syl + j < n; j++) x[i + syl + j] += 0.15 * hp.process(rng.gauss());
    }
    i += syl + Math.round(rng.uniform(0.03, rng.next() < 0.15 ? 0.5 : 0.1) * fs);
  }
  return normalize(x, level);
};

const music: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  const beat = 60 / rng.uniform(90, 125);
  const roots = [220, 246.9, 196, 174.6];
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    const bar = Math.floor(t / (beat * 4)) % roots.length;
    const r = roots[bar];
    let v = 0;
    for (const ratio of [1, 1.26, 1.5, 2]) {
      for (let h = 1; h <= 4; h++) v += (0.25 / h) * Math.sin(2 * Math.PI * r * ratio * h * t);
    }
    const tb = t % beat;
    // Kick drum on the beat: a low thump every beat (a realistic impact-detector distractor).
    v += 1.8 * Math.sin(2 * Math.PI * (55 + 80 * Math.exp(-tb / 0.03)) * tb) * Math.exp(-tb / 0.12);
    const th = (t + beat / 2) % beat;
    v += 0.4 * rng.gauss() * Math.exp(-th / 0.03) * (th < 0.1 ? 1 : 0);
    x[i] = v;
  }
  return normalize(x, level);
};

const footstep: Synth = (fs, rng, dur, level) => {
  const n = Math.round(Math.min(dur, 0.15) * fs);
  const x = new Float32Array(n);
  const lp = Biquad.lowpass(fs, 400);
  for (let i = 0; i < n; i++) {
    x[i] = lp.process(rng.gauss()) * env(i, fs, 0.002, 0.025) + 0.2 * rng.gauss() * env(i, fs, 0, 0.004);
  }
  return normalize(x, level);
};

const keys: Synth = (fs, rng, dur, level) => {
  const n = Math.round(dur * fs);
  const x = new Float32Array(n);
  const pings = Array.from({ length: 40 }, () => ({
    t: rng.uniform(0, dur * 0.8),
    f: rng.uniform(3000, Math.min(21000, fs / 2 - 1500)),
    tau: rng.uniform(0.01, 0.08),
    a: rng.uniform(0.2, 1),
  }));
  for (let i = 0; i < n; i++) {
    const t = i / fs;
    let v = 0;
    for (const p of pings) {
      if (t < p.t || t > p.t + 5 * p.tau) continue;
      v += p.a * Math.sin(2 * Math.PI * p.f * (t - p.t)) * Math.exp(-(t - p.t) / p.tau);
    }
    x[i] = v;
  }
  return normalize(x, level);
};

const clap: Synth = (fs, rng, dur, level) => {
  const n = Math.round(Math.min(dur, 0.12) * fs);
  const x = new Float32Array(n);
  const hp = Biquad.highpass(fs, 900);
  const lp = Biquad.lowpass(fs, 5000);
  for (let i = 0; i < n; i++) x[i] = lp.process(hp.process(rng.gauss())) * env(i, fs, 0.0005, 0.018);
  return normalize(x, level);
};

const tv: Synth = (fs, rng, dur, level) => {
  const a = speech(fs, rng, dur, 1);
  const b = music(fs, rng, dur, 0.3);
  for (let i = 0; i < a.length; i++) a[i] = 0.7 * a[i] + b[i];
  return normalize(a, level);
};

const SYNTHS: Record<SoundKind, { synth: Synth; dur: number; level: number }> = {
  thud: { synth: thud, dur: 0.4, level: 0.3 },
  door: { synth: door, dur: 0.6, level: 0.3 },
  glass: { synth: glass, dur: 1.2, level: 0.2 },
  scream: { synth: scream, dur: 1.2, level: 0.25 },
  speech: { synth: speech, dur: 4, level: 0.06 },
  music: { synth: music, dur: 10, level: 0.05 },
  footstep: { synth: footstep, dur: 0.15, level: 0.015 },
  keys: { synth: keys, dur: 0.8, level: 0.05 },
  clap: { synth: clap, dur: 0.12, level: 0.15 },
  tv: { synth: tv, dur: 10, level: 0.05 },
};

export function synthesize(kind: SoundKind, fs: number, rng: Rng, dur?: number, level?: number): Float32Array {
  const d = SYNTHS[kind];
  return d.synth(fs, rng, dur ?? d.dur, level ?? d.level);
}

export function mixInto(out: Float32Array, x: Float32Array, startSample: number): void {
  for (let i = 0; i < x.length; i++) {
    const j = startSample + i;
    if (j >= 0 && j < out.length) out[j] += x[i];
  }
}
