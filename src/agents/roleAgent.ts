import type { BusMember, WireMsg } from './bus';
import { cartograph, type HomeMap, type MapContext } from './cartographer';
import type { Voice } from './protocol';
import { agentThink, type BrainTools, type Usage } from './brain';
import { negotiateThink } from './negotiator';
import type { LlmConfig } from './llm';
import type { HomeMemory } from './memory';
import { fingerprint, ROLES } from './roles';
import { uid } from './phoneAgent';
import type { ContextNote, EvidenceReport, Incident, Position, RoleName } from './types';

/**
 * A role agent as an independent participant on the channel. It only knows
 * what arrives on the channel: incidents, phone reports, and the other agents'
 * positions. It posts its own positions under its own identity.
 */

interface Work {
  incident: Incident;
  reports: Map<string, EvidenceReport>;
  wanted: string[] | null;
  round1: Map<RoleName, Position>;
  posted1: boolean;
  posted2: boolean;
  context?: MapContext;
  contextWait?: boolean;
}

export const ROLE_ORDER: RoleName[] = ['auditor', 'responder', 'skeptic'];

export class RoleAgent {
  private work = new Map<string, Work>();
  /** The Auditor's memory of earlier reports (replay detection). */
  private seen = new Set<string>();

  constructor(
    readonly role: RoleName,
    private readonly member: BusMember,
    private readonly voice: () => Voice | undefined,
    private readonly opts: {
      roundPauseMs: number;
      waitReportsMs: number;
      waitPeersMs: () => number;
      waitContextMs?: number;
      /** Agent mode: Claude with tools decides (null: rules, or the voice layer). */
      brain?: () => {
        cfg: LlmConfig;
        tools: BrainTools;
        budgetMs: (round: 1 | 2) => number;
        onError?: (e: Error) => void;
        onUsage?: (u: import('./brain').Usage | undefined) => void;
      } | null;
      memory?: () => HomeMemory | undefined;
      /** Claude for this agent's negotiation moves (contested incidents only). */
      negotiator?: () => NegotiatorBrain | null;
    },
  ) {
    this.asker = new PhoneAsker(member, (id) => [...new Set([...(this.work.get(id)?.reports.values() ?? [])].map((r) => r.name))]);
    member.onMessage((from, msg) => this.on(from, msg));
  }
  private readonly asker: PhoneAsker;

  /** One move in a negotiation round the moderator opened. */
  private async negotiate(msg: Extract<WireMsg, { type: 'negotiate' }>): Promise<void> {
    const b = this.opts.negotiator?.();
    const w = this.work.get(msg.incident.id);
    if (!b || !w) return;
    const move = await negotiateThink(
      b.cfg,
      { incident: msg.incident, reports: [...w.reports.values()], round: 3, prior: [...w.round1.values()], seenFingerprints: this.seen, now: Date.now(), context: w.context, memory: this.opts.memory?.() },
      this.role,
      msg.round,
      msg.lastRound,
      msg.transcript,
      { ...b.tools, lookNow: (id, phone, waitS) => this.asker.ask(id, phone, waitS) },
      { budgetMs: b.budgetMs, onUsage: b.onUsage, canSpend: b.canSpend, onError: b.onError, onTrace: (trace) => void this.member.publish({ type: 'trace', trace }).catch(() => {}) },
    );
    if (move) await this.member.publish({ type: 'move', move });
  }

  private get(incident: Incident): Work {
    let w = this.work.get(incident.id);
    if (!w) {
      w = { incident, reports: new Map(), wanted: null, round1: new Map(), posted1: false, posted2: false };
      this.work.set(incident.id, w);
      if (this.work.size > 50) this.work.delete(this.work.keys().next().value!);
    }
    return w;
  }

