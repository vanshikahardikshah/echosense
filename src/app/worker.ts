import type { AiFrame } from '../audio/soundLabels';
/// <reference lib="webworker" />
import { Band } from '../dsp/chirp';
import { EchoSenseEngine } from '../engine/engine';
import { FusionConfig } from '../fusion/fusion';
import { ImuSample } from '../motion/imu';
import { defaultRoom, renderRoom } from '../sim/room';
import { SCENARIOS } from '../sim/scenarios';

/**
 * Engine worker: all signal processing runs here so the UI thread stays smooth.
 * In simulation mode the worker also synthesises the microphone signal of a
 * scripted scene in real time (the UI labels this clearly).
 */
export type ToWorker =
  | { type: 'init'; fs: number; band: Band; mode: 'room' | 'body'; fusion: Partial<FusionConfig>; sim?: string }
  | { type: 'audio'; buf: Float32Array }
  | { type: 'imu'; s: ImuSample }
  | { type: 'respond'; answer: 'ok' | 'help' }
  | { type: 'speaking'; seconds: number }
  | { type: 'recalibrate'; band?: Band }
  | { type: 'mode'; mode: 'room' | 'body' }
  | { type: 'fusion'; cfg: Partial<FusionConfig> }
  | { type: 'ask'; reason: string; urgent?: boolean; seconds?: number }
  | { type: 'ai'; frame: AiFrame };

const ctx = self as unknown as DedicatedWorkerGlobalScope;
let engine: EchoSenseEngine | null = null;
let snapTimer: ReturnType<typeof setInterval> | null = null;
let simTimer: ReturnType<typeof setInterval> | null = null;
let imuT0 = -1;

function startSnapshots(): void {
  if (snapTimer) clearInterval(snapTimer);
  snapTimer = setInterval(() => {
    if (!engine) return;
    const snap = engine.snapshot();
    ctx.postMessage({ type: 'snapshot', snap });
  }, 66);
}

function startSim(name: string, fs: number): void {
  const e = engine!;
  const scenario = SCENARIOS[name] ?? SCENARIOS.demo;
  ctx.postMessage({ type: 'sim', state: 'rendering', name: scenario.name });
  const room = defaultRoom(fs, e.sonar.design, { txOnAt: e.cfg.ambientSeconds + 0.01, seed: 5 });
  const { mic } = renderRoom(room, scenario);
  ctx.postMessage({ type: 'sim', state: 'playing', name: scenario.name, duration: mic.length / fs });
  const t0 = performance.now();
  let pos = 0;
  simTimer = setInterval(() => {
    const due = Math.min(mic.length, Math.floor(((performance.now() - t0) / 1000) * fs));
    while (pos + 1024 <= due) {
      e.pushAudio(mic.subarray(pos, pos + 1024));
      pos += 1024;
    }
    if (pos + 1024 > mic.length) {
      clearInterval(simTimer!);
      simTimer = null;
      ctx.postMessage({ type: 'sim', state: 'ended', name: scenario.name });
    }
  }, 20);
}

ctx.onmessage = (ev: MessageEvent<ToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'init': {
      if (simTimer) clearInterval(simTimer);
      engine = new EchoSenseEngine(
        { fs: m.fs, band: m.band, mode: m.mode, fusion: m.fusion },
        {
          onAlert: (alert) => ctx.postMessage({ type: 'alert', alert }),
          onTxGain: (gain) => ctx.postMessage({ type: 'tx', gain }),
          onSound: (sound) => ctx.postMessage({ type: 'sound', sound }),
        },
      );
      ctx.postMessage({
        type: 'ready',
        txPeriod: engine.txPeriod,
        n: engine.sonar.n,
        fps: engine.sonar.fps,
        f0: engine.sonar.design.f0,
        f1: engine.sonar.design.f1,
        crest: engine.sonar.design.crestFactor,
      });
      startSnapshots();
      if (m.sim) startSim(m.sim, m.fs);
      break;
    }
    case 'audio':
      engine?.pushAudio(m.buf);
      break;
    case 'imu':
      if (engine) {
        // Map the browser clock onto engine time.
        if (imuT0 < 0) imuT0 = m.s.t - engine.time;
        engine.pushImu({ ...m.s, t: m.s.t - imuT0 });
      }
      break;
    case 'respond':
      engine?.respond(m.answer);
      break;
    case 'speaking':
      engine?.speaking(m.seconds);
      break;
    case 'recalibrate':
      if (engine) {
        engine.recalibrate(m.band);
        ctx.postMessage({ type: 'txPeriod', txPeriod: engine.txPeriod, f0: engine.sonar.design.f0, f1: engine.sonar.design.f1 });
      }
      break;
    case 'mode':
      engine?.setMode(m.mode);
      break;
    case 'fusion':
      if (engine) Object.assign(engine.fusion.cfg, m.cfg);
      break;
    case 'ask':
      engine?.askCheckIn(m.reason, m.urgent, m.seconds);
      break;
    case 'ai':
      engine?.pushAi(m.frame);
      break;
  }
};
