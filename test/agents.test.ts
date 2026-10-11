import { describe, expect, it } from 'vitest';
import { evaluate, runTrial } from '../src/agents/eval';
import { resolve } from '../src/agents/protocol';
import { SCENARIOS } from '../src/agents/sim';
import type { Incident, Position } from '../src/agents/types';

const spec = (k: string) => SCENARIOS.find((s) => s.key === k)!;

describe('Witness agents', () => {
  it('outcome rule: no single agent can force a call or a stand down', () => {
    const inc = { id: 'x' } as Incident;
    const p = (agent: Position['agent'], stance: Position['stance']) => ({ agent, stance, argument: '' }) as Position;
    expect(resolve(inc, [p('responder', 'escalate'), p('skeptic', 'uncertain'), p('auditor', 'uncertain')], [], 0).kind).toBe('ask_human');
    expect(resolve(inc, [p('responder', 'escalate'), p('skeptic', 'stand_down'), p('auditor', 'escalate')], [], 0).kind).toBe('ask_human');
    expect(resolve(inc, [p('responder', 'escalate'), p('skeptic', 'uncertain'), p('auditor', 'escalate')], [], 0).kind).toBe('escalate');
    expect(resolve(inc, [p('responder', 'uncertain'), p('skeptic', 'stand_down'), p('auditor', 'stand_down')], [], 0).kind).toBe('stand_down');
    expect(resolve(inc, [p('responder', 'escalate'), p('skeptic', 'stand_down'), p('auditor', 'stand_down')], [], 0).kind).toBe('ask_human');
  });

  it('a fall seen by only one phone still gets help (majority vote misses it)', async () => {
    let agents = 0;
    let majority = 0;
    for (let s = 1; s <= 20; s++) {
      const r = await runTrial(spec('fall_corner'), s);
      if (r.decisions.agents !== 'none') agents++;
      if (r.decisions.majority === 'alarm') majority++;
    }
    expect(agents).toBe(20);
    expect(majority).toBeLessThan(5);
  });

  it('stands down on a TV crash and explains why', async () => {
    const r = await runTrial(spec('tv_thud'), 3);
    expect(r.decisions.agents).not.toBe('alarm');
    const args = r.incidents.flatMap((i) => i.positions.filter((p) => p.agent === 'skeptic').map((p) => p.argument)).join(' ');
    expect(args).toMatch(/elsewhere|loudest/);
  });

  it('flags a compromised phone that fakes a fall', async () => {
    for (let s = 1; s <= 10; s++) {
      const r = await runTrial(spec('fake_fall'), s);
      expect(r.decisions.agents).toBe('none');
      expect(r.incidents.some((i) => i.outcome.quarantined.includes('Phone 2'))).toBe(true);
    }
  });

  it('catches a fall that a compromised phone tries to hide', async () => {
    for (let s = 1; s <= 10; s++) {
      const r = await runTrial(spec('hidden_fall'), s);
      expect(r.decisions.agents).not.toBe('none');
    }
  });

  it('beats every baseline overall, including on held out scenarios', async () => {
    const t = await evaluate(20);
    const bad = (m: 'single' | 'any' | 'majority' | 'agents') => t.totals[m].missed * 3 + t.totals[m].falseAlarms;
    for (const m of ['single', 'any', 'majority'] as const) expect(bad('agents')).toBeLessThan(bad(m));
    expect(t.totals.agents.missed).toBe(0);
    const held = await evaluate(20, SCENARIOS.filter((s) => s.heldOut));
    expect(held.totals.agents.missed).toBe(0);
  }, 30000);
});

describe('observability, not dishonesty', () => {
  it('a phone that simply did not hear the bang is not quarantined', async () => {
    const { auditor } = await import('../src/agents/roles');
    const r = await runTrial(spec('fall_corner'), 2);
    const reports = r.incidents[0].reports.map((x, i) => (i === 2 ? { ...x, sound: { ...x.sound, impactDb: null, impactAi: null }, sonar: { ...x.sonar, sawPersonBefore: false, motionResumed: false, presentAfter: false } } : x));
    const a = auditor({ incident: r.incidents[0].incident, reports, round: 1, prior: [], seenFingerprints: new Set(), now: 0 });
    const t = a.trust![reports[2].nodeId];
    expect(t.score).toBeGreaterThanOrEqual(0.3);
    expect(t.reasons.join(' ')).toMatch(/low observability/);
  });
});
