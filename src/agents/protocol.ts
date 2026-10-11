import { cartograph, type HomeMap } from './cartographer';
import { ROLES, type DeliberationContext } from './roles';
import type { AgentTrace, EvidenceReport, Incident, Outcome, Position, RoleName } from './types';
import { negotiateThink } from './negotiator';
import { agreed, nearAgreement, negotiatedOutcome, noDeal, openingPlan, type Move, type Plan } from './negotiation';
import type { LlmConfig } from './llm';

/**
 * The deliberation protocol.
 *
 * Round 1: each role agent posts a position independently (none sees another's).
 * Round 2: each agent reads every round 1 position and may change its mind.
 * Outcome: a fixed public rule over the round 2 positions. There is no judge
 * agent; anyone holding the board can recompute the outcome and check it.
 *
 *   escalate    no agent says stand down, and at least two say escalate
 *   stand down  no agent says escalate, and at least two say stand down
 *   ask human   anything else: the disagreement is kept on the record and the
 *               person is asked directly. No answer in time means escalate.
 */

export const ORDER: RoleName[] = ['auditor', 'responder', 'skeptic'];

export interface BrainOpts {
  cfg: LlmConfig;
  budgetMs?: number;
  onTrace?: (t: AgentTrace) => void;
}

export type Voice = (pos: Position, ctx: DeliberationContext) => Promise<Position>;

export interface DeliberationResult {
  positions: Position[];
  outcome: Outcome;
  moves?: Move[];
}

export async function deliberate(
  incident: Incident,
  reports: EvidenceReport[],
  opts: {
    now?: () => number;
    seenFingerprints?: Set<string>;
    voice?: Voice;
    onPosition?: (p: Position) => void;
    /** Pause between rounds, for the live feed. */
    pause?: (ms: number) => Promise<void>;
    /** The home's room map (enables the Cartographer). */
    map?: HomeMap;
    /** Agent mode: every role agent is Claude with tools (replay: phones cannot be asked again). */
    brain?: BrainOpts;
  } = {},
): Promise<DeliberationResult> {
  const now = opts.now ?? Date.now;
  const seen = opts.seenFingerprints ?? new Set<string>();
  const voice = opts.voice;
  const context = opts.map ? cartograph(opts.map, reports) : undefined;
  const base = { incident, reports, seenFingerprints: seen, context };

  const r1Ctx: DeliberationContext = { ...base, round: 1, prior: [], now: now() };
  // Round 1 positions are formed independently. The role agents are local and free.
  const round1 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r1Ctx, now: now() });
      return voice ? await voice(draft, r1Ctx) : draft;
    }),
  );
  for (const p of round1) opts.onPosition?.(p);
  if (opts.pause) await opts.pause(1200);

  const r2Ctx: DeliberationContext = { ...base, round: 2, prior: round1, now: now() };
  const round2 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r2Ctx, now: now() });
      return voice ? await voice(draft, r2Ctx) : draft;
    }),
  );
  for (const p of round2) opts.onPosition?.(p);
  const outcome = resolve(incident, round2, reports, now());
  // Disagreement is negotiated (each role agent its own Claude); agreement never touches Claude.
  const brain = opts.brain;
  const contested = outcome.kind === 'ask_human';
  if (brain && contested && incident.trigger.kind !== 'help_pressed') {
    const transcript: Move[] = round2.map((p) => ({ id: `${p.agent}-0`, incidentId: incident.id, agent: p.agent as RoleName, round: 0, kind: 'offer', plan: openingPlan(p), argument: p.argument, llm: false, postedAt: now() }));
    if (!agreed(transcript.map((m) => m.plan))) {
      const ctx: DeliberationContext = { ...base, round: 3, prior: round2, now: now() };
      let deal: Plan | null = null;
      let round = 0;
      while (!deal && round < 3) {
        round++;
        const moves = await Promise.all(ORDER.map((role) => negotiateThink(brain.cfg, ctx, role, round, round === 3, transcript, {}, { budgetMs: brain.budgetMs ?? 30000, onTrace: brain.onTrace })));
        for (const m of moves) if (m) transcript.push(m);
        const now3 = ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r)!.plan);
        deal = agreed(now3) ?? (round >= 3 ? nearAgreement(now3) : null);
      }
      const plan = deal ?? noDeal(ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r)!.plan));
      return { positions: [...round1, ...round2], outcome: negotiatedOutcome(outcome, transcript, plan, !!deal, round), moves: transcript };
    }
  }
  return { positions: [...round1, ...round2], outcome };
}

