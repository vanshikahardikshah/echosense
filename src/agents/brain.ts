import type { MapContext } from './cartographer';
import { compactReport, type LlmConfig } from './llm';
import { summarize, type HomeMemory } from './memory';
import { auditor, ROLE_INFO, ROLES, type DeliberationContext } from './roles';
import { uid } from './phoneAgent';
import type { AgentName, AgentTrace, Position, Stance } from './types';

/**
 * A role agent's brain in agent mode: Claude with tools.
 *
 * The agent gets the phone reports and its goal, then decides for itself what
 * to look at before taking a stance. It can run the physics checks, ask the
 * Cartographer what the room map says, ask a phone to look again right now
 * (and wait a few seconds for it), read what this home has learned from past
 * answers, or run its own role's checklist. It ends by posting a position.
 *
 * Every step is posted as a trace so the console shows what each agent chose
 * to look at. The rule agents stay underneath as a safety floor:
 *   - anything that fails, times out, or returns nonsense falls back to the
 *     rule position for that role,
 *   - someone pressing help is always "get help",
 *   - an agent cannot go straight to "no emergency" when its own role's
 *     checklist says "get help" (it is turned into "not sure", which means the
 *     person gets asked).
 */

export interface BrainTools {
  /** Ask a phone to look again now, optionally waiting first. */
  lookNow?: (incidentId: string, phone: string, waitS: number) => Promise<Record<string, unknown>>;
  /** What the Cartographer posted for this incident. */
  context?: () => MapContext | undefined;
  memory?: () => HomeMemory | undefined;
  /** Phone names by id, for the history summary. */
  names?: () => Record<string, string>;
}

const TOOLS = [
  {
    name: 'physics_check',
    description:
      "Check every phone's report against physics and against the other phones: did a bang that loud reach the other phones, does each phone's verdict follow from its own numbers, did a phone itself get moved, was the report replayed, do two phones tell opposite stories. Returns a trust score per phone with reasons.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_cartographer',
    description:
      'Ask the Cartographer agent what the room map says: which marked place (TV, sofa, a phone itself, the person) the loudness pattern fits best, where the person ended up, and whether that is a spot where someone usually rests.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'ask_all_phones',
    description:
      'Broadcast one request to every phone in the room to look again right now (one message on the shared channel; each phone answers with whether it sees someone, whether they move, distance, breathing and sounds since). Optionally every phone waits up to 10 seconds first. Use this before asking single phones.',
    input_schema: {
      type: 'object',
      properties: { wait_seconds: { type: 'number', description: '0 to 10' } },
      additionalProperties: false,
    },
  },
  {
    name: 'ask_phone',
    description:
      'Ask one phone to look again right now. The reports only cover the first 11 seconds after the incident; this returns what the phone measures now: whether it sees someone, whether they are moving, their distance, breathing, and any sounds since. You may ask it to wait up to 10 seconds first to see if anything changes.',
    input_schema: {
      type: 'object',
      properties: {
        phone: { type: 'string', description: 'Phone name exactly as in the evidence' },
        wait_seconds: { type: 'number', description: '0 to 10' },
      },
      required: ['phone'],
      additionalProperties: false,
    },
  },
  {
    name: 'home_history',
    description:
      "Read this home's memory: earlier incidents, what was decided, and what the person or caregiver said afterwards. Shows phones whose alarms keep turning out false and patterns like the same harmless sound at the same time of day.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'role_checklist',
    description: "Run your role's standard checklist over the evidence (the fixed rules every agent of your role follows). Returns the stance the checklist reaches and the facts it found. You may disagree with it.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'post_position',
    description: 'Post your position to the other agents. Call this exactly once, when you have decided.',
    input_schema: {
      type: 'object',
      properties: {
        stance: { type: 'string', enum: ['escalate', 'stand_down', 'uncertain'], description: 'escalate: call a caregiver now. stand_down: no emergency. uncertain: ask the person out loud (no answer means a caregiver is called).' },
        confidence: { type: 'number', description: '0 to 1' },
        argument: { type: 'string', description: 'One or two plain sentences to the other agents, citing phones by name and numbers.' },
        cited: { type: 'array', items: { type: 'string' }, description: 'The specific facts you relied on, short.' },
      },
      required: ['stance', 'confidence', 'argument'],
      additionalProperties: false,
    },
  },
];

