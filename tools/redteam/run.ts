import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { agentDecision, runAgents, type Decision, type IncidentRun } from '../../src/agents/eval';
import { generate, LAYOUT } from '../../src/agents/sim';
import { ruleIntent } from '../../src/agents/intent';
import { Rng } from '../../src/sim/random';
import { FAMILIES } from './families';
import { HOLDOUT, type RTSpec } from './holdout';

/**
 * Offline red team. Runs adversarial scenario families through the frozen
 * phone agents + rule role agents, records every run, classifies failures,
 * and (with --holdout) runs the held-out set once at the end.
 * No Claude calls: where Claude would negotiate, the run is flagged.
 */

type Verdict = 'ok' | 'caught_by_question' | 'nuisance_question' | 'nuisance_countdown' | 'MISSED' | 'FALSE_CALL_RISK';
interface Row {
  family: string;
  variant: number;
  seed: number;
  emergency: boolean;
  phones: number;
  triggers: string;
  evidence: string;
  positions: string;
  outcome: string;
  negotiates: boolean;
  screamAsk: boolean;
  decision: Decision;
  live: string;
  verdict: Verdict;
  category: string;
  note: string;
}

const fmt = (n: number | null | undefined) => (n === null || n === undefined ? '-' : Math.round(n).toString());

function evidenceOf(runs: IncidentRun[]): string {
  const r = runs[0];
  if (!r) return 'no incident';
  return r.reports
    .map((x) => `${x.name.replace('Phone ', 'P')}[imp ${fmt(x.sound.impactDb)}${x.sound.impactAi ? ' ' + x.sound.impactAi.group : ''} burst ${fmt(x.sonar.burstDb)} saw ${x.sonar.sawPersonBefore ? 'Y' : 'n'} moved ${x.sonar.motionResumed ? 'Y' : 'n'} ${x.sonar.online ? '' : 'OFF '}${x.sound.distress ? 'DISTRESS ' : ''}${x.sound.media ? `tv${Math.round(x.sound.media * 100)}` : ''}]`)
    .join(' ');
}

function finals(r: IncidentRun) {
  const last = new Map<string, (typeof r.positions)[number]>();
  for (const p of r.positions) last.set(p.agent, p);
  return [...last.values()];
}

function classify(spec: RTSpec, runs: IncidentRun[], decision: Decision): { verdict: Verdict; category: string; note: string } {
  if (spec.emergency) {
    if (decision === 'alarm') return { verdict: 'ok', category: '', note: '' };
    if (decision === 'ask') return { verdict: 'caught_by_question', category: '', note: 'asked first; a missing answer calls in 40 s' };
    if (!runs.length) return { verdict: 'MISSED', category: 'sensing', note: 'no phone triggered at all' };
    const reps = runs.flatMap((r) => r.reports);
    const strong = reps.some((x) => x.sonar.burstDb >= 16 && x.sonar.sawPersonBefore) || reps.some((x) => (x.sound.impactDb ?? 0) >= 20);
    const resumed = reps.some((x) => x.sonar.motionResumed);
    if (!strong) return { verdict: 'MISSED', category: 'sensing', note: 'evidence too weak to see a fall' };
    if (resumed) return { verdict: 'MISSED', category: 'sensing', note: 'a phone reported movement afterwards (sim noise or fidget read as getting up)' };
    const args = runs.flatMap((r) => finals(r).map((p) => p.argument)).join(' ');
    if (/tv|media|movie/i.test(args)) return { verdict: 'MISSED', category: 'evidence semantics', note: 'TV/media explanation won' };
    if (/tap|object|harmless/i.test(args)) return { verdict: 'MISSED', category: 'evidence semantics', note: 'sound label (tap/object) explained it away' };
    return { verdict: 'MISSED', category: 'agent reasoning', note: 'strong evidence, agents stood down' };
  }
  if (decision === 'none') return { verdict: 'ok', category: '', note: '' };
  if (decision === 'ask') return { verdict: 'nuisance_question', category: 'escalation policy', note: 'asked "Are you OK?"; they answer and it closes' };
  const reps = runs.flatMap((r) => r.reports);
  const cat = spec.compromised ? 'consensus / trust' : spec.media ? 'evidence semantics' : reps.some((x) => (x.sound.impactDb ?? 0) >= 15 && x.sonar.burstDb >= 16) ? 'sensing' : 'agent reasoning';
  return { verdict: 'nuisance_countdown', category: cat, note: 'countdown "you may have fallen"; a call only if they cannot answer within 25 s' };
}

