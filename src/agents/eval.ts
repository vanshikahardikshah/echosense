import { GATHER_MS, PhoneAgent, SAME_EVENT_MS } from './phoneAgent';
import { deliberate, type BrainOpts } from './protocol';
import { fingerprint } from './roles';
import type { HomeMap } from './cartographer';
import { generate, LAYOUT, SCENARIOS, simHomeMap, type GeneratedTrial, type ScenarioSpec, type SimPhone } from './sim';
import type { EvidenceReport, Incident, Outcome, Position, TriggerKind } from './types';

/**
 * Runs the same scenarios through four decision makers:
 *   single    the main phone on its own (what EchoSense did before agents)
 *   any       alarm if any phone's own rule fires (most sensitive baseline)
 *   majority  alarm if more than half of the phones' own rules fire
 *   agents    Witness: phone agents report, role agents deliberate
 */

export type Decision = 'alarm' | 'ask' | 'none';
export type Method = 'single' | 'any' | 'majority' | 'agents' | 'agentsMap';
export const METHODS: Method[] = ['single', 'any', 'majority', 'agents', 'agentsMap'];

export interface IncidentRun {
  incident: Incident;
  reports: EvidenceReport[];
  positions: Position[];
  outcome: Outcome;
}

export interface TrialResult {
  scenario: string;
  emergency: boolean;
  decisions: Record<Method, Decision>;
  incidents: IncidentRun[];
  incidentsMap: IncidentRun[];
}

/** Replays a generated trial through live phone agents and the deliberation protocol. */
export async function runAgents(trial: GeneratedTrial, seen = new Set<string>(), map?: HomeMap, brain?: BrainOpts): Promise<IncidentRun[]> {
  const triggers: { t: number; nodeId: string; name: string; kind: TriggerKind; detail: string }[] = [];
  const agents = trial.streams.map((s) => new PhoneAgent(s.phone.nodeId, s.phone.name, (kind, detail, t) => triggers.push({ t, nodeId: s.phone.nodeId, name: s.phone.name, kind, detail })));
  type Ev = { t: number; i: number; run: () => void };
  const evs: Ev[] = [];
  trial.streams.forEach((s, i) => {
    for (const x of s.samples) evs.push({ t: x.t, i, run: () => agents[i].onSample(x) });
    for (const x of s.sounds) evs.push({ t: x.t, i, run: () => agents[i].onSound(x) });
    for (const x of s.alerts) evs.push({ t: x.t, i, run: () => agents[i].onAlert(x) });
  });
  evs.sort((a, b) => a.t - b.t || a.i - b.i);
  for (const e of evs) e.run();

  // Incidents: a trigger joins an incident that started within 3 s of it, otherwise it opens one.
  triggers.sort((a, b) => a.t - b.t);
  const runs: IncidentRun[] = [];
  const opened: number[] = [];
  let n = 0;
  for (const tr of triggers) {
    if (opened.some((t) => Math.abs(tr.t - t) <= SAME_EVENT_MS)) continue;
    opened.push(tr.t);
    const incident: Incident = {
      id: `${trial.spec.key}-${++n}`,
      t0: tr.t,
      trigger: { nodeId: tr.nodeId, name: tr.name, kind: tr.kind, detail: tr.detail },
      status: 'deliberating',
      expected: agents.map((a) => a.nodeId),
      simulated: true,
      scenario: trial.spec.key,
    };
    const at = tr.t + GATHER_MS;
    const reports = agents.map((a) => a.report(incident.id, tr.t, at));
    const { positions, outcome } = await deliberate(incident, reports, { now: () => at, seenFingerprints: seen, map, brain });
    for (const r of reports) seen.add(fingerprint(r));
    runs.push({ incident, reports, positions, outcome });
  }
  return runs;
}

