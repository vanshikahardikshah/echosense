import { runAgents, type IncidentRun } from '../../src/agents/eval';
import { generate, LAYOUT } from '../../src/agents/sim';
import { Rng } from '../../src/sim/random';
import { FAMILIES } from './families';
// Watchful-waiting gate: current (no movement at all in 1.5-11.5 s) vs proposed (mostly still: >=80%, no sustained movement).
const cur = (r: IncidentRun) => r.reports.some((x) => x.sonar.sawPersonBefore && x.sonar.burstDb >= 16 && x.sonar.firstMoveAfter === null && !x.sonar.motionResumed);
const prop = (r: IncidentRun) => r.reports.some((x) => x.sonar.sawPersonBefore && x.sonar.burstDb >= 16 && !x.sonar.motionResumed && x.sonar.stillAfter >= 0.8);
(async () => {
  const out: Record<string, [number, number, number]> = {};
  for (const f of FAMILIES) for (let v = 0; v < 10; v++) {
    const r = new Rng(1000 + v * 97 + f.id.length * 13 + f.id.charCodeAt(1));
    const spec: any = { key: `${f.id}#${v}`, ...f.gen(r) }; spec.emergency = f.emergency;
    const runs = await runAgents(generate(spec, 11 + v, LAYOUT.slice(0, spec.phones ?? 3)));
    const sd = runs.filter((x) => x.outcome.kind === 'stand_down');
    const o = (out[f.id] ??= [0, 0, 0]);
    o[0] += sd.length ? 1 : 0; o[1] += sd.some(cur) ? 1 : 0; o[2] += sd.some(prop) ? 1 : 0;
  }
  console.log('family: stood-down runs / watched now / watched with proposed gate');
  for (const [k, v] of Object.entries(out)) if (v[0]) console.log(k.padEnd(28), v.join(' / '));
})();
