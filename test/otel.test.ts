import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalBus } from '../src/agents/bus';
import { Council } from '../src/agents/council';
import { Notifier, notifyFromEnv } from '../src/agents/notify';
import { toA2A, fromA2A } from '../src/agents/a2a';

afterEach(() => vi.unstubAllGlobals());

describe('AGNTCY plumbing', () => {
  it('channel messages are A2A Messages and come back intact', () => {
    const m = { type: 'human' as const, incidentId: 'i1', answer: 'ok' as const, source: 'x', t: 1 };
    const a = toA2A(m, 'witness/home/moderator');
    expect(a.kind).toBe('message');
    expect(a.contextId).toBe('i1');
    expect(a.parts[0].kind).toBe('data');
    expect(fromA2A(JSON.parse(JSON.stringify(a)))).toEqual(m);
  });

  it('each incident goes out as one OpenTelemetry trace', async () => {
    const posts: any[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      if (String(url).endsWith('/v1/traces')) posts.push(JSON.parse(String(init.body)));
      return new Response('{}', { status: 200 });
    });
    const c = new Council({
      bus: new LocalBus('otel'),
      notifier: new Notifier(notifyFromEnv({})),
      llm: { apiKey: '', model: '', mode: 'off', timeoutMs: 1 },
      publish: () => {},
      askPhones: () => {},
      tellPhones: () => {},
      otlpEndpoint: 'http://collector:4318',
    });
    await c.start();
    c.runScenario('tv_thud', 3);
    const t = Date.now();
    while (!posts.length && Date.now() - t < 20000) await new Promise((r) => setTimeout(r, 100));
    const spans = posts[0].resourceSpans[0].scopeSpans[0].spans;
    expect(spans[0].name).toMatch(/^incident/);
    expect(spans.some((s: any) => s.name.startsWith('skeptic round'))).toBe(true);
    expect(spans.every((s: any) => s.traceId === spans[0].traceId)).toBe(true);
  }, 25000);
});
