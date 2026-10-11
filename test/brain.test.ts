import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentThink } from '../src/agents/brain';
import { runTrial } from '../src/agents/eval';
import type { LlmConfig } from '../src/agents/llm';
import { emptyMemory, knownHarmless, learn, learnedTrust, remember } from '../src/agents/memory';
import { auditor, skeptic, type DeliberationContext } from '../src/agents/roles';
import { SCENARIOS } from '../src/agents/sim';
import type { AgentTrace } from '../src/agents/types';

const spec = (k: string) => SCENARIOS.find((s) => s.key === k)!;
const cfg: LlmConfig = { apiKey: 'test', model: 'claude-haiku-4-5-20251001', mode: 'agent', timeoutMs: 5000 };

async function ctxFor(key: string, seed = 2): Promise<DeliberationContext> {
  const r = await runTrial(spec(key), seed);
  const run = r.incidents[0];
  return { incident: { ...run.incident, simulated: false }, reports: run.reports, round: 1, prior: [], seenFingerprints: new Set(), now: run.incident.t0 + 12000 };
}

/** A fake Anthropic API that plays a scripted sequence of assistant turns. */
function scripted(turns: { content: unknown[] }[]) {
  const bodies: Record<string, unknown>[] = [];
  let i = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      const t = turns[Math.min(i++, turns.length - 1)];
      return new Response(JSON.stringify({ ...t, stop_reason: 'tool_use' }), { status: 200 });
    }),
  );
  return bodies;
}

afterEach(() => vi.unstubAllGlobals());

describe('Claude agents with tools', () => {
  it('chooses tools, gets real results back, and posts its own position', async () => {
    const ctx = await ctxFor('fall_center');
    const bodies = scripted([
      {
        content: [
          { type: 'text', text: 'Someone may be down. I want a fresh look.' },
          { type: 'tool_use', id: 't1', name: 'ask_phone', input: { phone: 'Lounge', wait_seconds: 0 } },
          { type: 'tool_use', id: 't2', name: 'physics_check', input: {} },
        ],
      },
      { content: [{ type: 'tool_use', id: 't3', name: 'post_position', input: { stance: 'escalate', confidence: 0.9, argument: 'Still not moving. Get help.', cited: ['no movement'] } }] },
    ]);
    const traces: AgentTrace[] = [];
    const asked: string[] = [];
    const p = await agentThink(cfg, ctx, 'responder', { lookNow: async (_id, phone) => (asked.push(phone), { streaming: true, sees_someone_now: true, moving_now: false }) }, { budgetMs: 20000, onTrace: (t) => traces.push(t) });
    expect(p.stance).toBe('escalate');
    expect(p.llm).toBe(true);
    expect(p.tools).toEqual(['ask_phone', 'physics_check']);
    expect(asked).toEqual(['Lounge']);
    expect(traces.map((t) => t.kind)).toEqual(['thought', 'tool', 'tool']);
    // The tool results went back to the model.
    const second = bodies[1].messages as { role: string; content: unknown }[];
    expect(JSON.stringify(second[second.length - 1].content)).toContain('trust');
    expect(bodies[0].tools).toBeDefined();
  });

  it('cannot stand down against an overwhelming case: the person gets asked instead', async () => {
    const ctx = await ctxFor('fall_center');
    scripted([{ content: [{ type: 'tool_use', id: 't1', name: 'post_position', input: { stance: 'stand_down', confidence: 0.9, argument: 'Probably fine.' } }] }]);
    const traces: AgentTrace[] = [];
    const p = await agentThink(cfg, ctx, 'auditor', {}, { budgetMs: 20000, onTrace: (t) => traces.push(t) });
    expect(p.stance).toBe('uncertain');
    expect(p.floor).toBeTruthy();
    expect(traces.some((t) => t.kind === 'floor')).toBe(true);
  });

  it('falls back to the rule agent when Claude is unreachable', async () => {
    const ctx = await ctxFor('tv_thud', 3);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('invalid x-api-key', { status: 401 })));
    const traces: AgentTrace[] = [];
    const p = await agentThink(cfg, ctx, 'skeptic', {}, { budgetMs: 20000, onTrace: (t) => traces.push(t) });
    expect(p.llm).toBe(false);
    expect(p.stance).toBe(skeptic(ctx).stance);
    expect(traces[traces.length - 1].kind).toBe('fallback');
  });
});

