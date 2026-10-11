import { describe, expect, it } from 'vitest';
import { LocalBus } from '../src/agents/bus';
import { Council } from '../src/agents/council';
import { Notifier, notifyFromEnv } from '../src/agents/notify';
import { PhoneAgent } from '../src/agents/phoneAgent';
import type { BoardMsg, Position } from '../src/agents/types';

/** A council with two quiet live phones, where we play the agents' final positions by hand. */
async function setup(urgentMs = 300) {
  const board: BoardMsg[] = [];
  const asks: { urgent?: boolean }[] = [];
  const told: string[] = [];
  let cleared = 0;
  const c = new Council({
    bus: new LocalBus(`lc${Math.random()}`),
    notifier: new Notifier(notifyFromEnv({})),
    llm: { apiKey: '', model: '', mode: 'off', timeoutMs: 1 },
    publish: (m) => board.push(m),
    askPhones: (_id, _r, urgent) => asks.push({ urgent }),
    tellPhones: (t) => told.push(t),
    clearPhones: () => cleared++,
    urgentMs,
    askTimeoutMs: 400,
  });
  await c.start();
  const pool = [new PhoneAgent('node-1', 'Phone 1'), new PhoneAgent('node-2', 'Phone 2')];
  const open = (kind: 'burst' | 'help_pressed' = 'burst') => {
    const before = new Set((c as any).live.keys());
    c.trigger('node-1', kind, 'test', Date.now(), { agents: pool, gatherMs: 60000 });
    const id = [...(c as any).live.keys()].find((k: string) => !before.has(k));
    return id ? (c as any).live.get(id) : null;
  };
  const decide = async (l: any, stance: Position['stance']) => {
    l.positions = (['responder', 'skeptic', 'auditor'] as const).map((agent) => ({ id: agent, incidentId: l.incident.id, agent, round: 2, stance, confidence: 0.8, argument: `${agent} says ${stance}`, points: [], llm: false, postedAt: Date.now() }));
    await (c as any).finish(l);
  };
  const calls = () => board.filter((m) => m.type === 'action' && m.action.action === 'call');
  return { c, board, asks, told, open, decide, calls, cleared: () => cleared };
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('incident lifecycle', () => {
  it('"I\'m OK" during the deliberation stands, even if the agents then want help', async () => {
    const t = await setup();
    const l = t.open();
    t.c.human(l.incident.id, 'ok', 'Phone 1: said "I am fine"', { transcript: 'I am fine' });
    await t.decide(l, 'escalate');
    await wait(500);
    expect(t.calls()).toHaveLength(0);
    expect(l.incident.status).toBe('resolved_ok');
  });

  it('agents wanting help first say so out loud and count down; "I\'m OK" cancels', async () => {
    const t = await setup(400);
    const l = t.open();
    await t.decide(l, 'escalate');
    expect(l.incident.status).toBe('urgent');
    expect(t.asks[t.asks.length - 1]?.urgent).toBe(true);
    t.c.human(l.incident.id, 'ok', 'Phone 1: said "yeah I am okay"');
    await wait(600);
    expect(t.calls()).toHaveLength(0);
    expect(t.told[t.told.length - 1]).toMatch(/glad/);
  });

  it('silence after the countdown calls for help, once', async () => {
    const t = await setup(200);
    const l = t.open();
    await t.decide(l, 'escalate');
    await wait(500);
    expect(t.calls()).toHaveLength(1);
    expect(l.incident.status).toBe('escalated');
    // A second "no answer" (the phone's own timer) does not call again.
    t.c.human(l.incident.id, 'no_answer', 'phone timer');
    await wait(50);
    expect(t.calls()).toHaveLength(1);
  });

  it('"No, I am hurt" calls at once, without waiting for the agents', async () => {
    const t = await setup();
    const l = t.open();
    expect(t.c.personSaid('node-1', 'Phone 1', 'no I am hurt', 'help', null)).toBe(true);
    await wait(50);
    expect(t.calls()).toHaveLength(1);
    await t.decide(l, 'stand_down');
    expect(t.calls()).toHaveLength(1);
  });

  it('a question that went unanswered while they argued means no countdown', async () => {
    const t = await setup(5000);
    const l = t.open();
    t.c.human(l.incident.id, 'no_answer', 'Phone 1: nobody answered');
    expect(l.noAnswer).toBe(true);
    await t.decide(l, 'escalate');
    await wait(50);
    expect(t.calls()).toHaveLength(1);
  });

  it('bumps right after "I\'m OK" are them getting up, not a new emergency', async () => {
    const t = await setup();
    const l = t.open();
    t.c.human(l.incident.id, 'ok', 'tapped');
    await wait(3100);
    expect(t.open()).toBeNull();
    // Asking for help still works.
    expect(t.open('help_pressed')).not.toBeNull();
  }, 8000);

  it('one thing at a time: new bumps fold into the open incident', async () => {
    const t = await setup();
    t.open();
    await wait(3100);
    expect(t.open()).toBeNull();
  }, 8000);

  it('saying "help" with nothing going on opens an incident and calls', async () => {
    const t = await setup();
    t.c.agent('node-1', 'Phone 1');
    expect(t.c.personSaid('node-1', 'Phone 1', 'help me', 'help', null)).toBe(true);
    await wait(1500);
    expect(t.board.some((m) => m.type === 'incident' && m.incident.trigger.kind === 'help_pressed')).toBe(true);
  });
});

describe('phones answer on the channel', () => {
  it('one broadcast, every phone in the incident replies; an addressed request gets one reply', async () => {
    const bus = new LocalBus(`look${Math.random()}`);
    const c = new Council({
      bus,
      notifier: new Notifier(notifyFromEnv({})),
      llm: { apiKey: '', model: '', mode: 'off', timeoutMs: 1 },
      publish: () => {},
      askPhones: () => {},
      tellPhones: () => {},
    });
    await c.start();
    const tel = (range: number) => ({ nodeId: '', t: Date.now(), status: 'ok', headline: '', subline: '', presence: 'still', mode: 'room' as const, range, velocity: 0, snrDb: 20, confirmed: true, breathing: null, linkSnrDb: 24, motionDb: 10, fastMotionDb: 4, staticChangeDb: 1, sonarOk: true, echo: [], maxRange: 3, band: [18000, 19000] as [number, number], sim: false, checkIn: null });
    for (let i = 0; i < 20; i++) {
      c.onTelemetry('node-1', 'Phone 1', tel(1.2));
      c.onTelemetry('node-2', 'Phone 2', tel(2.0));
    }
    await wait(50);
    c.trigger('node-1', 'burst', 'test', Date.now(), { gatherMs: 60000 });
    const id = [...(c as any).live.keys()][0];
    const me = await bus.join('tester');
    const got: any[] = [];
    me.onMessage((_f, m) => m.type === 'look_reply' && got.push(m));
    await me.publish({ type: 'look_request', requestId: 'r1', incidentId: id, target: null, waitS: 0 });
    await wait(100);
    expect(got.map((g) => g.phone).sort()).toEqual(['Phone 1', 'Phone 2']);
    expect(got[0].look.streaming).toBe(true);
    await me.publish({ type: 'look_request', requestId: 'r2', incidentId: id, target: 'Phone 2', waitS: 0 });
    await wait(100);
    expect(got.filter((g) => g.requestId === 'r2').map((g) => g.phone)).toEqual(['Phone 2']);
  });
});

describe('negotiation only on a real split', () => {
  it('two say stand down and one is unsure: that is a consensus, no Claude, no question', async () => {
    let calls = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async () => {
      calls++;
      return new Response('{}', { status: 500 });
    }) as typeof fetch;
    try {
      const board: BoardMsg[] = [];
      const c = new Council({
        bus: new LocalBus(`cons${Math.random()}`),
        notifier: new Notifier(notifyFromEnv({})),
        llm: { apiKey: 'k', model: 'claude-haiku-4-5-20251001', mode: 'agent', timeoutMs: 1000 },
        publish: (m) => board.push(m),
        askPhones: () => {},
        tellPhones: () => {},
      });
      await c.start();
      const pool = [new PhoneAgent('node-1', 'Phone 1'), new PhoneAgent('node-2', 'Phone 2')];
      c.trigger('node-1', 'burst', 'test', Date.now(), { agents: pool, gatherMs: 60000 });
      const l = [...(c as any).live.values()][0];
      const pos = (agent: string, stance: string) => ({ id: agent, incidentId: l.incident.id, agent, round: 2, stance, confidence: 0.6, argument: agent, points: [], llm: false, postedAt: Date.now() });
      l.positions = [pos('responder', 'stand_down'), pos('auditor', 'stand_down'), pos('skeptic', 'uncertain')];
      await (c as any).finish(l);
      expect(calls).toBe(0);
      expect(l.incident.status).toBe('stood_down');
      expect(board.some((m) => m.type === 'move')).toBe(false);
    } finally {
      globalThis.fetch = real;
    }
  });
});