export function baselineDecisions(trial: GeneratedTrial): Pick<Record<Method, Decision>, 'single' | 'any' | 'majority'> {
  const fires = trial.streams.map((s) => s.alerts.some((a) => a.kind === 'fall'));
  const count = fires.filter(Boolean).length;
  return {
    single: fires[0] ? 'alarm' : 'none',
    any: count > 0 ? 'alarm' : 'none',
    majority: count > fires.length / 2 ? 'alarm' : 'none',
  };
}

/**
 * Scores the agents' outcome, including the live follow up ("watchful
 * waiting"): when they stood down after someone dropped and stayed still, the
 * hub asks anyway if nobody moves in the next minute. In the simulator a person
 * on the floor never moves again; anyone sitting shifts around within a minute.
 */
export function agentDecision(runs: IncidentRun[], trial?: GeneratedTrial): Decision {
  if (runs.some((r) => r.outcome.kind === 'escalate')) return 'alarm';
  if (runs.some((r) => r.outcome.kind === 'ask_human')) return 'ask';
  const watched = runs.some((r) => r.outcome.kind === 'stand_down' && r.reports.some((x) => x.sonar.sawPersonBefore && x.sonar.burstDb >= 16 && x.sonar.firstMoveAfter === null && !x.sonar.motionResumed));
  if (watched && trial && trial.spec.person.after === 'floor' && trial.spec.person.event !== 'none') return 'ask';
  return 'none';
}

export async function runTrial(spec: ScenarioSpec, seed: number, layout: SimPhone[] = LAYOUT): Promise<TrialResult> {
  const trial = generate(spec, seed, layout);
  const incidents = await runAgents(trial);
  const withMap = await runAgents(trial, new Set(), simHomeMap(trial));
  return {
    scenario: spec.key,
    emergency: spec.emergency,
    decisions: { ...baselineDecisions(trial), agents: agentDecision(incidents, trial), agentsMap: agentDecision(withMap, trial) },
    incidents,
    incidentsMap: withMap,
  };
}

export interface Score {
  trials: number;
  /** Emergencies answered by an immediate call. */
  caught: number;
  /** Emergencies answered after asking the person (call if no answer). */
  caughtAfterAsk: number;
  missed: number;
  falseAlarms: number;
  /** Non emergencies where the person was asked "are you OK?". */
  prompts: number;
  correctQuiet: number;
}

export interface EvalTable {
  trialsPerScenario: number;
  scenarios: { spec: ScenarioSpec; scores: Record<Method, Score> }[];
  totals: Record<Method, Score>;
}

function empty(): Score {
  return { trials: 0, caught: 0, caughtAfterAsk: 0, missed: 0, falseAlarms: 0, prompts: 0, correctQuiet: 0 };
}
function add(s: Score, emergency: boolean, d: Decision): void {
  s.trials++;
  if (emergency) {
    if (d === 'alarm') s.caught++;
    else if (d === 'ask') s.caughtAfterAsk++;
    else s.missed++;
  } else if (d === 'alarm') s.falseAlarms++;
  else if (d === 'ask') s.prompts++;
  else s.correctQuiet++;
}

export async function evaluate(trials = 50, specs: ScenarioSpec[] = SCENARIOS, layout: SimPhone[] = LAYOUT): Promise<EvalTable> {
  const totals = Object.fromEntries(METHODS.map((m) => [m, empty()])) as Record<Method, Score>;
  const scenarios: EvalTable['scenarios'] = [];
  for (const spec of specs) {
    const scores = Object.fromEntries(METHODS.map((m) => [m, empty()])) as Record<Method, Score>;
    for (let k = 0; k < trials; k++) {
      const r = await runTrial(spec, k + 1, layout);
      for (const m of METHODS) {
        add(scores[m], spec.emergency, r.decisions[m]);
        add(totals[m], spec.emergency, r.decisions[m]);
      }
    }
    scenarios.push({ spec, scores });
  }
  return { trialsPerScenario: trials, scenarios, totals };
}