async function runSpec(spec: RTSpec, family: string, variant: number, seed: number): Promise<Row> {
  const layout = LAYOUT.slice(0, spec.phones ?? 3);
  const trial = generate(spec, seed, layout);
  const runs = await runAgents(trial);
  const decision = agentDecision(runs, trial);
  const negotiates = runs.some((r) => r.outcome.kind === 'ask_human' && finals(r).length === 3 && r.incident.trigger.kind !== 'help_pressed' && r.incident.trigger.kind !== 'scream');
  const screamAsk = runs.some((r) => r.incident.trigger.kind === 'scream');
  // Live: a scream trigger asks at once whatever the agents later say.
  const effective: Decision = decision === 'none' && screamAsk ? 'ask' : decision;
  const c = classify(spec, runs, effective);
  return {
    family,
    variant,
    seed,
    emergency: spec.emergency,
    phones: layout.length,
    triggers: runs.map((r) => `${r.incident.trigger.name.replace('Phone ', 'P')}:${r.incident.trigger.kind}`).join(',') || '-',
    evidence: evidenceOf(runs),
    positions: runs.map((r) => finals(r).map((p) => `${p.agent[0].toUpperCase()}=${p.stance}`).join(' ')).join(' | ') || '-',
    outcome: runs.map((r) => r.outcome.kind).join(',') || 'none',
    negotiates,
    screamAsk,
    decision: effective,
    live: effective === 'alarm' ? 'countdown 25 s -> call unless "I\'m OK"' : effective === 'ask' ? 'ask -> call after 40 s silence' : 'nothing',
    ...c,
  };
}

/** Spoken answers, as the speech model might transcribe them (with prompt leakage and mis-hearings). */
const SPEECH: [string, 'ok' | 'help' | 'unclear' | 'ok|unclear' | 'help|unclear'][] = [
  ["I'm okay", 'ok'], ['i am ok', 'ok'], ["I'm fine thanks", 'ok'], ['yeah I am okay', 'ok'], ['yes', 'ok'], ['ok', 'ok'],
  ["no I'm fine", 'ok'], ["no no I'm okay don't call", 'ok'], ["I'm alright", 'ok'], ["um I'm fine", 'ok'], ['false alarm', 'ok'],
  ["I'm fine I'm fine", 'ok'], ["I'm good", 'ok'], ['all good', 'ok'],
  ["No, I'm hurt", 'help'], ['help', 'help'], ['help me', 'help'], ["I can't get up", 'help'], ['I fell', 'help'], ["I've fallen", 'help'],
  ['my hip hurts', 'help'], ["I'm not okay", 'help'], ['not okay', 'help'], ['call an ambulance', 'help'], ['ow ow it hurts', 'help'],
  ["I'm bleeding", 'help'], ["I'm on the floor", 'help'], ['please help', 'help'], ['call my daughter', 'help'],
  ["I'm okay but my hip hurts", 'help|unclear'], ["yeah I'm hurt", 'help'], ["I can't move my leg", 'help'],
  ['no', 'unclear'], ['nope', 'unclear'], ['no no no', 'unclear'], ['', 'unclear'], ['what', 'unclear'],
  ["and then she said the doctor is fine okay so I'll call you later", 'unclear'],
  ["the TV is so loud okay whatever let's watch the news", 'unclear'],
  // Prompt leakage at the start of the clip (the bug class seen in real runs).
  ["or say help I am okay", 'ok'], ["say I'm okay or say help I'm fine", 'ok'], ['are you ok yes', 'ok'],
  ['it looks like you may have fallen if you are ok say i am ok', 'unclear'],
  ['otherwise i will call for help', 'unclear'],
  ['i heard someone cry out are you ok do you need help', 'unclear'],
  ["do you need help i'm okay", 'ok'],
  ['do you need help no', 'unclear'],
  ['are you ok do you need help yes', 'unclear'],
  ['do you need help yes', 'unclear'],
  // Mis-hearings by the speech model.
  ["I'm o k", 'ok|unclear'], ['I am fined', 'ok|unclear'], ['hell me', 'help|unclear'], ["I can't get op", 'help|unclear'],
];