describe('a cry for help: fast, but one classifier is not proof', () => {
  const rep = (over: any = {}) => ({
    id: 'r', incidentId: 'x', nodeId: 'node-1', name: 'Phone 1', postedAt: Date.now(), samples: 80, silenceMs: 100,
    sound: { impactDb: null, impactRepetitive: false, screamDb: null, mediaEventsBefore: 0, voiceAfter: false, impactAi: null, media: 0, distress: false, ...(over.sound ?? {}) },
    sonar: { online: true, medianLinkDb: 20, sawPersonBefore: true, rangeBefore: 1.2, rangeAfter: 1.2, burstDb: 4, stillAfter: 0.5, motionResumed: true, presentAfter: true, lastSeenAgo: 0.5, firstMoveAfter: 3, breathingAfter: null, roomChangeDb: 1, ...(over.sonar ?? {}) },
    imu: { moved: false, dropped: false }, localVerdict: 'none',
  });

  it('asks at once, and with only one phone hearing it, no answer means the countdown, not a call', async () => {
    const t = await setup(5000);
    const before = t.asks.length;
    t.c.trigger('node-1', 'scream', 'scream 30 dB', Date.now(), { agents: [new PhoneAgent('node-1', 'Phone 1')], gatherMs: 60000 });
    expect(t.asks.length).toBe(before + 1);
    const l = [...(t.c as any).live.values()].pop();
    l.reports = [rep({ sound: { screamDb: 30, distress: true } }), { ...rep(), nodeId: 'node-2', name: 'Phone 2' }];
    t.c.human(l.incident.id, 'no_answer', 'phone timer');
    await t.decide(l, 'escalate');
    await wait(50);
    expect(t.calls()).toHaveLength(0);
    expect(l.incident.status).toBe('urgent');
  });

  it('with a bang or a body movement behind it, no answer calls', async () => {
    const t = await setup(5000);
    t.c.trigger('node-1', 'scream', 'scream 30 dB', Date.now(), { agents: [new PhoneAgent('node-1', 'Phone 1')], gatherMs: 60000 });
    const l = [...(t.c as any).live.values()].pop();
    l.reports = [rep({ sound: { screamDb: 30, distress: true, impactDb: 28 }, sonar: { burstDb: 26, motionResumed: false, stillAfter: 1 } })];
    t.c.human(l.incident.id, 'no_answer', 'phone timer');
    await t.decide(l, 'escalate');
    await wait(50);
    expect(t.calls()).toHaveLength(1);
  });
});