  private on(_from: string, msg: WireMsg): void {
    if (msg.type === 'negotiate') {
      void this.negotiate(msg);
      return;
    }
    if (msg.type === 'incident') this.get(msg.incident).incident = msg.incident;
    else if (msg.type === 'report') {
      const w = this.work.get(msg.report.incidentId);
      if (w) {
        w.reports.set(msg.report.id, msg.report);
        this.maybeRound1(w);
      }
    } else if (msg.type === 'evidence_closed') {
      const w = this.get(msg.incident);
      w.incident = msg.incident;
      w.wanted = msg.reportIds;
      this.maybeRound1(w);
      // Do not wait forever for a report that got lost.
      setTimeout(() => this.round1(w), this.opts.waitReportsMs);
    } else if (msg.type === 'context') {
      const w = this.work.get(msg.context.incidentId);
      const full = (msg as unknown as { full?: MapContext }).full;
      if (w && full) {
        w.context = full;
        this.maybeRound1(w);
      }
    } else if (msg.type === 'position' && msg.position.round === 1 && msg.position.agent !== 'investigator') {
      const w = this.work.get(msg.position.incidentId);
      if (w) {
        w.round1.set(msg.position.agent as RoleName, msg.position);
        this.maybeRound2(w);
      }
    }
  }

  private maybeRound1(w: Work): void {
    if (!w.wanted || !w.wanted.every((id) => w.reports.has(id))) return;
    // Give the Cartographer a moment to share what the room map says.
    if (!w.context && this.opts.waitContextMs && !w.contextWait) {
      w.contextWait = true;
      setTimeout(() => void this.round1(w), this.opts.waitContextMs);
      return;
    }
    if (w.context || !this.opts.waitContextMs) void this.round1(w);
  }

  private async round1(w: Work): Promise<void> {
    if (w.posted1 || !w.wanted) return;
    w.posted1 = true;
    const p = await this.think(w, 1, []);
    w.round1.set(this.role, p);
    await this.member.publish({ type: 'position', position: p });
    this.maybeRound2(w);
    setTimeout(() => void this.round2(w), this.opts.waitPeersMs());
  }

  private maybeRound2(w: Work): void {
    if (w.posted1 && ROLE_ORDER.every((r) => w.round1.has(r))) setTimeout(() => void this.round2(w), this.opts.roundPauseMs);
  }

  private async round2(w: Work): Promise<void> {
    if (w.posted2 || !w.posted1) return;
    w.posted2 = true;
    const prior = [...w.round1.values()];
    const mine = w.round1.get(this.role);
    // Agent mode: when all three already agree firmly, a second round adds a minute and nothing else.
    const firm = prior.length === ROLE_ORDER.length && prior.every((p) => p.stance === prior[0].stance && p.confidence >= 0.7 && !p.conflict);
    if (firm && mine && this.opts.brain?.()) {
      void this.member
        .publish({ type: 'trace', trace: { incidentId: w.incident.id, agent: this.role, round: 2, step: 1, kind: 'thought', summary: 'All three of us already agree, so there is nothing to argue about.', t: Date.now() } })
        .catch(() => {});
      await this.member.publish({ type: 'position', position: { ...mine, id: uid('position'), round: 2, postedAt: Date.now() } });
      if (this.role === 'auditor') for (const r of w.reports.values()) this.seen.add(fingerprint(r));
      return;
    }
    const p = await this.think(w, 2, prior);
    await this.member.publish({ type: 'position', position: p });
    if (this.role === 'auditor') for (const r of w.reports.values()) this.seen.add(fingerprint(r));
  }

  private async think(w: Work, round: 1 | 2, prior: Position[]): Promise<Position> {
    const ctx = { incident: w.incident, reports: [...w.reports.values()], round, prior, seenFingerprints: this.seen, now: Date.now(), context: w.context, memory: this.opts.memory?.() };
    const b = this.opts.brain?.();
    if (b) {
      return agentThink(b.cfg, ctx, this.role, { ...b.tools, context: () => w.context }, {
        budgetMs: b.budgetMs(round),
        onError: b.onError,
        onUsage: b.onUsage,
        onTrace: (trace) => void this.member.publish({ type: 'trace', trace }).catch(() => {}),
      });
    }
    const draft = ROLES[this.role](ctx);
    const v = this.voice();
    return v ? v(draft, ctx) : draft;
  }
}

