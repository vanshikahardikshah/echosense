import { ROLE_INFO, type DeliberationContext } from './roles';
import type { EvidenceReport, Position, Stance } from './types';

/**
 * Optional language model layer for the role agents (Claude through the
 * Anthropic Messages API).
 *
 *   ECHOSENSE_LLM=off       (default without a key) rule reasoning only
 *   ECHOSENSE_LLM=agent     (default with a key) each role agent is Claude with
 *                            tools: it decides what to check, asks phones and the
 *                            Cartographer, reads the home's history (brain.ts)
 *   ECHOSENSE_LLM=narrate   the model rewrites each
 *                            argument in plain words; stances stay with the rules
 *   ECHOSENSE_LLM=reason    the model reads the evidence and the other agents'
 *                            positions and picks its own stance
 *
 * Any failure or a slow answer (over 6 s) falls back to the rule position, so
 * the agents never stall waiting for the network.
 */

export interface LlmConfig {
  apiKey: string;
  model: string;
  mode: 'off' | 'narrate' | 'reason' | 'agent';
  timeoutMs: number;
  /** Override for testing against a local stand in. */
  baseUrl?: string;
  /** Needed for identity linked API keys (Console: the workspace page, wrkspc_...). */
  workspaceId?: string;
}

export function llmFromEnv(env: NodeJS.ProcessEnv = process.env): LlmConfig {
  const apiKey = env.ANTHROPIC_API_KEY ?? '';
  const mode = (env.ECHOSENSE_LLM as LlmConfig['mode']) ?? (apiKey ? 'agent' : 'off');
  return {
    apiKey,
    model: env.ECHOSENSE_LLM_MODEL ?? 'claude-haiku-4-5-20251001',
    // Older settings (narrate, reason) cost a Claude call per agent per incident: map them to the Investigator.
    mode: apiKey && ['off', 'narrate', 'reason', 'agent'].includes(mode) ? (mode === 'off' ? 'off' : 'agent') : 'off',
    timeoutMs: Number(env.ECHOSENSE_LLM_TIMEOUT ?? 12000),
    baseUrl: env.ANTHROPIC_BASE_URL || undefined,
    workspaceId: env.ANTHROPIC_WORKSPACE_ID || undefined,
  };
}

export function compactReport(r: EvidenceReport, trust?: number): Record<string, unknown> {
  const s = r.sonar;
  const ai = r.sound.impactAi;
  return {
    phone: r.name,
    trust: trust === undefined ? undefined : Math.round(trust * 100) / 100,
    streamed_samples: r.samples,
    silent_before_s: r.silenceMs > 1e8 ? 'never streamed' : +(r.silenceMs / 1000).toFixed(1),
    heard_impact_db: r.sound.impactDb === null ? null : Math.round(r.sound.impactDb),
    impact_repeating: r.sound.impactRepetitive || undefined,
    sound_model_says: ai ? `${ai.label} (${ai.group}, ${Math.round(ai.score * 100)}%)` : r.sound.impactDb === null ? undefined : 'not recognised',
    tv_or_music_share_before: r.sound.media === null ? undefined : +r.sound.media.toFixed(2),
    voice_or_music_events_before: r.sound.mediaEventsBefore,
    scream: r.sound.screamDb !== null,
    distress_sound: r.sound.distress,
    voice_after: r.sound.voiceAfter,
    sonar_online: s.online,
    // Sonar that was not running knows nothing: every sonar reading is "unknown", never "nobody".
    ...(s.online
      ? {
          was_watching_person: s.sawPersonBefore,
          last_saw_person_s_before: s.lastSeenAgo === null ? null : +s.lastSeenAgo.toFixed(1),
          range_before_m: s.rangeBefore === null ? null : +s.rangeBefore.toFixed(2),
          range_after_m: s.rangeAfter === null ? null : +s.rangeAfter.toFixed(2),
          body_burst_db: Math.round(s.burstDb),
          still_after_fraction: +s.stillAfter.toFixed(2),
          first_movement_after_s: s.firstMoveAfter === null ? null : +s.firstMoveAfter.toFixed(1),
          moved_normally_after: s.motionResumed,
          person_present_after: s.presentAfter,
          breathing_after_bpm: s.breathingAfter,
        }
      : { sonar_readings: 'unknown: this phone had no working sonar for this event' }),
    phone_itself_moved: r.imu.moved || r.imu.dropped || s.roomChangeDb >= 15,
    phone_own_verdict: r.localVerdict,
  };
}

const SYSTEM = (role: Position['agent']) =>
  `You are the ${ROLE_INFO[role].title} agent in Witness, a home safety system where phones sense a room with sonar and sound. ` +
  `Your goal: ${ROLE_INFO[role].goal} ` +
  'Several agents with different goals argue over the same evidence and no single agent decides. ' +
  'Speak like a calm, sharp person in one or two short sentences. Cite phones by name and numbers from the evidence. ' +
  'No jargon, no hedging filler, no dashes. Reply with JSON only.';

