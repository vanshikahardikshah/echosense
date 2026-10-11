import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus, SlimBus, type WireMsg } from '../src/agents/bus';
import { Council } from '../src/agents/council';
import { Notifier, notifyFromEnv } from '../src/agents/notify';
import type { BoardMsg } from '../src/agents/types';
import { Budget } from '../src/agents/budget';

function council(bus = new LocalBus('test')) {
  const board: { msg: BoardMsg; from: string }[] = [];
  const notifier = new Notifier(notifyFromEnv({}));
  const c = new Council({
    bus,
    notifier,
    llm: { apiKey: '', model: '', mode: 'off', timeoutMs: 1 },
    publish: (msg, from) => board.push({ msg, from }),
    askPhones: () => {},
    tellPhones: () => {},
  });
  return { c, board, bus };
}

const until = async (f: () => boolean, ms = 15000) => {
  const t = Date.now();
  while (!f() && Date.now() - t < ms) await new Promise((r) => setTimeout(r, 50));
  return f();
};

describe('agent channel', () => {
  it('runs the whole protocol with each agent posting under its own identity', async () => {
    const { c, board } = council();
    await c.start();
    expect(c.runScenario('fake_fall', 3)).toBe(true);
    expect(await until(() => board.some((b) => b.msg.type === 'outcome'))).toBe(true);
    const out = board.find((b) => b.msg.type === 'outcome')!.msg as Extract<BoardMsg, { type: 'outcome' }>;
    expect(out.outcome.kind).toBe('stand_down');
    // Positions came from the role agents' own addresses, reports from each phone's.
    const posFrom = new Set(board.filter((b) => b.msg.type === 'position').map((b) => b.from));
    expect([...posFrom].sort()).toEqual(['witness/test/auditor', 'witness/test/responder', 'witness/test/skeptic']);
    expect(board.filter((b) => b.msg.type === 'report').map((b) => b.from)).toContain('witness/test/phone-sim-2');
    // The hacked phone is thrown off the channel.
    await until(() => board.some((b) => b.msg.type === 'action' && b.msg.action.action === 'quarantine'));
    const q = board.find((b) => b.msg.type === 'action' && b.msg.action.action === 'quarantine')!.msg as Extract<BoardMsg, { type: 'action' }>;
    expect(q.action.ok).toBe(true);
  }, 20000);

  it('decides without a silent agent and leans to asking the person', async () => {
    const bus = new LocalBus('t2');
    const { c, board } = council(bus);
    await c.start();
    await bus.remove('skeptic');
    c.runScenario('fall_center', 2);
    expect(await until(() => board.some((b) => b.msg.type === 'outcome'), 25000)).toBe(true);
    const out = (board.find((b) => b.msg.type === 'outcome')!.msg as Extract<BoardMsg, { type: 'outcome' }>).outcome;
    expect(out.summary).toMatch(/Skeptic did not answer/);
  }, 30000);
});