/**
 * The Cartographer on the channel: it does not vote. When the evidence is in,
 * it reads the phone reports against the room map and posts what the map says
 * (where the bang came from, where the person ended up) for the others to use.
 */
export class CartographerAgent {
  private reports = new Map<string, EvidenceReport[]>();

  constructor(
    private readonly member: BusMember,
    private readonly mapFor: (incident: Incident) => HomeMap,
  ) {
    member.onMessage((_from, msg) => {
      if (msg.type === 'report') {
        const list = this.reports.get(msg.report.incidentId) ?? [];
        list.push(msg.report);
        this.reports.set(msg.report.incidentId, list);
        if (this.reports.size > 50) this.reports.delete(this.reports.keys().next().value!);
      } else if (msg.type === 'evidence_closed') {
        // Reports may still be in flight: wait briefly for the ones announced.
        const go = () => {
          const have = this.reports.get(msg.incident.id) ?? [];
          const ctx = cartograph(this.mapFor(msg.incident), have);
          const note: ContextNote = {
            incidentId: msg.incident.id,
            notes: ctx.notes,
            source: ctx.source ? { name: ctx.source.name, kind: ctx.source.kind, errDb: ctx.source.errDb } : null,
            endedAt: ctx.endedAt ? { name: ctx.endedAt.place.name, kind: ctx.endedAt.place.kind } : null,
            postedAt: Date.now(),
          };
          void this.member.publish({ type: 'context', context: note, full: ctx } as unknown as WireMsg);
        };
        const ready = () => msg.reportIds.every((id) => (this.reports.get(msg.incident.id) ?? []).some((r) => r.id === id));
        if (ready()) go();
        else setTimeout(go, 600);
      }
    });
  }
}

/**
 * The Investigator on the channel: Claude with tools, called in by the
 * moderator only when the three local agents cannot agree. It reads the same
 * reports and the Cartographer's note from the channel, looks into it (asks a
 * phone to look again, the room map, the home history), and posts one round 3
 * position. The only part of Witness that costs money, and only on a split.
 */
export class InvestigatorAgent {
  private reports = new Map<string, EvidenceReport[]>();
  private context = new Map<string, MapContext>();
  private waiting = new Map<string, { replies: { phone: string; look: Record<string, unknown> }[]; expected: number; done: () => void }>();

  constructor(
    private readonly member: BusMember,
    private readonly brain: () => {
      cfg: LlmConfig;
      tools: BrainTools;
      budgetMs: number;
      onError?: (e: Error) => void;
      onUsage?: (u: import('./brain').Usage | undefined) => void;
      canSpend?: () => boolean;
    } | null,
    private readonly memory: () => HomeMemory | undefined,
  ) {
    member.onMessage((_from, msg) => {
      if (msg.type === 'report') {
        const list = this.reports.get(msg.report.incidentId) ?? [];
        list.push(msg.report);
        this.reports.set(msg.report.incidentId, list);
        if (this.reports.size > 50) this.reports.delete(this.reports.keys().next().value!);
      } else if (msg.type === 'context') {
        const full = (msg as unknown as { full?: MapContext }).full;
        if (full) this.context.set(msg.context.incidentId, full);
      } else if (msg.type === 'look_reply') {
        const w = this.waiting.get(msg.requestId);
        if (w) {
          w.replies.push({ phone: msg.phone, look: msg.look });
          if (w.replies.length >= w.expected) w.done();
        }
      } else if (msg.type === 'investigate') void this.investigate(msg.incident, msg.positions);
    });
  }