const INVESTIGATOR_SYSTEM = [
  "You are the Investigator in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance and body movement) and on-phone sound recognition.",
  'Three local agents (Responder: never miss a fall; Skeptic: avoid false alarms; Auditor: check every phone against physics) already argued and could not agree. You are called in only now, to break the tie, and you are the only part of the system that costs money, so be quick.',
  'Go and look: ask_all_phones broadcasts one request to every phone to look again right now (add a few seconds of wait if someone may be down), ask_phone asks one phone directly, ask_cartographer reads the room map, home_history reads what this home learned, physics_check checks the phones against each other. Call the tools you need in one turn; they run in parallel. Two turns of looking is usually enough.',
  'Then post_position. "stand_down" only if what you found explains the event and shows the person is fine (moving normally, sitting where they usually sit, the bang came from the TV). "escalate" if what you found points to a fall: the phones then say "It looks like you may have fallen" and call the family in 25 s unless the person says they are OK. "uncertain" keeps the gentle "Are you OK?" question.',
  'Readings: impact dB is above that phone\'s quiet level (20+ is a real bang). sound_model_says is the on-phone sound recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted.',
  'Argument: one or two plain sentences citing what you found, phones by name, numbers. No jargon, no dashes.',
].join('\n');

const SYSTEM = (role: AgentName) =>
  role === 'investigator' ? INVESTIGATOR_SYSTEM :
  [
    `You are the ${ROLE_INFO[role].title} agent in Witness, the safety system in an older person's home. Phones around the room sense with sonar (distance and body movement) and a sound recognition model.`,
    `Your goal: ${ROLE_INFO[role].goal}`,
    'Three agents with different goals (Responder, Skeptic, Auditor) argue over the same evidence. A Cartographer agent knows the room map but does not vote. Nobody decides alone. The public rule: get help if no agent says stand down and at least two say escalate; no emergency if no agent says escalate and at least two say stand down; anything else asks the person out loud, and no answer calls a caregiver.',
    'What happens next: "escalate" makes the phones say "It looks like you may have fallen" and call the family in 25 seconds unless the person says they are OK (at once if they cry out or ask for help). "uncertain" asks "Are you OK?" gently and calls if nobody answers. "stand_down" does nothing, except asking anyway if nobody moves for a minute. So a wrong "stand_down" is the costly mistake; a wrong "escalate" costs a scary sentence and a call they must cancel. The person may not be able to use a screen; their spoken answer is understood by speech recognition.',
    'You decide what to look at. Use the tools when they could change your mind, not by habit: the evidence you were handed may already be enough. If someone may be down and not moving, a fresh look from a phone (ask_phone, with a short wait) is often the most useful thing you can do. In round 2 you already investigated in round 1: do not repeat the same tools. Read the other agents and answer their strongest point; call a tool only if someone raised something you never checked.',
    'Before a tool call you may think out loud in ONE short plain sentence (under 25 words, no lists, no markdown). Do not restate the evidence.',
    'If you want several tools, call them all in the same turn; they run in parallel and time matters.',
    'Readings: impact dB is above that phone\'s quiet level (20+ is a real bang, under 10 is faint). sound_model_says is the on-phone sound recognition of that bang: a snap, tap, knock, speech, TV or music, footsteps or a door are everyday sounds; a thump or thud can be a fall; it is a model and can be wrong. tv_or_music_share_before near 1 means a TV or music was playing. body_burst_db 20+ is a sudden body movement, under 16 is ordinary. still_after_fraction near 1 means nobody moved afterwards; first_movement_after_s is when they first shifted (an unconscious person does not). phone_itself_moved means its sonar described the phone, not the room. A phone with few streamed_samples or a long silence was asleep and knows little.',
    'Finish by calling post_position once. Speak like a calm, sharp person: one or two short sentences, cite phones by name and numbers. No jargon, no filler, no dashes.',
  ].join('\n');

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface ApiBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