describe('the agents negotiate when they disagree', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** A stand-in for Claude that plays each agent's moves by role and round. */
  function fakeClaude(calls: string[]) {
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (!String(url).includes('anthropic')) return new Response('{}', { status: 200 });
      const body = JSON.parse(String(init.body));
      const role = (/You are the (\w+) agent/.exec(body.system ?? '')?.[1] ?? 'x').toLowerCase();
      calls.push(role);
      const usage = { input_tokens: 2000, output_tokens: 100 };
      if (!body.tools) return new Response(JSON.stringify({ content: [{ type: 'text', text: 'Possible fall. Please check on them.' }], usage }), { status: 200 });
      const brief = JSON.parse(body.messages[0].content);
      const turn = body.messages.filter((m: { role: string }) => m.role === 'assistant').length;
      const move = (input: Record<string, unknown>) => [{ type: 'tool_use', id: 'm', name: 'make_move', input }];
      let content: unknown[];
      if (role === 'auditor' && brief.round === 1 && turn === 0) content = [{ type: 'tool_use', id: 't', name: 'ask_all_phones', input: { wait_seconds: 0 } }];
      else if (brief.round === 1)
        content =
          role === 'responder'
            ? move({ kind: 'counter', action: 'urgent', call_if_no_movement_s: 30, argument: 'Every phone lost them after a 34 dB bang; I can live with a countdown instead of calling now.' })
            : role === 'skeptic'
              ? move({ kind: 'challenge', to: 'responder', claim: 'lost them after a bang', action: 'ask', argument: 'Phone 1 heard only 23 dB and nothing shows a body moving; a gentle question is enough.' })
              : move({ kind: 'counter', action: 'ask', call_if_no_movement_s: 30, argument: 'The phones check out, but none can see them now; ask, and call if nobody moves in 30 s.' });
      else
        content =
          role === 'responder'
            ? move({ kind: 'concede', to: 'skeptic', claim: 'no body motion', action: 'ask', call_if_no_movement_s: 30, argument: 'Fair, no sonar saw a drop. Ask them, with the 30 s condition.' })
            : role === 'skeptic'
              ? move({ kind: 'accept', to: 'auditor', action: 'ask', argument: 'The Auditor plan tests the fact we disagree on. Agreed.' })
              : move({ kind: 'offer', action: 'ask', call_if_no_movement_s: 30, argument: 'Then we agree: ask, and call if nobody moves in 30 s.' });
      return new Response(JSON.stringify({ content, stop_reason: 'tool_use', usage }), { status: 200 });
    });
  }
  function council(bus: LocalBus, budget?: Budget) {
    const board: { msg: BoardMsg; from: string }[] = [];
    const c = new Council({
      bus,
      notifier: new Notifier(notifyFromEnv({})),
      llm: { apiKey: 'k', model: 'claude-haiku-4-5-20251001', mode: 'agent', timeoutMs: 3000 },
      publish: (msg, from) => board.push({ msg, from }),
      askPhones: () => {},
      tellPhones: () => {},
      budget,
    });
    return { c, board };
  }

  it('a clear case never calls Claude (it costs nothing)', async () => {
    const calls: string[] = [];
    fakeClaude(calls);
    const { c, board } = council(new LocalBus('t3'));
    await c.start();
    c.runScenario('fake_fall', 3);
    expect(await until(() => board.some((b) => b.msg.type === 'outcome'), 25000)).toBe(true);
    expect(calls).toHaveLength(0);
  }, 30000);

  it('disagreeing agents challenge, concede, check the phones and agree on one plan', async () => {
    const calls: string[] = [];
    fakeClaude(calls);
    const budget = new Budget(0.5, () => 'claude-haiku-4-5-20251001');
    const { c, board } = council(new LocalBus('t4'), budget);
    await c.start();
    c.runScenario('fall_hallway', 1);
    expect(await until(() => board.some((b) => b.msg.type === 'outcome'), 60000)).toBe(true);
    const moves = board.filter((b) => b.msg.type === 'move').map((b) => ({ from: b.from, m: (b.msg as Extract<BoardMsg, { type: 'move' }>).move }));
    // Each move is posted by the agent itself on the channel.
    expect(moves.filter((x) => x.m.round >= 1).every((x) => x.from === `witness/t4/${x.m.agent}`)).toBe(true);
    expect(moves.some((x) => x.m.kind === 'challenge' && x.m.to === 'responder')).toBe(true);
    expect(moves.some((x) => x.m.kind === 'concede')).toBe(true);
    // The Auditor settled a fact by asking every phone on the channel.
    expect(board.some((b) => b.msg.type === 'trace' && b.msg.trace.agent === 'auditor' && b.msg.trace.tool === 'ask_all_phones' && /Sim Phone/.test(b.msg.trace.summary))).toBe(true);
    const out = (board.find((b) => b.msg.type === 'outcome')!.msg as Extract<BoardMsg, { type: 'outcome' }>).outcome;
    expect(out.plan).toEqual({ action: 'ask', callIfNoMovementS: 30 });
    expect(out.negotiation).toEqual({ rounds: 2, agreed: true });
    expect(out.kind).toBe('ask_human');
    expect(budget.summary().today).toBeLessThan(0.05);
  }, 70000);

  it('stops calling Claude at the daily cap and asks the person instead', async () => {
    const calls: string[] = [];
    fakeClaude(calls);
    const budget = new Budget(0.005, () => 'claude-haiku-4-5-20251001');
    const { c, board } = council(new LocalBus('t5'), budget);
    await c.start();
    c.runScenario('fall_hallway', 1);
    expect(await until(() => board.some((b) => b.msg.type === 'outcome'), 25000)).toBe(true);
    expect(calls).toHaveLength(0);
    expect(board.some((b) => b.msg.type === 'action' && /budget/.test(b.msg.action.detail))).toBe(true);
  }, 30000);
});

describe('Webex', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts a card with answer buttons', async () => {
    const calls: { url: string; body: any }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
      return new Response(JSON.stringify({ id: 'm1' }), { status: 200 });
    });
    const n = new Notifier(notifyFromEnv({ WEBEX_BOT_TOKEN: 't', WEBEX_TO_EMAIL: 'a@b.c', PUBLIC_URL: 'https://x.example' }));
    const r = await n.webex('inc-1', 'Possible fall', 'why', [{ title: 'Where', value: 'Phone 1' }], true);
    expect(r.ok).toBe(true);
    expect(calls[0].url).toBe('https://webexapis.com/v1/messages');
    const card = calls[0].body.attachments[0].content;
    expect(card.actions.map((a: any) => a.data.answer)).toEqual(['on_my_way', 'false_alarm']);
    expect(calls[0].body.toPersonEmail).toBe('a@b.c');
  });

  it('checks the webhook signature', () => {
    const body = '{"data":{"id":"x"}}';
    const sig = createHmac('sha1', 's3cret').update(body).digest('hex');
    expect(Notifier.verifyWebex(body, 's3cret', sig)).toBe(true);
    expect(Notifier.verifyWebex(body, 'wrong', sig)).toBe(false);
    expect(Notifier.verifyWebex(body, 's3cret', undefined)).toBe(false);
  });
});

describe('AGNTCY SLIM', () => {
  it('carries messages in an MLS group and can remove a member', async () => {
    let bus: SlimBus;
    try {
      bus = await SlimBus.start({ home: 'vitest', listen: '127.0.0.1:46371', secret: 'echosense-witness-local-secret-0123456789', log: () => {} });
    } catch {
      return; // bindings not installed on this machine
    }
    expect(bus.info().encrypted).toBe(true);
    const got: string[] = [];
    bus.moderator.onMessage((from, m: WireMsg) => got.push(`${from}:${m.type}`));
    const a = await bus.join('responder');
    const p = await bus.join('phone-x');
    await a.publish({ type: 'hello', agent: 'responder' });
    await p.publish({ type: 'hello', agent: 'phone' });
    expect(await until(() => got.length >= 2, 5000)).toBe(true);
    expect(got).toContain('phone-x:hello');
    expect(await bus.remove('phone-x')).toBe(true);
    expect(bus.isMember('phone-x')).toBe(false);
    await p.publish({ type: 'hello', agent: 'after removal' });
    await new Promise((r) => setTimeout(r, 400));
    expect(got.filter((g) => g.startsWith('phone-x')).length).toBe(1);
    const back = await bus.join('phone-x');
    await back.publish({ type: 'hello', agent: 'back' });
    expect(await until(() => got.filter((g) => g.startsWith('phone-x')).length === 2, 5000)).toBe(true);
  }, 20000);
});