/**
 * The team was split (the rule said "ask the person"). The Investigator's
 * finding settles it, within the safety rules it already obeyed: it can only
 * stand down with a confident, evidenced finding, and can never overrule a
 * contradiction between phones.
 */
export function withInvestigator(o: Outcome, inv: Position): Outcome {
  if (!inv.llm) return { ...o, summary: `${o.summary} The Investigator could not look into it.` };
  const keep = o.dissent;
  if (inv.stance === 'stand_down' && inv.confidence >= 0.7 && !inv.floor) {
    return { ...o, kind: 'stand_down', unanimous: false, headline: 'Investigator settled it: no emergency', summary: `Investigator: ${inv.argument}`, dissent: keep };
  }
  if (inv.stance === 'escalate') {
    return { ...o, kind: 'escalate', unanimous: false, headline: 'Investigator settled it: get help', summary: `Investigator: ${inv.argument}`, dissent: keep };
  }
  return { ...o, headline: 'Still not sure: asking the person', summary: `Investigator: ${inv.argument} ${o.summary}` };
}

export function resolve(incident: Incident, finals: Position[], reports: EvidenceReport[], t: number): Outcome {
  const esc = finals.filter((p) => p.stance === 'escalate');
  const down = finals.filter((p) => p.stance === 'stand_down');
  let kind: Outcome['kind'];
  // Witnesses that contradict each other with no tie breaker: never stand down on that.
  const conflict = finals.find((p) => p.conflict)?.conflict;
  // Someone asked for help in person: no argument overrides that.
  if (incident.trigger?.kind === 'help_pressed') kind = 'escalate';
  else if (conflict) kind = 'ask_human';
  else if (!down.length && esc.length >= 2) kind = 'escalate';
  else if (!esc.length && down.length >= 2) kind = 'stand_down';
  else kind = 'ask_human';
  const unanimous = (kind === 'escalate' && esc.length === finals.length) || (kind === 'stand_down' && down.length === finals.length);
  const dissent = finals
    .filter((p) => (kind === 'escalate' ? p.stance !== 'escalate' : kind === 'stand_down' ? p.stance !== 'stand_down' : true))
    .map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
  const trust = finals.find((p) => p.agent === 'auditor')?.trust ?? {};
  const quarantined = reports.filter((r) => (trust[r.nodeId]?.score ?? 1) < 0.3 && !trust[r.nodeId]?.reasons.some((x) => x.includes('phone moved') || x.includes('phone itself'))).map((r) => r.name);

  const lead = (role: RoleName) => finals.find((p) => p.agent === role)!;
  let headline: string;
  let summary: string;
  if (kind === 'escalate') {
    headline = unanimous ? 'All three agents agree: get help' : 'Agents agree: get help';
    summary = `Responder: ${lead('responder').argument}`;
  } else if (kind === 'stand_down') {
    headline = unanimous ? 'All three agents agree: no emergency' : 'Agents agree: no emergency';
    const why = lead('skeptic').stance === 'stand_down' ? lead('skeptic') : lead('auditor');
    summary = `${why === lead('skeptic') ? 'Skeptic' : 'Auditor'}: ${why.argument}`;
  } else {
    headline = conflict ? 'Phones contradict each other: asking the person' : 'Agents disagree: asking the person';
    summary = `${finals.map((p) => `${cap(p.agent)} says ${stanceWord(p.stance)}`).join(', ')}. The disagreement is kept and the person is asked directly; no answer means help is called.`;
  }
  if (quarantined.length) summary += ` ${quarantined.join(' and ')} flagged as untrustworthy.`;
  return { incidentId: incident.id, kind, unanimous, headline, summary, dissent, quarantined, decidedAt: t };
}

function cap(s: string): string {
  return s[0].toUpperCase() + s.slice(1);
}
export function stanceWord(s: Position['stance']): string {
  return s === 'escalate' ? 'get help' : s === 'stand_down' ? 'stand down' : 'not sure';
}