describe('Claude agents: sharing, retries, speed', () => {
  it('round 2 sees what the other agents found, not just what they said', async () => {
    const ctx = await ctxFor('fall_center');
    const bodies = scripted([{ content: [{ type: 'tool_use', id: 'p', name: 'post_position', input: { stance: 'escalate', confidence: 0.8, argument: 'Agree.' } }] }]);
    const prior = [
      { agent: 'skeptic', round: 1, stance: 'uncertain', confidence: 0.5, argument: 'Maybe the TV.', findings: ['ask_phone: Lounge after 5 s: sees someone at 1.2 m, not moving'] },
      { agent: 'responder', round: 1, stance: 'escalate', confidence: 0.8, argument: 'Real fall.', findings: ['physics_check: every phone checks out'] },
    ] as never;
    await agentThink(cfg, { ...ctx, round: 2, prior }, 'responder', {}, { budgetMs: 20000 });
    const brief = JSON.parse((bodies[0].messages as { content: string }[])[0].content);
    expect(brief.other_agents_round_1[0].what_they_found[0]).toMatch(/sees someone/);
    expect(brief.your_round_1.what_you_found[0]).toMatch(/physics/);
  });

  it('waits and retries when the API is busy', async () => {
    const ctx = await ctxFor('fall_center');
    let n = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        n++ === 0
          ? new Response('{"error":{"type":"rate_limit_error"}}', { status: 429, headers: { 'retry-after': '1' } })
          : new Response(JSON.stringify({ content: [{ type: 'tool_use', id: 'p', name: 'post_position', input: { stance: 'escalate', confidence: 0.9, argument: 'Get help.' } }], stop_reason: 'tool_use' })),
      ),
    );
    const p = await agentThink(cfg, ctx, 'responder', {}, { budgetMs: 20000 });
    expect(p.llm).toBe(true);
    expect(n).toBe(2);
  });

  it('the sound model label reaches Claude', async () => {
    const ctx = await ctxFor('dropped_pan', 2);
    const bodies = scripted([{ content: [{ type: 'tool_use', id: 'p', name: 'post_position', input: { stance: 'stand_down', confidence: 0.8, argument: 'A snap.' } }] }]);
    await agentThink(cfg, ctx, 'skeptic', {}, { budgetMs: 20000 });
    expect((bodies[0].messages as { content: string }[])[0].content).toMatch(/sound_model_says/);
  });
});

describe('Learning from people\'s answers', () => {
  it('a phone whose alarms keep turning out false loses trust', async () => {
    const mem = emptyMemory();
    const ctx = await ctxFor('fall_center');
    const noisy = ctx.reports.find((r) => r.localVerdict !== 'none')!;
    for (let k = 0; k < 4; k++) {
      const inc = { ...ctx.incident, id: `old-${k}` };
      remember(mem, inc, ctx.reports, { kind: 'ask_human' } as never, null);
      learn(mem, inc.id, 'ok', 'person said OK');
    }
    expect(learnedTrust(mem, noisy.nodeId)?.factor).toBe(0.8);
    const before = auditor(ctx).trust![noisy.nodeId].score;
    const after = auditor({ ...ctx, memory: mem }).trust![noisy.nodeId];
    expect(after.score).toBeLessThan(before);
    expect(after.reasons.join(' ')).toMatch(/learned/);
  });

  it('a sound that was fine before at this hour becomes a known pattern for the Skeptic', async () => {
    const mem = emptyMemory();
    const ctx = await ctxFor('dropped_pan', 4);
    for (let k = 0; k < 3; k++) {
      const inc = { ...ctx.incident, id: `pan-${k}`, t0: ctx.incident.t0 - (k + 1) * 86400000 };
      remember(mem, inc, ctx.reports, { kind: 'ask_human' } as never, null);
      learn(mem, inc.id, 'ok', 'person said OK');
    }
    expect(knownHarmless(mem, ctx.reports, ctx.incident.t0).length).toBe(3);
    const p = skeptic({ ...ctx, memory: mem });
    expect(p.points.join(' ')).toMatch(/known everyday sound/);
  });
});