  /**
   * Ask phones to look again, on the channel: "all" is one broadcast that every
   * phone in the incident answers (the AGNTCY auction pattern); a name is a
   * message addressed to that phone alone. Replies come back on the channel.
   */
  private async ask(incidentId: string, phone: string, waitS: number): Promise<Record<string, unknown>> {
    const all = phone === 'all';
    const names = [...new Set((this.reports.get(incidentId) ?? []).map((r) => r.name))];
    const requestId = uid('look');
    const replies: { phone: string; look: Record<string, unknown> }[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (waitS + 3) * 1000);
      this.waiting.set(requestId, {
        replies,
        expected: all ? Math.max(1, names.length) : 1,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      void this.member.publish({ type: 'look_request', requestId, incidentId, target: all ? null : phone, waitS }).catch(() => resolve());
    });
    this.waiting.delete(requestId);
    if (all) {
      const silent = names.filter((n) => !replies.some((r) => r.phone === n));
      return { asked: 'every phone, one broadcast on the SLIM channel', replies, no_reply: silent };
    }
    return replies[0] ? { phone: replies[0].phone, ...replies[0].look } : { error: `no reply from ${phone} (off, asleep or quarantined)`, phones: names };
  }

  private async investigate(incident: Incident, positions: Position[]): Promise<void> {
    const b = this.brain();
    if (!b) return;
    const context = this.context.get(incident.id);
    const p = await agentThink(
      b.cfg,
      { incident, reports: this.reports.get(incident.id) ?? [], round: 3, prior: positions, seenFingerprints: new Set(), now: Date.now(), context, memory: this.memory() },
      'investigator',
      { ...b.tools, context: () => context, lookNow: (id, phone, waitS) => this.ask(id, phone, waitS) },
      {
        budgetMs: b.budgetMs,
        onError: b.onError,
        onUsage: b.onUsage,
        canSpend: b.canSpend,
        onTrace: (trace) => void this.member.publish({ type: 'trace', trace }).catch(() => {}),
      },
    );
    await this.member.publish({ type: 'position', position: p });
  }
}

export interface NegotiatorBrain {
  cfg: LlmConfig;
  tools: BrainTools;
  budgetMs: number;
  onError?: (e: Error) => void;
  onUsage?: (u: Usage | undefined) => void;
  canSpend?: () => boolean;
}

/**
 * Asks phones to look again over the channel: "all" is one broadcast every
 * phone in the incident answers; a name addresses one phone.
 */
export class PhoneAsker {
  private waiting = new Map<string, { replies: { phone: string; look: Record<string, unknown> }[]; expected: number; done: () => void }>();
  constructor(
    private readonly member: BusMember,
    private readonly phones: (incidentId: string) => string[],
  ) {
    member.onMessage((_f, msg) => {
      if (msg.type !== 'look_reply') return;
      const w = this.waiting.get(msg.requestId);
      if (!w) return;
      w.replies.push({ phone: msg.phone, look: msg.look });
      if (w.replies.length >= w.expected) w.done();
    });
  }
  async ask(incidentId: string, phone: string, waitS: number): Promise<Record<string, unknown>> {
    const all = phone === 'all';
    const names = this.phones(incidentId);
    const requestId = uid('look');
    const replies: { phone: string; look: Record<string, unknown> }[] = [];
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, (waitS + 3) * 1000);
      this.waiting.set(requestId, {
        replies,
        expected: all ? Math.max(1, names.length) : 1,
        done: () => {
          clearTimeout(timer);
          resolve();
        },
      });
      void this.member.publish({ type: 'look_request', requestId, incidentId, target: all ? null : phone, waitS }).catch(() => resolve());
    });
    this.waiting.delete(requestId);
    if (all) return { asked: 'every phone, one broadcast on the SLIM channel', replies, no_reply: names.filter((n) => !replies.some((r) => r.phone === n)) };
    return replies[0] ? { phone: replies[0].phone, ...replies[0].look } : { error: `no reply from ${phone} (off, asleep or quarantined)`, phones: names };
  }
}
