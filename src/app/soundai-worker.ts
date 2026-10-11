/// <reference lib="webworker" />
import { groupScores, topClasses, type AiFrame } from '../audio/soundLabels';
import { Yamnet, YAMNET_RATE, YAMNET_SAMPLES } from '../audio/yamnet';

/**
 * Sound recognition worker: resamples the microphone stream to 16 kHz and runs
 * YAMNet every half second. Only labels and scores leave this worker.
 */

export type ToAi = { type: 'init'; fs: number; url: string; classesUrl: string } | { type: 'audio'; buf: Float32Array } | { type: 'clip'; seconds: number };
export type FromAi =
  | { type: 'ready'; ms: number }
  | { type: 'frame'; frame: AiFrame; ms: number }
  | { type: 'error'; message: string }
  | { type: 'clip'; pcm: Int16Array; levelDb: number };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let model: Yamnet | null = null;
let names: string[] = [];
let fs = 48000;
let seen = 0; // input samples so far
// Anti-alias low-pass (windowed sinc, 7.2 kHz) at the input rate, then fractional resampling.
let taps = new Float32Array(0);
let hist = new Float32Array(0);
let histPos = 0;
let phase = 0;
const ring = new Float32Array(YAMNET_RATE * 2);
/** The last 10 s at 16 kHz, kept only so a spoken answer to "Are you OK?" can be sent for understanding. */
const voice = new Float32Array(YAMNET_RATE * 10);
let voicePos = 0;
let ringFill = 0;
let sinceRun = 0;
let busy = false;
let quiet = false;
let floor = 1;
const HOP = Math.round(0.48 * YAMNET_RATE);

function design(): void {
  const n = 63;
  const fc = 7200 / fs;
  taps = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const m = i - (n - 1) / 2;
    const sinc = m === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * m) / (Math.PI * m);
    const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * i) / (n - 1));
    taps[i] = sinc * w;
    sum += taps[i];
  }
  for (let i = 0; i < n; i++) taps[i] /= sum;
  hist = new Float32Array(n);
  histPos = 0;
}

let ringPos = 0;
let total16 = 0;
let forceAt = -1;
let env = 0;
function push16(v: number): void {
  voice[voicePos] = v;
  voicePos = (voicePos + 1) % voice.length;
  ring[ringPos] = v;
  ringPos = (ringPos + 1) % ring.length;
  if (ringFill < ring.length) ringFill++;
  sinceRun++;
  total16++;
  // Cheap onset detector: a sudden jump in level schedules a run with the
  // event about 0.4 s into the window, so short sounds are never skipped.
  const a = Math.abs(v);
  env = Math.max(a, env * 0.995);
  if (env > floor * 8 && forceAt < 0) forceAt = total16 + Math.round(0.45 * YAMNET_RATE);
}
function latest(n: number): Float32Array {
  const out = new Float32Array(n);
  const start = (ringPos - n + ring.length) % ring.length;
  for (let i = 0; i < n; i++) out[i] = ring[(start + i) % ring.length];
  return out;
}

function onAudio(buf: Float32Array): void {
  const step = fs / YAMNET_RATE;
  const n = taps.length;
  for (let i = 0; i < buf.length; i++) {
    hist[histPos] = buf[i];
    histPos = (histPos + 1) % n;
    seen++;
    phase += 1;
    if (phase >= step) {
      phase -= step;
      let acc = 0;
      for (let k = 0; k < n; k++) acc += taps[k] * hist[(histPos + k) % n];
      push16(acc);
    }
  }
  // In a quiet room run once every 1.5 s; when something is going on, every 0.5 s.
  const hop = quiet ? HOP * 3 : HOP;
  const forced = forceAt >= 0 && total16 >= forceAt;
  if (model && !busy && (sinceRun >= hop || forced) && ringFill >= YAMNET_SAMPLES) {
    sinceRun = 0;
    if (forced) forceAt = -1;
    const wav = latest(YAMNET_SAMPLES);
    const tEnd = seen / fs;
    busy = true;
    // Let the message queue drain before the heavy call.
    setTimeout(() => {
      try {
        let rms = 0;
        for (let i = 0; i < wav.length; i++) rms += wav[i] * wav[i];
        rms = Math.sqrt(rms / wav.length);
        // Quiet when the newest half second is not much louder than the quietest we have heard.
        let tail = 0;
        for (let i = wav.length - HOP; i < wav.length; i++) tail += wav[i] * wav[i];
        tail = Math.sqrt(tail / HOP);
        floor = Math.min(floor * 1.01 + 1e-7, Math.max(tail, 1e-6));
        quiet = tail < floor * 3;
        const t0 = performance.now();
        let frame: AiFrame;
        if (rms < 3e-4) {
          const silent = new Float32Array(521);
          silent[494] = 1;
          frame = { t: tEnd, groups: groupScores(silent), top: [{ name: 'Silence', score: 1 }] };
        } else {
          const s = model!.run(wav);
          frame = { t: tEnd, groups: groupScores(s), top: topClasses(s, names, 3) };
        }
        ctx.postMessage({ type: 'frame', frame, ms: performance.now() - t0 } satisfies FromAi);
      } catch (e) {
        ctx.postMessage({ type: 'error', message: (e as Error).message } satisfies FromAi);
      } finally {
        busy = false;
      }
    }, 0);
  }
}

ctx.onmessage = async (ev: MessageEvent<ToAi>) => {
  const m = ev.data;
  if (m.type === 'init') {
    fs = m.fs;
    design();
    try {
      const t0 = performance.now();
      const [bin, cls] = await Promise.all([fetch(m.url).then((r) => r.arrayBuffer()), fetch(m.classesUrl).then((r) => r.json())]);
      names = cls as string[];
      model = Yamnet.fromBuffer(bin);
      ctx.postMessage({ type: 'ready', ms: performance.now() - t0 } satisfies FromAi);
    } catch (e) {
      ctx.postMessage({ type: 'error', message: `could not load the sound model: ${(e as Error).message}` } satisfies FromAi);
    }
  } else if (m.type === 'audio') onAudio(m.buf);
  else if (m.type === 'clip') {
    const n = Math.min(voice.length, Math.round(m.seconds * YAMNET_RATE));
    const out = new Int16Array(n);
    const start = (voicePos - n + voice.length) % voice.length;
    // Normalise by the loudest stretch of speech (0.1 s windows), not by one click, so a
    // voice a few metres away comes through at a level the recogniser can read.
    const win = Math.round(0.1 * YAMNET_RATE);
    let best = 1e-5;
    for (let w = 0; w + win <= n; w += win) {
      let e = 0;
      for (let i = w; i < w + win; i++) e += voice[(start + i) % voice.length] ** 2;
      best = Math.max(best, Math.sqrt(e / win));
    }
    const gain = Math.min(80, 0.15 / best);
    for (let i = 0; i < n; i++) out[i] = Math.max(-32767, Math.min(32767, Math.round(voice[(start + i) % voice.length] * gain * 32767)));
    ctx.postMessage({ type: 'clip', pcm: out, levelDb: 20 * Math.log10(best) } satisfies FromAi, [out.buffer]);
  }
};