async function main() {
  const holdout = process.argv.includes('--holdout');
  const variants = Number(process.env.RT_VARIANTS ?? 10);
  const rows: Row[] = [];
  if (!holdout) {
    for (const f of FAMILIES) {
      for (let v = 0; v < variants; v++) {
        const r = new Rng(1000 + v * 97 + f.id.length * 13 + f.id.charCodeAt(1));
        const spec: RTSpec = { key: `${f.id}#${v}`, family: f.id, ...f.gen(r) } as RTSpec;
        spec.emergency = f.emergency;
        rows.push(await runSpec(spec, f.id, v, 11 + v));
      }
    }
  } else {
    for (const h of HOLDOUT) for (let s = 1; s <= 10; s++) rows.push(await runSpec(h, h.key, s, 500 + s));
  }
  mkdirSync('redteam-out', { recursive: true });
  const name = holdout ? 'holdout' : 'families';
  writeFileSync(`redteam-out/${name}.json`, JSON.stringify(rows, null, 1));
  const speech = SPEECH.map(([t, want]) => {
    const got = ruleIntent(t).answer;
    return { t, want, got, pass: want.split('|').includes(got) };
  });
  if (!holdout) writeFileSync('redteam-out/speech.json', JSON.stringify(speech, null, 1));

  // Console summary
  const by = (k: (r: Row) => string) => rows.reduce<Record<string, number>>((a, r) => ((a[k(r)] = (a[k(r)] ?? 0) + 1), a), {});
  console.log(`${rows.length} runs (${name})`);
  console.log('verdicts', by((r) => `${r.emergency ? 'EMERG' : 'normal'} ${r.verdict}`));
  console.log('negotiation would run in', rows.filter((r) => r.negotiates).length, 'runs');
  const fam: Record<string, Record<string, number>> = {};
  for (const r of rows) ((fam[r.family] ??= {})[r.verdict] = (fam[r.family]?.[r.verdict] ?? 0) + 1);
  for (const [f, v] of Object.entries(fam)) console.log(f.padEnd(28), JSON.stringify(v), 'neg', rows.filter((r) => r.family === f && r.negotiates).length);
  const bad = rows.filter((r) => r.verdict === 'MISSED' || r.verdict === 'nuisance_countdown');
  console.log('\nfailure categories', by((r) => (r.category && (r.verdict === 'MISSED' || r.verdict === 'nuisance_countdown') ? `${r.verdict}: ${r.category}` : 'n/a')));
  for (const r of bad) console.log(`\n${r.family}#${r.variant} ${r.verdict} [${r.category}] ${r.note}\n  trig ${r.triggers}\n  ${r.evidence}\n  ${r.positions} -> ${r.outcome}`);
  if (!holdout) {
    console.log('\nspeech', speech.filter((s) => s.pass).length, '/', speech.length);
    for (const s of speech.filter((x) => !x.pass)) console.log(`  FAIL "${s.t}" want ${s.want} got ${s.got}`);
  }
  console.log('\nholdout sha256', createHash('sha256').update(readFileSync('tools/redteam/holdout.ts')).digest('hex'));
}

main();
