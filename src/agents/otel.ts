import { randomBytes } from 'node:crypto';
import type { AgentTrace, EvidenceReport, Incident, Outcome, Position } from './types';

/**
 * One incident as an OpenTelemetry trace: a root span for the incident and a
 * child span per agent step (each phone's report, each position, each tool the
 * Investigator used, the outcome). Sent as OTLP/HTTP JSON to any collector
 * (the AGNTCY observability stack collects OTLP too) when
 * OTEL_EXPORTER_OTLP_ENDPOINT is set, e.g. http://localhost:4318.
 */

const hex = (n: number) => randomBytes(n).toString('hex');
const ns = (ms: number) => String(Math.round(ms * 1e6));
const attr = (k: string, v: string | number | boolean) => ({
  key: k,
  value: typeof v === 'number' ? { doubleValue: v } : typeof v === 'boolean' ? { boolValue: v } : { stringValue: String(v).slice(0, 500) },
});

export interface IncidentRecord {
  incident: Incident;
  reports: EvidenceReport[];
  positions: Position[];
  traces: AgentTrace[];
  outcome: Outcome;
}

export function incidentSpans(r: IncidentRecord): unknown {
  const traceId = hex(16);
  const root = hex(8);
  const end = r.outcome.decidedAt;
  const spans: unknown[] = [
    {
      traceId,
      spanId: root,
      name: `incident ${r.incident.trigger.kind}`,
      kind: 1,
      startTimeUnixNano: ns(r.incident.t0),
      endTimeUnixNano: ns(end),
      attributes: [attr('witness.incident', r.incident.id), attr('witness.trigger', r.incident.trigger.detail), attr('witness.outcome', r.outcome.kind), attr('witness.headline', r.outcome.headline), attr('witness.simulated', r.incident.simulated)],
    },
  ];
  const child = (name: string, t0: number, t1: number, attrs: ReturnType<typeof attr>[]) =>
    spans.push({ traceId, spanId: hex(8), parentSpanId: root, name, kind: 1, startTimeUnixNano: ns(t0), endTimeUnixNano: ns(Math.max(t1, t0 + 1)), attributes: attrs });
  for (const rep of r.reports) child(`report ${rep.name}`, rep.postedAt - 50, rep.postedAt, [attr('agent', `phone ${rep.name}`), attr('verdict', rep.localVerdict), attr('impact_db', rep.sound.impactDb ?? -1), attr('burst_db', rep.sonar.burstDb)]);
  for (const p of r.positions) child(`${p.agent} round ${p.round}`, p.postedAt - 100, p.postedAt, [attr('agent', p.agent), attr('stance', p.stance), attr('confidence', p.confidence), attr('argument', p.argument), attr('llm', p.llm)]);
  for (const t of r.traces) child(`${t.agent} ${t.tool ?? t.kind}`, t.t - 50, t.t, [attr('agent', t.agent), attr('step', t.step), attr('summary', t.summary)]);
  child('outcome', end - 1, end, [attr('kind', r.outcome.kind), attr('summary', r.outcome.summary)]);
  return {
    resourceSpans: [
      {
        resource: { attributes: [attr('service.name', 'echosense-witness'), attr('witness.channel', 'AGNTCY SLIM')] },
        scopeSpans: [{ scope: { name: 'witness', version: '1.0.0' }, spans }],
      },
    ],
  };
}

export async function exportIncident(endpoint: string, r: IncidentRecord): Promise<boolean> {
  try {
    const res = await fetch(`${endpoint.replace(/\/+$/, '')}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(incidentSpans(r)) });
    return res.ok;
  } catch {
    return false;
  }
}
