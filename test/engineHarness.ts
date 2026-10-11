import { EchoSenseEngine } from '../src/engine/engine';
import { FusionAlert } from '../src/fusion/fusion';
import { Scenario } from '../src/sim/body';
import { defaultRoom, renderRoom, RoomConfig } from '../src/sim/room';

export const FS = 48000;

export function runEngine(scenario: Scenario, opts: { room?: Partial<RoomConfig>; checkInTimeout?: number; respondAt?: number } = {}) {
  const alerts: FusionAlert[] = [];
  const engine = new EchoSenseEngine(
    { fs: FS, fusion: { checkInTimeout: opts.checkInTimeout ?? 15 } },
    { onAlert: (a) => alerts.push(a) },
  );
  const room = defaultRoom(FS, engine.sonar.design, { txOnAt: engine.cfg.ambientSeconds + 0.01, ...opts.room });
  const { mic, body } = renderRoom(room, scenario);
  const snaps: ReturnType<EchoSenseEngine['snapshot']>[] = [];
  const block = 1024;
  let k = 0;
  let responded = false;
  for (let i = 0; i < mic.length; i += block) {
    engine.pushAudio(mic.subarray(i, Math.min(mic.length, i + block)));
    if (++k % 3 === 0) snaps.push(engine.snapshot());
    if (opts.respondAt !== undefined && !responded && engine.time >= opts.respondAt) {
      engine.respond('ok');
      responded = true;
    }
  }
  return { alerts, snaps, engine, body };
}

export function fmt(a: FusionAlert): string {
  return `${a.t.toFixed(1)}s ${a.severity}:${a.kind} "${a.title}" (${a.confidence.toFixed(2)}) [${a.evidence.join('; ')}]`;
}
