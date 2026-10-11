import { call, lookWords, type BrainTools, type Usage } from './brain';
import { compactReport, type LlmConfig } from './llm';
import { summarize } from './memory';
import { describePlan, LADDER, normalisePlan, type Move, type MoveKind, type Plan } from './negotiation';
import { uid } from './phoneAgent';
import { auditor, ROLE_INFO, type DeliberationContext } from './roles';
import type { AgentTrace, RoleName } from './types';

/**
 * One role agent's turn in a negotiation, as Claude with its own goal. It reads
 * the evidence and everything said so far, may check a disputed fact (ask the
 * phones to look again, the room map, the physics, the home history), and
 * makes exactly one move: an offer, a challenge to another agent's claim, a
 * concession, a counter offer, or acceptance of someone's plan.
 */

const GOALS: Record<RoleName, string> = {
  responder:
    'You speak for the person. Your goal is that a real fall is never left unanswered. Push for the strongest response the evidence supports, but you lose credibility if you ignore evidence that they are fine.',
  skeptic:
    'You speak for the household against false alarms: every needless call scares the family and makes them switch the system off. Push for the lightest response the evidence allows, but never argue someone is fine when the evidence says they may be on the floor.',
  auditor:
    'You trust no phone by default. Your goal is that the decision rests only on evidence that checks out across phones. Side with whoever the trustworthy evidence supports, call out claims built on a phone that was moved, replayed, or contradicted, and propose conditions that test the disputed fact.',
};

const TOOLS = [
  {
    name: 'ask_all_phones',
    description: 'Broadcast one request on the channel: every phone looks again right now (optionally after waiting up to 10 s) and replies with whether it sees someone, movement, distance, breathing, sounds since. Use it to settle a disputed fact.',
    input_schema: { type: 'object', properties: { wait_seconds: { type: 'number' } }, additionalProperties: false },
  },
  {
    name: 'ask_cartographer',
    description: 'Ask the Cartographer what the room map says: where the bang came from, where the person ended up, whether that is a usual resting spot.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'physics_check',
    description: "Check each phone's report against physics and the other phones (moved, replayed, contradicted). Returns trust per phone.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'home_history',
    description: "What this home learned from people's answers before: phones that cry wolf, harmless sounds at this time of day.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'make_move',
    description: 'Make your one move for this round. Call it exactly once.',
    input_schema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['offer', 'challenge', 'concede', 'counter', 'accept'], description: 'offer: first proposal. challenge: dispute a specific claim of another agent with evidence. concede: admit another agent is right about a claim. counter: propose a different plan, usually meeting them part way. accept: agree to another agent\'s current plan exactly.' },
        to: { type: 'string', enum: ['responder', 'skeptic', 'auditor'], description: 'Whose claim or plan this answers (not for offer).' },
        claim: { type: 'string', description: 'The claim you challenge or concede, in a few words.' },
        action: { type: 'string', enum: [...LADDER], description: 'The plan you now stand behind: none, watch, ask, urgent, call.' },
        call_if_no_movement_s: { type: 'number', description: 'Optional condition: call at once if no phone sees movement within this many seconds (10 to 120).' },
        argument: { type: 'string', description: 'One or two plain sentences to the other agents, citing phones by name and numbers.' },
      },
      required: ['kind', 'action', 'argument'],
      additionalProperties: false,
    },
  },
];