export async function agentThink(
  cfg: LlmConfig,
  ctx: DeliberationContext,
  role: AgentName,
  tools: BrainTools,
  opts: { budgetMs: number; onTrace?: (t: AgentTrace) => void; onError?: (e: Error) => void; onUsage?: (u: Usage | undefined) => void; canSpend?: () => boolean },
): Promise<Position> {
  const isInv = role === 'investigator';
  const draft: Position = isInv
    ? {
        id: uid('position'),
        incidentId: ctx.incident.id,
        agent: 'investigator',
        round: 3,
        stance: 'uncertain',
        confidence: 0.5,
        argument: 'I could not look into it, so the person is asked.',
        points: [],
        llm: false,
        postedAt: Date.now(),
      }
    : ROLES[role]({ ...ctx, memory: ctx.memory ?? tools.memory?.() });
  const deadline = Date.now() + opts.budgetMs;
  let step = 0;
  const trace = (kind: AgentTrace['kind'], summary: string, tool?: string, input?: Record<string, unknown>) =>
    opts.onTrace?.({ incidentId: ctx.incident.id, agent: role, round: ctx.round, step: ++step, kind, tool, input, summary: summary.slice(0, 400), t: Date.now() });
  const used: string[] = [];
  const findings: string[] = [];

  // Help pressed needs no thought.
  if (ctx.incident.trigger.kind === 'help_pressed') return draft;

  const fullCtx = { ...ctx, context: ctx.context ?? tools.context?.(), memory: ctx.memory ?? tools.memory?.() };
  const auditTrust = ctx.prior.find((p) => p.agent === 'auditor')?.trust;
  const evidence = ctx.reports.map((r) => compactReport(r, auditTrust?.[r.nodeId]?.score));
  const mine = ctx.prior.find((p) => p.agent === role);
  const brief: Record<string, unknown> = {
    round: ctx.round,
    what_happened: { trigger: ctx.incident.trigger.kind, phone: ctx.incident.trigger.name, detail: ctx.incident.trigger.detail },
    local_time: new Date(ctx.incident.t0).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    evidence,
  };
  if (isInv) {
    brief.the_three_agents = ctx.prior.map((p) => ({ agent: p.agent, stance: p.stance, confidence: +p.confidence.toFixed(2), argument: p.argument, facts: p.points.slice(0, 5), conflict: p.conflict }));
  } else if (ctx.round === 2) {
    brief.your_round_1 = mine ? { stance: mine.stance, argument: mine.argument, what_you_found: mine.findings } : null;
    brief.other_agents_round_1 = ctx.prior
      .filter((p) => p.agent !== role)
      .map((p) => ({ agent: p.agent, stance: p.stance, confidence: +p.confidence.toFixed(2), argument: p.argument, what_they_found: p.findings, conflict: p.conflict }));
  }
  const messages: { role: 'user' | 'assistant'; content: unknown }[] = [{ role: 'user', content: JSON.stringify(brief) }];

  const runTool = async (name: string, input: Record<string, unknown>): Promise<{ result: unknown; summary: string }> => {
    if (name === 'physics_check') {
      const a = role === 'auditor' ? draft : auditor({ ...fullCtx, round: 1, prior: [] });
      const trust = Object.fromEntries(ctx.reports.map((r) => [r.name, { trust: Math.round((a.trust?.[r.nodeId]?.score ?? 1) * 100) / 100, reasons: a.trust?.[r.nodeId]?.reasons ?? [] }]));
      const low = ctx.reports.filter((r) => (a.trust?.[r.nodeId]?.score ?? 1) < 0.5).map((r) => r.name);
      return {
        result: { trust, conflict: a.conflict ?? null },
        summary: a.conflict ? `conflict: ${a.conflict}` : low.length ? `low trust: ${low.join(', ')}` : 'every phone checks out',
      };
    }
    if (name === 'ask_cartographer') {
      const c = fullCtx.context;
      if (!c) return { result: { note: 'The Cartographer has nothing: no room map for this home yet.' }, summary: 'no room map yet' };
      return {
        result: {
          notes: c.notes,
          bang_fits_best: c.source ? { place: c.source.name, kind: c.source.kind, misfit_db: +c.source.errDb.toFixed(1) } : null,
          bang_fits_person: c.personFit ? +c.personFit.errDb.toFixed(1) : null,
          person_ended_at: c.endedAt ? c.endedAt.place.name : null,
          usual_rest_spot: c.usualRest,
          loudest_phone_sits_by: c.loudestNear,
        },
        summary: c.notes.slice(0, 2).join('; '),
      };
    }
    if (name === 'ask_all_phones') {
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6000) / 1000));
      if (!tools.lookNow) return { result: { note: 'Phones cannot be asked again in this replay.' }, summary: 'not available in this replay' };
      const r = (await tools.lookNow(ctx.incident.id, 'all', waitS)) as { replies?: { phone: string; look: Record<string, unknown> }[]; no_reply?: string[] };
      const parts = (r.replies ?? []).map((x) => `${x.phone}: ${lookWords(x.look)}`);
      if (r.no_reply?.length) parts.push(`no reply from ${r.no_reply.join(', ')}`);
      return { result: r, summary: `broadcast to every phone${waitS >= 1 ? ` (after ${Math.round(waitS)} s)` : ''}: ${parts.join('; ') || 'no replies'}` };
    }
    if (name === 'ask_phone') {
      const phone = String(input.phone ?? '');
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6000) / 1000));
      if (!tools.lookNow) return { result: { note: 'Phones cannot be asked again in this replay.' }, summary: 'not available in this replay' };
      const r = await tools.lookNow(ctx.incident.id, phone, waitS);
      const s = lookWords(r);
      return { result: r, summary: `${phone}${waitS >= 1 ? ` after ${Math.round(waitS)} s` : ''}: ${s}` };
    }
    if (name === 'home_history') {
      const h = summarize(fullCtx.memory, tools.names?.() ?? {}, ctx.reports, ctx.incident.t0);
      return { result: h, summary: h.note ? String(h.note) : `${h.incidents_remembered} past incidents${h.pattern ? `; ${h.pattern}` : ''}` };
    }
    if (name === 'role_checklist') {
      return {
        result: { stance: draft.stance, confidence: +draft.confidence.toFixed(2), finding: draft.argument, facts: draft.points.slice(0, 10) },
        summary: `checklist says ${draft.stance.replace('_', ' ')}: ${draft.argument}`,
      };
    }
    return { result: { error: `unknown tool ${name}` }, summary: `unknown tool ${name}` };
  };

  try {
    const maxTurns = isInv ? 4 : 7;
    for (let turn = 0; turn < maxTurns; turn++) {
      const left = deadline - Date.now();
      if (left < 2500) throw new Error('out of time');
      if (opts.canSpend && !opts.canSpend()) throw new Error("today's Claude budget is used up");
      const last = turn === maxTurns - 1 || left < 9000;
      const body = await call(cfg, {
        system: SYSTEM(role),
        messages,
        tools: isInv ? TOOLS.filter((t) => t.name !== 'role_checklist') : TOOLS,
        tool_choice: last ? { type: 'tool', name: 'post_position' } : { type: 'auto' },
        max_tokens: isInv ? 400 : 600,
      }, Math.min(left - 500, cfg.timeoutMs), deadline);
      opts.onUsage?.(body.usage);
      messages.push({ role: 'assistant', content: body.content });
      const text = body.content.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text!.trim()).join(' ');
      if (text) trace('thought', text);
      const calls = body.content.filter((b) => b.type === 'tool_use');
      if (!calls.length) {
        messages.push({ role: 'user', content: 'Use a tool if you need more, otherwise call post_position now.' });
        continue;
      }
      const post = calls.find((c) => c.name === 'post_position');
      if (post) return finalize(post.input ?? {});
      for (const c of calls) used.push(c.name!);
      const results = await Promise.all(
        calls.map(async (c) => {
          const { result, summary } = await runTool(c.name!, c.input ?? {});
          if (c.name !== 'role_checklist') findings.push(`${c.name}: ${summary}`.slice(0, 240));
          trace('tool', summary, c.name, c.input);
          return { type: 'tool_result', tool_use_id: c.id, content: JSON.stringify(result).slice(0, isInv ? 2500 : 6000) };
        }),
      );
      messages.push({ role: 'user', content: results });
    }
    throw new Error(`no decision after ${maxTurns} turns`);
  } catch (e) {
    opts.onError?.(e as Error);
    trace('fallback', isInv ? `Claude could not investigate (${(e as Error).message.slice(0, 120)}), so the person is asked` : `Claude did not finish (${(e as Error).message.slice(0, 120)}), using the ${ROLE_INFO[role].title} checklist`);
    return { ...draft, tools: used, findings };
  }

  function finalize(out: Record<string, unknown>): Position {
    const stance: Stance = out.stance === 'escalate' || out.stance === 'stand_down' || out.stance === 'uncertain' ? out.stance : draft.stance;
    let confidence = typeof out.confidence === 'number' ? Math.max(0.05, Math.min(0.97, out.confidence)) : draft.confidence;
    let argument = typeof out.argument === 'string' && out.argument.trim() ? out.argument.trim().replace(/\s*[—–]\s*/g, ', ') : draft.argument;
    const cited = Array.isArray(out.cited) ? out.cited.filter((x): x is string => typeof x === 'string').slice(0, 8) : [];
    let final = stance;
    let floor: string | undefined;
    // Safety floor: the model may not stand down against an overwhelming case.
    const strongCase = isInv ? ctx.prior.some((p) => (p.stance === 'escalate' && p.confidence >= 0.8) || p.conflict) : draft.stance === 'escalate' && draft.confidence >= 0.6;
    if (stance === 'stand_down' && strongCase) {
      final = 'uncertain';
      confidence = 0.5;
      floor = isInv
        ? 'wanted to stand down, but one of the agents has a strong case for help or the phones contradict each other, so the person gets asked instead'
        : `wanted to stand down, but the ${ROLE_INFO[role].title} checklist found a strong case for help (${draft.argument}), so the person gets asked instead`;
      argument = `${argument} (Safety rule: not standing down against this evidence, so we ask.)`;
      trace('floor', floor);
    }
    return {
      ...draft,
      stance: final,
      confidence,
      argument,
      points: cited.length ? cited : draft.points,
      llm: true,
      tools: used,
      findings,
      floor,
      postedAt: Date.now(),
    };
  }
}

