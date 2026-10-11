import type { AgentName, Outcome, Position, RoleName, Stance } from './types';

/**
 * Negotiation: when the three role agents disagree, they do not vote. They
 * bargain over what to actually do, on a ladder of real actions, each pulling
 * toward its own goal (the Responder up, the Skeptic down, the Auditor toward
 * whatever the trustworthy evidence supports), until they agree on one plan.
 *
 *   none    nothing (still asks if nobody moves for a minute)
 *   watch   keep watching; ask if nobody moves for a while
 *   ask     "Are you OK?"; call if no answer
 *   urgent  "It looks like you may have fallen"; call in 25 s unless they say OK
 *   call    call the family now
 *
 * A plan can carry one condition both sides can live with: "call early if no
 * phone sees movement within N seconds".
 */

export const LADDER = ['none', 'watch', 'ask', 'urgent', 'call'] as const;
export type Action = (typeof LADDER)[number];

export interface Plan {
  action: Action;
  /** Call at once if no phone sees movement within this many seconds (asking or watching meanwhile). */
  callIfNoMovementS?: number | null;
}

export type MoveKind = 'offer' | 'challenge' | 'concede' | 'counter' | 'accept';

export interface Move {
  id: string;
  incidentId: string;
  agent: RoleName;
  round: number;
  kind: MoveKind;
  /** Who the move answers, for a challenge or a concession. */
  to?: AgentName | null;
  /** The claim being challenged or conceded, in a few words. */
  claim?: string | null;
  /** The plan this agent now stands behind. */
  plan: Plan;
  /** One or two plain sentences to the others. */
  argument: string;
  /** Facts it checked this round (what a phone said, what the map says). */
  findings?: string[];
  llm: boolean;
  postedAt: number;
}

export const ACTION_WORDS: Record<Action, string> = {
  none: 'do nothing',
  watch: 'keep watching',
  ask: 'ask "Are you OK?"',
  urgent: 'say "you may have fallen" and count down',
  call: 'call the family now',
};

export function describePlan(p: Plan): string {
  return `${ACTION_WORDS[p.action]}${p.callIfNoMovementS && p.action !== 'call' ? `, and call at once if nobody moves within ${p.callIfNoMovementS} s` : ''}`;
}

export function rank(a: Action): number {
  return LADDER.indexOf(a);
}

/** Where each agent's own position puts it on the ladder before anyone talks. */
export function openingPlan(p: Position): Plan {
  const s: Stance = p.stance;
  if (s === 'escalate') return { action: p.agent === 'responder' ? 'call' : 'urgent' };
  if (s === 'uncertain') return { action: 'ask' };
  return { action: p.agent === 'skeptic' ? 'none' : 'watch' };
}

/** Two plans count as the same deal when the action matches and any conditions are within 10 s of each other. */
/** Same deal: the same action. The condition is a detail, so differences there are merged rather than blocking agreement. */
export function samePlan(a: Plan, b: Plan): boolean {
  return a.action === b.action;
}

/**
 * Agreement is decided on the structured plan, never on the wording: all three
 * on the same action is a deal. Their conditions merge to the most careful one
 * (the shortest "call if nobody moves within N s" that anyone asked for).
 */
export function agreed(plans: Plan[]): Plan | null {
  if (plans.length < 3 || !plans.every((p) => p.action === plans[0].action)) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x): x is number => !!x);
  return { action: plans[0].action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}

/**
 * After the last round: if all three want the person asked and only differ on
 * how urgently (the gentle question or the countdown), that is agreement on
 * what matters; the more careful of the two is used. Anything wider is no deal.
 */
export function nearAgreement(plans: Plan[]): Plan | null {
  const ranks = plans.map((p) => rank(p.action));
  if (plans.length < 3 || Math.min(...ranks) < rank('ask') || Math.max(...ranks) > rank('urgent')) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x): x is number => !!x);
  return { action: Math.max(...ranks) === rank('urgent') ? 'urgent' : 'ask', callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}

/**
 * No deal after the last round. In a safety system a forced compromise would
 * throw away what the disagreement says: the evidence is not enough to decide.
 * So the disagreement stays on the record and the person is asked; if they
 * cannot answer, a fixed safety rule calls for help.
 *   - someone still wants a call or the countdown: the countdown ("it looks
 *     like you may have fallen"), which only the person can cancel;
 *   - otherwise, if anyone wants to ask: the gentle question;
 *   - if nobody wants more than watching: keep watching (nobody thinks it is
 *     an emergency, they only differ on how closely to watch).
 * The most careful condition anyone offered is kept.
 */
export function noDeal(plans: Plan[]): Plan {
  const top = Math.max(...plans.map((p) => rank(p.action)));
  const action: Action = top >= rank('urgent') ? 'urgent' : top >= rank('ask') ? 'ask' : 'watch';
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x): x is number => !!x);
  return { action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}

export function normalisePlan(x: unknown, fallback: Plan): Plan {
  const o = (x ?? {}) as { action?: string; call_if_no_movement_s?: number | null; callIfNoMovementS?: number | null };
  const action = (LADDER as readonly string[]).includes(o.action ?? '') ? (o.action as Action) : fallback.action;
  const raw = o.call_if_no_movement_s ?? o.callIfNoMovementS ?? null;
  const cond = typeof raw === 'number' && raw > 0 && action !== 'call' ? Math.round(Math.min(120, Math.max(10, raw))) : null;
  return { action, callIfNoMovementS: cond };
}

const TITLES: Record<RoleName, string> = { responder: 'Responder', skeptic: 'Skeptic', auditor: 'Auditor' };
const ROLES3: RoleName[] = ['auditor', 'responder', 'skeptic'];

/** The outcome of a negotiation: the plan, how it was reached, and who still disagrees. */
export function negotiatedOutcome(rule: Outcome, transcript: Move[], plan: Plan, deal: boolean, rounds: number): Outcome {
  const last = (r: RoleName) => [...transcript].reverse().find((m) => m.agent === r)!;
  const stanceOf = (p: Plan): Stance => (p.action === 'call' || p.action === 'urgent' ? 'escalate' : p.action === 'ask' ? 'uncertain' : 'stand_down');
  return {
    ...rule,
    kind: plan.action === 'call' || plan.action === 'urgent' ? 'escalate' : plan.action === 'ask' ? 'ask_human' : 'stand_down',
    unanimous: deal,
    headline: deal ? `Agents negotiated a plan: ${describePlan(plan)}` : `No agreement after ${rounds} rounds: the disagreement is kept and the person is asked`,
    summary: ROLES3.map((r) => `${TITLES[r]}: ${last(r).argument}`).join(' '),
    dissent: deal ? [] : ROLES3.filter((r) => !samePlan(last(r).plan, plan)).map((r) => ({ agent: r, stance: stanceOf(last(r).plan), argument: last(r).argument })),
    plan,
    negotiation: { rounds, agreed: deal },
    decidedAt: Date.now(),
  };
}
