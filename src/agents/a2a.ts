import { randomUUID } from 'node:crypto';
import type { WireMsg } from './bus';

/**
 * Every message on the SLIM channel is an A2A (Agent2Agent protocol) Message:
 * role "agent", one data part carrying the Witness payload, and the incident
 * as the A2A context, so any A2A aware tool on the channel can read it.
 * (The A2A SLIMRPC binding exists for Python, Go, Java, .NET and Rust; this
 * hub is Node, so it sends A2A JSON over a SLIM group session.)
 */

export interface A2AMessage {
  kind: 'message';
  role: 'agent' | 'user';
  messageId: string;
  contextId: string;
  parts: { kind: 'data'; data: WireMsg }[];
  metadata: { 'witness/type': string; 'witness/sender'?: string };
}

function contextOf(m: WireMsg): string {
  switch (m.type) {
    case 'incident':
    case 'evidence_closed':
    case 'investigate':
    case 'negotiate':
      return m.incident.id;
    case 'move':
      return m.move.incidentId;
    case 'look_request':
    case 'look_reply':
      return m.incidentId;
    case 'report':
      return m.report.incidentId;
    case 'position':
      return m.position.incidentId;
    case 'trace':
      return m.trace.incidentId;
    case 'context':
      return m.context.incidentId;
    case 'outcome':
      return m.outcome.incidentId;
    case 'action':
      return m.action.incidentId;
    case 'human':
      return m.incidentId;
    default:
      return 'witness';
  }
}

export function toA2A(m: WireMsg, sender?: string): A2AMessage {
  return {
    kind: 'message',
    role: 'agent',
    messageId: randomUUID(),
    contextId: contextOf(m),
    parts: [{ kind: 'data', data: m }],
    metadata: { 'witness/type': m.type, ...(sender ? { 'witness/sender': sender } : {}) },
  };
}

/** Accepts an A2A Message (or a bare Witness payload from an older hub). */
export function fromA2A(x: unknown): WireMsg | null {
  const o = x as Partial<A2AMessage> & { type?: string };
  if (o?.kind === 'message' && Array.isArray(o.parts)) {
    const part = o.parts.find((p) => p?.kind === 'data');
    return (part?.data as WireMsg) ?? null;
  }
  return typeof o?.type === 'string' ? (o as unknown as WireMsg) : null;
}