export function makeVoice(cfg: LlmConfig, onError: (e: Error) => void = () => {}) {
  if (cfg.mode === 'off' || cfg.mode === 'agent' || !cfg.apiKey) return undefined;
  const timeoutMs = Math.min(cfg.timeoutMs, 6000);
  return async (draft: Position, ctx: DeliberationContext): Promise<Position> => {
    const trust = ctx.prior.find((p) => p.agent === 'auditor')?.trust ?? draft.trust;
    const evidence = ctx.reports.map((r) => compactReport(r, trust?.[r.nodeId]?.score));
    const others = ctx.prior.filter((p) => p.agent !== draft.agent).map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
    const task =
      cfg.mode === 'reason'
        ? 'Decide your stance: "escalate" (get a caregiver now), "stand_down" (no emergency) or "uncertain" (ask the person). ' +
          'The rule engine drafted the position below; you may disagree with it if the evidence supports you.'
        : 'Rewrite the argument below in your own voice. Keep the same stance and the same facts.';
    const user = JSON.stringify({
      round: ctx.round,
      trigger: ctx.incident.trigger,
      evidence,
      other_agents_round_1: ctx.round === 2 ? others : undefined,
      draft: { stance: draft.stance, confidence: +draft.confidence.toFixed(2), argument: draft.argument, points: draft.points },
      task,
      reply_format: { stance: 'escalate | stand_down | uncertain', confidence: '0..1', argument: 'one or two sentences' },
    });
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
        method: 'POST',
        signal: ctl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : {}) },
        body: JSON.stringify({ model: cfg.model, max_tokens: 300, system: SYSTEM(draft.agent), messages: [{ role: 'user', content: user }] }),
      });
      if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 400)}`);
      const body = (await res.json()) as { content: { type: string; text?: string }[] };
      const text = body.content.map((c) => c.text ?? '').join('');
      const m = text.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('model reply had no JSON');
      const out = JSON.parse(m[0]) as { stance?: string; confidence?: number; argument?: string };
      const stance: Stance =
        cfg.mode === 'reason' && (out.stance === 'escalate' || out.stance === 'stand_down' || out.stance === 'uncertain') ? out.stance : draft.stance;
      const argument = typeof out.argument === 'string' && out.argument.trim() ? out.argument.trim().replace(/\s*[—–]\s*/g, ', ') : draft.argument;
      const confidence = cfg.mode === 'reason' && typeof out.confidence === 'number' ? Math.max(0.05, Math.min(0.97, out.confidence)) : draft.confidence;
      return { ...draft, stance, confidence, argument, llm: true };
    } catch (e) {
      onError(e as Error);
      return draft;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** One tiny request at startup so a bad key shows up in the hub window, not in the middle of a demo. */
export async function checkKey(cfg: LlmConfig): Promise<string> {
  if (!cfg.apiKey) return 'no ANTHROPIC_API_KEY in .env';
  try {
    const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : {}) },
      body: JSON.stringify({ model: cfg.model, max_tokens: 5, messages: [{ role: 'user', content: 'Say OK' }] }),
    });
    if (res.ok) return 'OK';
    const t = await res.text();
    if (t.includes('workspace')) return `the key needs a workspace id: add ANTHROPIC_WORKSPACE_ID=wrkspc_... to .env (${t.slice(0, 300)})`;
    return `Anthropic API ${res.status}: ${t.slice(0, 300)}`;
  } catch (e) {
    return `cannot reach the Anthropic API (${(e as Error).message})`;
  }
}

/**
 * The message a caregiver reads when help is called: what happened, what the
 * person said, what the agents saw, in three short sentences. Written by
 * Claude when available (4 s at most), otherwise from a template.
 */
export async function caregiverBrief(cfg: LlmConfig | null, facts: Record<string, unknown>, fallback: string, onUsage?: (u: { input_tokens: number; output_tokens: number }) => void): Promise<string> {
  if (!cfg?.apiKey || cfg.mode === 'off') return fallback;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 4000);
  try {
    const res = await fetch(`${cfg.baseUrl ?? 'https://api.anthropic.com'}/v1/messages`, {
      method: 'POST',
      signal: ctl.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': cfg.apiKey, 'anthropic-version': '2023-06-01', ...(cfg.workspaceId ? { 'anthropic-workspace-id': cfg.workspaceId } : {}) },
      body: JSON.stringify({
        model: cfg.model,
        max_tokens: 160,
        system:
          'You write the alert a family member receives from a home safety system for an older relative. At most three short plain sentences: what happened and where, what the person said (quote it) or that they did not answer, and the one most telling measurement. Calm, factual, no jargon, no dashes, no greeting, no advice beyond "please check on them".',
        messages: [{ role: 'user', content: JSON.stringify(facts) }],
      }),
    });
    if (!res.ok) throw new Error(String(res.status));
    const body = (await res.json()) as { content: { text?: string }[]; usage?: { input_tokens: number; output_tokens: number } };
    if (body.usage) onUsage?.(body.usage);
    const text = body.content.map((c) => c.text ?? '').join('').trim().replace(/\s*[—–]\s*/g, ', ');
    return text && text.length < 600 ? text : fallback;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}