export function cell(s: Score, emergency: boolean): string {
  const pct = (x: number) => `${Math.round((100 * x) / Math.max(1, s.trials))}%`;
  if (emergency) {
    const got = s.caught + s.caughtAfterAsk;
    return `${pct(got)} caught${s.caughtAfterAsk ? ` (${s.caughtAfterAsk} after asking)` : ''}`;
  }
  return `${pct(s.falseAlarms)} false alarm${s.prompts ? `, ${s.prompts} asked` : ''}`;
}

export function formatTable(t: EvalTable): string {
  const head = ['Scenario', 'Single phone', 'Any phone', 'Majority vote', 'Agents', 'Agents + room map'];
  const rows = t.scenarios.map(({ spec, scores }) => [`${spec.title}${spec.emergency ? ' (real)' : ''}`, ...METHODS.map((m) => cell(scores[m], spec.emergency))]);
  const tot = (m: Method) => {
    const s = t.totals[m];
    const emerg = s.caught + s.caughtAfterAsk + s.missed;
    return `missed ${s.missed}/${emerg}, false alarms ${s.falseAlarms}/${s.trials - emerg}, asked ${s.prompts}`;
  };
  rows.push(['All scenarios', ...METHODS.map(tot)]);
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [line(head), `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`, ...rows.map(line)].join('\n');
}

/**
 * The same scenarios decided by Claude agents with tools (needs an API key and
 * costs real calls, so it runs a few trials per scenario). Compared side by
 * side with the rule agents on the exact same evidence.
 */
export async function evaluateClaude(
  trials: number,
  brain: BrainOpts,
  specs: ScenarioSpec[] = SCENARIOS,
  log: (s: string) => void = () => {},
): Promise<string> {
  const rows: string[][] = [];
  const tot = { rules: empty(), claude: empty(), tools: 0, positions: 0, fallbacks: 0, floors: 0 };
  for (const spec of specs) {
    const rules = empty();
    const claude = empty();
    for (let k = 0; k < trials; k++) {
      const trial = generate(spec, k + 1);
      const map = simHomeMap(trial);
      const ruleRuns = await runAgents(trial, new Set(), map);
      const claudeRuns = await runAgents(trial, new Set(), map, brain);
      const dr = agentDecision(ruleRuns, trial);
      const dc = agentDecision(claudeRuns, trial);
      add(rules, spec.emergency, dr);
      add(claude, spec.emergency, dc);
      add(tot.rules, spec.emergency, dr);
      add(tot.claude, spec.emergency, dc);
      for (const r of claudeRuns)
        for (const p of r.positions) {
          tot.positions++;
          tot.tools += p.tools?.length ?? 0;
          if (!p.llm) tot.fallbacks++;
          if (p.floor) tot.floors++;
        }
      log(`${spec.key} #${k + 1}: rules ${dr}, Claude ${dc}`);
    }
    rows.push([`${spec.title}${spec.emergency ? ' (real)' : ''}`, cell(rules, spec.emergency), cell(claude, spec.emergency)]);
  }
  const sum = (s: Score) => {
    const emerg = s.caught + s.caughtAfterAsk + s.missed;
    return `missed ${s.missed}/${emerg}, false alarms ${s.falseAlarms}/${s.trials - emerg}, asked ${s.prompts}`;
  };
  rows.push(['All scenarios', sum(tot.rules), sum(tot.claude)]);
  const head = ['Scenario', 'Rule agents + map', 'Claude agents + map'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (r: string[]) => `| ${r.map((c, i) => c.padEnd(widths[i])).join(' | ')} |`;
  return [
    line(head),
    `|${widths.map((w) => '-'.repeat(w + 2)).join('|')}|`,
    ...rows.map(line),
    '',
    `Claude positions: ${tot.positions}, tool calls ${tot.tools} (${(tot.tools / Math.max(1, tot.positions)).toFixed(1)} per position), fell back to rules ${tot.fallbacks}, safety rule stepped in ${tot.floors}.`,
  ].join('\n');
}