const SYSTEM = (role: RoleName) =>
  [
    `You are the ${ROLE_INFO[role].title} agent in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance, body movement) and on-phone sound recognition.`,
    `Your goal: ${GOALS[role]}`,
    'The three agents (Responder, Skeptic, Auditor) disagree about this incident, so you are negotiating what to do. Nobody can overrule the others: you must reach one plan all three accept. If there is no deal after the last round, nobody wins: the disagreement is kept on the record and the person is asked out loud (no answer calls for help). It is fine not to agree when the evidence really is not enough; do not give in just to reach a deal.',
    'The actions, lightest to strongest: none (nothing; they are still asked if nobody moves for a minute), watch (keep watching, ask if nobody moves), ask (gentle "Are you OK?", call if no answer in 40 s), urgent ("It looks like you may have fallen", call in 25 s unless they say they are OK), call (call the family now). A plan may add: call at once if no phone sees movement within N seconds.',
    'Negotiate like a sharp, fair colleague: challenge the specific claim you think is wrong and say why with evidence; concede a point when the evidence is against you; move toward the others when they are right; accept a plan you can live with. Do not repeat yourself. If a fact is disputed, check it with a tool instead of arguing (in one turn; tools run in parallel), but only if it would change a mind.',
    'Readings: impact dB is above that phone\'s quiet level (20+ is a real bang). sound_model_says is the on-phone recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted. phone_itself_moved means its sonar described the phone, not the room.',
    'Say only what the readings show: someone "disappeared" only if a phone has last_saw_person_s_before set and nobody is present after; if nobody was seen before either, say "no phone can see anyone". The countdown is 25 s and the gentle question waits 40 s: use those numbers, do not invent others.',
    'Evidence rules: never infer missing evidence (no working sonar means unknown, not nobody there); a phone that did not hear or see something is not lying unless it could clearly have observed it; name the phone behind every claim.',
    'Speak in one or two plain sentences, phones by name, numbers. No jargon, no dashes.',
  ].join('\n');