export async function call(cfg: LlmConfig, req: Record<string, unknown>, timeoutMs: number, deadline = Date.now() + timeoutMs): Promise<{ content: ApiBlock[]; stop_reason: string; usage?: Usage }> {
  // Busy or rate limited: wait as long as the API asks (within our time budget) and try again.
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1000, Math.min(timeoutMs, deadline - Date.now())));
    try {
      const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : {}) },
        body: JSON.stringify({ model: cfg.model, ...req }),
      });
      if (res.ok) return (await res.json()) as { content: ApiBlock[]; stop_reason: string; usage?: Usage };
      const text = (await res.text()).slice(0, 400);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      const wait = Math.min(8000, (Number(res.headers.get('retry-after')) || 0) * 1000 || 1200 * (attempt + 1));
      if (!retryable || attempt >= 3 || Date.now() + wait > deadline - 4000) throw new Error(`Anthropic API ${res.status}: ${text}`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('Claude took too long');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** A phone's fresh look in a few words, for the console. */
export function lookWords(r: Record<string, unknown>): string {
  if (r.streaming === false) return String(r.note ?? 'not streaming');
  if (r.error) return String(r.error);
  const sounds = r.sounds_since_incident as string[] | undefined;
  return `${r.sees_someone_now ? `sees someone${r.distance_now_m ? ` at ${r.distance_now_m} m` : ''}` : 'sees nobody'}${r.moving_now ? ', moving' : r.moving_now === false ? ', not moving' : ''}${r.breathing_bpm_now ? `, breathing ${r.breathing_bpm_now}/min` : ''}${r.moved_since_report ? ', moved since the report' : ''}${sounds?.length ? `, heard ${sounds.join(', ')}` : ''}`;
}