export async function negotiateThink(
  cfg: LlmConfig,
  ctx: DeliberationContext,
  role: RoleName,
  round: number,
  lastRound: boolean,
  transcript: Move[],
  tools: BrainTools,
  opts: { budgetMs: number; onTrace?: (t: AgentTrace) => void; onUsage?: (u: Usage | undefined) => void; canSpend?: () => boolean; onError?: (e: Error) => void },
): Promise<Move | null> {
  const deadline = Date.now() + opts.budgetMs;
  let step = 0;
  const trace = (kind: AgentTrace['kind'], summary: string, tool?: string) =>
    opts.onTrace?.({ incidentId: ctx.incident.id, agent: role, round: round + 2, step: ++step, kind, tool, summary: summary.slice(0, 400), t: Date.now() });
  const mine = [...transcript].reverse().find((m) => m.agent === role);
  const fallbackPlan: Plan = mine?.plan ?? { action: 'ask' };
  const findings: string[] = [];
  const brief = {
    round,
    last_round: lastRound,
    what_happened: { trigger: ctx.incident.trigger.kind, phone: ctx.incident.trigger.name, detail: ctx.incident.trigger.detail },
    evidence: ctx.reports.map((r) => compactReport(r)),
    room_map: ctx.context?.notes ?? null,
    said_so_far: transcript.map((m) => ({ round: m.round, agent: m.agent, move: m.kind, to: m.to ?? undefined, claim: m.claim ?? undefined, plan: describePlan(m.plan), argument: m.argument, checked: m.findings?.length ? m.findings : undefined })),
    your_current_plan: mine ? describePlan(mine.plan) : null,
    task: lastRound ? 'Last round: accept a plan you can live with, or state your final plan.' : 'Make your move.',
  };
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: JSON.stringify(brief) }];

  const run = async (name: string, input: Record<string, unknown>): Promise<{ result: unknown; summary: string }> => {
    if (name === 'ask_all_phones') {
      if (!tools.lookNow) return { result: { note: 'not available in this replay' }, summary: 'not available in this replay' };
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6000) / 1000));
      const r = (await tools.lookNow(ctx.incident.id, 'all', waitS)) as { replies?: { phone: string; look: Record<string, unknown> }[]; no_reply?: string[] };
      const parts = (r.replies ?? []).map((x) => `${x.phone}: ${lookWords(x.look)}`);
      if (r.no_reply?.length) parts.push(`no reply from ${r.no_reply.join(', ')}`);
      return { result: r, summary: `broadcast to every phone${waitS >= 1 ? ` (after ${Math.round(waitS)} s)` : ''}: ${parts.join('; ') || 'no replies'}` };
    }
    if (name === 'ask_cartographer') {
      const c = ctx.context;
      return c ? { result: { notes: c.notes, ended_at: c.endedAt?.place.name ?? null, bang_from: c.source?.name ?? null }, summary: c.notes.slice(0, 2).join('; ') } : { result: { note: 'no room map yet' }, summary: 'no room map yet' };
    }
    if (name === 'physics_check') {
      // Fresh check: the current reports are already in the replay memory, so do not compare them with themselves.
      const a = auditor({ ...ctx, round: 1, prior: [], seenFingerprints: new Set() });
      const low = ctx.reports.filter((r) => (a.trust?.[r.nodeId]?.score ?? 1) < 0.5);
      return {
        result: { trust: Object.fromEntries(ctx.reports.map((r) => [r.name, { trust: +(a.trust?.[r.nodeId]?.score ?? 1).toFixed(2), reasons: a.trust?.[r.nodeId]?.reasons ?? [] }])), conflict: a.conflict ?? null },
        summary: a.conflict ? `conflict: ${a.conflict}` : low.length ? `low trust: ${low.map((r) => r.name).join(', ')}` : 'every phone checks out',
      };
    }
    if (name === 'home_history') {
      const h = summarize(ctx.memory ?? tools.memory?.(), tools.names?.() ?? {}, ctx.reports, ctx.incident.t0);
      return { result: h, summary: h.note ? String(h.note) : `${h.incidents_remembered} past incidents${h.pattern ? `; ${h.pattern}` : ''}` };
    }
    return { result: { error: 'unknown tool' }, summary: 'unknown tool' };
  };

  try {
    for (let turn = 0; turn < 3; turn++) {
      const left = deadline - Date.now();
      if (left < 2500) throw new Error('out of time');
      if (opts.canSpend && !opts.canSpend()) throw new Error("today's Claude budget is used up");
      const final = turn === 2 || left < 8000;
      const body = await call(cfg, { system: SYSTEM(role), messages, tools: TOOLS, tool_choice: final ? { type: 'tool', name: 'make_move' } : { type: 'auto' }, max_tokens: 350 }, Math.min(left - 500, cfg.timeoutMs), deadline);
      opts.onUsage?.(body.usage);
      messages.push({ role: 'assistant', content: body.content });
      const text = body.content.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.trim()).join(' ');
      if (text) trace('thought', text);
      const calls = body.content.filter((b) => b.type === 'tool_use');
      const move = calls.find((c) => c.name === 'make_move');
      if (move) return toMove(move.input ?? {});
      if (!calls.length) {
        messages.push({ role: 'user', content: 'Make your move now with make_move.' });
        continue;
      }
      const results = await Promise.all(
        calls.map(async (c) => {
          const { result, summary } = await run(c.name!, c.input ?? {});
          findings.push(`${c.name}: ${summary}`.slice(0, 240));
          trace('tool', summary, c.name);
          return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result).slice(0, 2500) };
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    throw new Error('no move');
  } catch (e) {
    opts.onError?.(e as Error);
    trace('fallback', `could not make a move (${(e as Error).message.slice(0, 100)}); keeps its plan`);
    return null;
  }

  function toMove(o: Record<string, unknown>): Move {
    const kind: MoveKind = ['offer', 'challenge', 'concede', 'counter', 'accept'].includes(String(o.kind)) ? (o.kind as MoveKind) : 'counter';
    let plan = normalisePlan({ action: o.action, call_if_no_movement_s: o.call_if_no_movement_s }, fallbackPlan);
    const to = ['responder', 'skeptic', 'auditor'].includes(String(o.to)) && o.to !== role ? (o.to as RoleName) : null;
    // "Accept" means exactly the other agent's current plan.
    if (kind === 'accept' && to) {
      const theirs = [...transcript].reverse().find((m) => m.agent === to);
      if (theirs) plan = { ...theirs.plan };
    }
    return {
      id: uid('move'),
      incidentId: ctx.incident.id,
      agent: role,
      round,
      kind,
      to,
      claim: typeof o.claim === 'string' ? o.claim.slice(0, 160) : null,
      plan,
      argument: (typeof o.argument === 'string' && o.argument.trim() ? o.argument.trim() : describePlan(plan)).replace(/\s*[—–]\s*/g, ', ').slice(0, 500),
      findings,
      llm: true,
      postedAt: Date.now(),
    };
  }
}
