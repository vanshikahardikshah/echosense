import { phoneMovedItself } from './roles';
import { exportIncident } from './otel';
import type { FusionAlert } from '../fusion/fusion';
import type { Telemetry } from '../net/protocol';
import { Rng } from '../sim/random';
import { caregiverBrief, makeVoice, type LlmConfig } from './llm';
import type { Notifier } from './notify';
import { GATHER_MS, PhoneAgent, SAME_EVENT_MS, uid } from './phoneAgent';
import type { Bus, WireMsg } from './bus';
import { resolve, stanceWord, withInvestigator } from './protocol';
import { agreed, describePlan, nearAgreement, negotiatedOutcome, noDeal, openingPlan, type Move, type Plan } from './negotiation';
import { uid as newId } from './phoneAgent';
import { emptyMap, learnRest, PLACE_KINDS, type HomeMap, type PlaceKind } from './cartographer';
import { CartographerAgent, RoleAgent, ROLE_ORDER } from './roleAgent';
import { ROLE_INFO } from './roles';
import { generate, SCENARIOS, simHomeMap, T0 } from './sim';
import { emptyMemory, learn, remember, type HomeMemory } from './memory';
import type { Budget } from './budget';
import type { ActionRecord, BoardMsg, EvidenceReport, Incident, Outcome, Position, RoleName, SoundObs, TriggerKind } from './types';

/**
 * Runs Witness live inside the hub. It is plumbing, not a decision maker: it
 * hosts the phone agents, opens incidents when any phone raises a trigger,
 * carries messages over the shared board, and carries out whatever the public
 * outcome rule says.
 */

interface Live {
  incident: Incident;
  reports: EvidenceReport[];
  positions: Position[];
  outcome: Outcome | null;
  askTimer: ReturnType<typeof setTimeout> | null;
  escalated: boolean;
  done: boolean;
  finishTimer: ReturnType<typeof setTimeout> | null;
  /** Where the Cartographer says the person ended up. */
  place?: string | null;
  pool?: PhoneAgent[];
  /** What a person said, at any point (it always wins over the agents). */
  answer?: { answer: 'ok' | 'help' | 'no_answer'; source: string; t: number; transcript?: string; injury?: string | null };
  /** A phone's own check-in already went unanswered before the agents finished. */
  noAnswer?: boolean;
  /** Second check-in already asked (never loop). */
  askedTwice?: boolean;
  traces?: import('./types').AgentTrace[];
  /** The agents are negotiating (they disagreed). */
  negotiation?: { round: number; transcript: Move[]; ruleOutcome: Outcome; timer: ReturnType<typeof setTimeout> | null };
  /** Waiting for the Investigator (the team was split). */
  investigating?: { outcome: Outcome; timer: ReturnType<typeof setTimeout> };
}

export interface CouncilOptions {
  notifier: Notifier;
  llm: LlmConfig;
  bus: Bus;
  /** Sends a board message to the consoles, with the channel identity that posted it. */
  publish: (m: BoardMsg, from: string) => void;
  /** Ask every phone to run its "Are you OK?" check-in (urgent: "I will call for help unless you say you are OK"). */
  askPhones: (incidentId: string, reason: string, urgent?: boolean, seconds?: number) => void;
  /** Close any check-in still showing on the phones (someone answered). */
  clearPhones?: () => void;
  /** Speak a short message on every phone. */
  tellPhones: (text: string) => void;
  log?: (s: string) => void;
  askTimeoutMs?: number;
  /** Status line for speech understanding (shown on the console). */
  speechStatus?: () => string;
  /** Countdown before calling when the agents want help (the person can cancel by saying they are OK). */
  urgentMs?: number;
  /** Load and save the room map (a JSON file next to the hub). */
  loadMap?: () => HomeMap | null;
  saveMap?: (m: HomeMap) => void;
  /** Load and save what the home has learned from people's answers. */
  loadMemory?: () => HomeMemory | null;
  saveMemory?: (m: HomeMemory) => void;
  /** Daily cap on Claude spending. */
  budget?: Budget;
  /** Send each incident as an OpenTelemetry trace (OTLP/HTTP JSON), e.g. http://localhost:4318. */
  otlpEndpoint?: string;
}

export class Council {
  readonly agents = new Map<string, PhoneAgent>();
  readonly board: BoardMsg[] = [];
  private live = new Map<string, Live>();
  private compromised = new Set<string>();
  private quarantined = new Map<string, number>();
  private joining = new Set<string>();
  private roles: RoleAgent[] = [];
  private voice: ReturnType<typeof makeVoice>;
  realCallsForSims = false;
  private simRunning = false;
  private simAgents: PhoneAgent[] = [];
  map: HomeMap = emptyMap();
  private simMap: HomeMap = emptyMap();
  private still = new Map<string, { since: number; range: number; learnedAt: number }>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  memory: HomeMemory = emptyMemory();
  private lastBrainError = 0;
  /** When someone last said they were OK (new bumps right after are them getting up). */
  private lastOkAt = 0;
  /** Result of the startup key check (set by the hub). */
  llmHealth = 'not checked';


  constructor(private readonly o: CouncilOptions) {
    this.voice = this.makeVoice();
  }

  private makeVoice(): ReturnType<typeof makeVoice> {
    let last = 0;
    return makeVoice(this.o.llm, (e) => {
      if (Date.now() - last > 60000) this.log(`Claude unavailable, using rule text (${e.message.slice(0, 160)})`);
      last = Date.now();
    });
  }

  /** Switch Claude between off, narrate and reason while running (needs ANTHROPIC_API_KEY). */
  setLlmMode(mode: LlmConfig['mode']): boolean {
    if (mode !== 'off' && !this.o.llm.apiKey) return false;
    this.o.llm.mode = mode;
    this.voice = this.makeVoice();
    this.log(`Claude mode: ${mode}`);
    return true;
  }

  private log(s: string): void {
    this.o.log?.(`[witness] ${s}`);
  }

  /** Every role agent joins the channel under its own identity. */
  async start(): Promise<void> {
    const bus = this.o.bus;
    bus.moderator.onMessage((from, msg) => this.onWire(from, msg));
    this.map = this.o.loadMap?.() ?? emptyMap();
    this.memory = this.o.loadMemory?.() ?? emptyMemory();
    // The three role agents are local and free: they argue every incident in about a second.
    for (const role of ROLE_ORDER) {
      const member = await bus.join(role);
      this.roles.push(
        new RoleAgent(role, member, () => this.voice, {
          roundPauseMs: 1200,
          waitReportsMs: 3000,
          waitPeersMs: () => (this.o.llm.mode === 'narrate' || this.o.llm.mode === 'reason' ? 9000 : 4000),
          waitContextMs: 900,
          memory: () => this.memory,
          negotiator: () =>
            this.o.llm.mode === 'agent' && this.o.llm.apiKey
              ? {
                  cfg: this.o.llm,
                  budgetMs: 24000,
                  tools: { memory: () => this.memory, names: () => Object.fromEntries([...this.agents.values()].map((a) => [a.nodeId, a.name])) },
                  canSpend: () => this.o.budget?.canSpend() ?? true,
                  onUsage: (u) => this.o.budget?.add(u),
                  onError: (e) => {
                    if (Date.now() - this.lastBrainError > 30000) this.log(`a negotiator could not move: ${e.message.slice(0, 300)}`);
                    this.lastBrainError = Date.now();
                  },
                }
              : null,
        }),
      );
    }
    new CartographerAgent(await bus.join('cartographer'), (inc) => (inc.simulated ? this.simMap : this.map));
    this.log(`agents on ${bus.info().channel}: ${bus.info().members.join(', ')}`);
  }

  private record(m: BoardMsg, from: string): void {
    this.board.push(m);
    if (this.board.length > 600) this.board.splice(0, this.board.length - 600);
    this.o.publish(m, from);
  }

  /** The moderator's own posts: shown on the console and sent to every agent. */
  private post(m: BoardMsg): void {
    this.record(m, this.o.bus.moderator.address);
    void this.o.bus.moderator.publish(m).catch((e) => this.log(`channel publish failed: ${(e as Error).message}`));
  }

  /** Everything the moderator hears from the other agents on the channel. */
  private onWire(from: string, msg: WireMsg): void {
    const address = `${this.o.bus.info().channel.replace(/\/board$/, '')}/${from}`;
    if (msg.type === 'context') {
      const l = this.live.get(msg.context.incidentId);
      if (l && !l.done) {
        l.place = msg.context.endedAt?.name ?? null;
        this.record({ type: 'context', context: msg.context }, address);
      }
      return;
    }
    if (msg.type === 'trace') {
      const l = this.live.get(msg.trace.incidentId);
      if (l && (!l.done || l.investigating || l.negotiation)) {
        (l.traces ??= []).push(msg.trace);
        this.record(msg, address);
      }
      return;
    }
    if (msg.type === 'report') {
      const l = this.live.get(msg.report.incidentId);
      if (!l || l.done || l.reports.some((r) => r.id === msg.report.id)) return;
      l.reports = l.reports.filter((r) => r.nodeId !== msg.report.nodeId).concat(msg.report);
      this.record(msg, address);
    } else if (msg.type === 'move') {
      const l = this.live.get(msg.move.incidentId);
      if (l) this.onMove(l, msg.move, address);
    } else if (msg.type === 'position' && msg.position.agent === 'investigator') {
      const l = this.live.get(msg.position.incidentId);
      if (!l || !l.investigating) return;
      l.positions.push(msg.position);
      this.record(msg, address);
      void this.conclude(l, l.investigating.outcome, msg.position);
    } else if (msg.type === 'position') {
      const l = this.live.get(msg.position.incidentId);
      if (!l || l.done) return;
      l.positions.push(msg.position);
      this.record(msg, address);
      const finals = ROLE_ORDER.filter((r) => l.positions.some((p) => p.agent === r && p.round === 2));
      if (finals.length === ROLE_ORDER.length) void this.finish(l);
    }
  }

  private phoneMember(nodeId: string): string {
    return `phone-${nodeId}`;
  }

  private ensureJoined(nodeId: string): void {
    const id = this.phoneMember(nodeId);
    if (this.joining.has(id) || this.o.bus.isMember(id)) return;
    if ((this.quarantined.get(nodeId) ?? 0) > Date.now()) return;
    const a = this.agents.get(nodeId);
    if (!a) return;
    this.joining.add(id);
    this.joinPhone(a)
      .catch((e) => this.log(`${id} could not join the channel: ${(e as Error).message}`))
      .finally(() => this.joining.delete(id));
  }

  /** A phone agent joins the channel under its own identity and answers "look again" requests on it. */
  private readonly answering = new WeakSet<object>();
  private async joinPhone(a: PhoneAgent): Promise<import('./bus').BusMember> {
    const m = await this.o.bus.join(this.phoneMember(a.nodeId));
    if (!this.answering.has(m)) {
      this.answering.add(m);
      m.onMessage((_from, msg) => {
        if (msg.type === 'look_request') this.answerLook(a, m, msg);
      });
    }
    return m;
  }

  /** A phone agent's own reply to the Investigator: what it measures right now (broadcast or addressed to it). */
  private answerLook(a: PhoneAgent, m: import('./bus').BusMember, req: Extract<WireMsg, { type: 'look_request' }>): void {
    const l = this.live.get(req.incidentId);
    if (!l || !(l.pool ?? []).some((p) => p.nodeId === a.nodeId)) return;
    if (req.target && req.target.toLowerCase() !== a.name.toLowerCase() && !a.name.toLowerCase().includes(req.target.toLowerCase())) return;
    if ((this.quarantined.get(a.nodeId) ?? 0) > Date.now()) return;
    setTimeout(() => {
      const look = l.incident.simulated
        ? { streaming: false, note: 'simulated phone: this is a recording, there is nothing newer to see' }
        : a.lookNow(l.incident.t0, Date.now());
      void m.publish({ type: 'look_reply', requestId: req.requestId, incidentId: req.incidentId, phone: a.name, look }).catch(() => {});
    }, Math.max(0, Math.min(10, req.waitS)) * 1000);
  }

  status(): Record<string, unknown> {
    return {
      llmMode: this.o.llm.mode,
      llmKey: !!this.o.llm.apiKey,
      llm:
        this.o.llm.mode === 'off'
          ? this.o.llm.apiKey
            ? 'rules only (Claude off)'
            : 'rules only (add ANTHROPIC_API_KEY for Claude)'
          : this.o.llm.mode === 'agent'
            ? `the three agents decide locally when they agree; when they disagree, each becomes its own Claude (${this.o.llm.model}) and they negotiate a plan${this.llmHealth === 'OK' ? '' : `. Key check: ${this.llmHealth}`}`
            : `rules plus ${this.o.llm.model} (${this.o.llm.mode === 'reason' ? 'Claude picks stances' : 'Claude writes the arguments'})`,
      llmHealth: this.llmHealth,
      speech: this.o.speechStatus?.() ?? 'off',
      claude: this.o.budget?.summary() ?? null,
      memory: {
        incidents: this.memory.incidents.length,
        answered: this.memory.incidents.filter((r) => r.human).length,
        falseAlarms: this.memory.incidents.filter((r) => r.human === 'ok').length,
      },
      notify: this.o.notifier.describe(),
      webhook: !!this.o.notifier.cfg.webhook,
      compromised: [...this.compromised],
      realCallsForSims: this.realCallsForSims,
      bus: this.o.bus.info(),
      map: {
        places: this.map.places.map((p) => ({ id: p.id, name: p.name, kind: p.kind, ranges: p.ranges })),
        phones: this.map.phones,
        restingSpots: Object.fromEntries(Object.entries(this.map.resting).map(([k, h]) => [k, h.reduce((a, b) => a + b, 0)])),
      },
      quarantined: [...this.quarantined.entries()].filter(([, until]) => until > Date.now()).map(([id]) => this.agents.get(id)?.name ?? id),
      phones: [...this.agents.values()].filter((a) => !a.nodeId.startsWith('sim-')).map((a) => ({ nodeId: a.nodeId, name: a.name })),
    };
  }

  // ---------------------------------------------------------------- inputs from phones
  agent(nodeId: string, name: string): PhoneAgent {
    let a = this.agents.get(nodeId);
    if (!a) {
      a = new PhoneAgent(nodeId, name, (kind, detail, t) => this.trigger(nodeId, kind, detail, t));
      this.agents.set(nodeId, a);
    }
    a.name = name;
    if (!nodeId.startsWith('sim-')) this.ensureJoined(nodeId);
    return a;
  }

  onTelemetry(nodeId: string, name: string, tel: Telemetry, now = Date.now()): void {
    // The Cartographer learns where people rest: someone still at the same distance for 20 s.
    const st = this.still.get(nodeId);
    if (tel.presence === 'still' && tel.confirmed && tel.range !== null) {
      if (!st || Math.abs(st.range - tel.range) > 0.3) this.still.set(nodeId, { since: now, range: tel.range, learnedAt: 0 });
      else if (now - st.since > 20000 && now - st.learnedAt > 20000) {
        st.learnedAt = now;
        learnRest(this.map, nodeId, st.range);
        this.saveSoon();
      }
    } else this.still.delete(nodeId);
    this.agent(nodeId, name).onSample({
      t: now,
      presence: tel.presence,
      range: tel.range,
      confirmed: tel.confirmed,
      snrDb: tel.snrDb,
      fastMotionDb: tel.fastMotionDb,
      motionDb: tel.motionDb,
      staticChangeDb: tel.staticChangeDb ?? 0,
      linkSnrDb: tel.linkSnrDb,
      breathing: tel.breathing,
      sonarOk: tel.sonarOk ?? (tel.status !== 'calibrating' && tel.status !== 'degraded'),
      media: tel.scene?.media,
    });
  }

  onSound(nodeId: string, name: string, s: Omit<SoundObs, 't'>, now = Date.now()): void {
    // Phones hold sound events back ~1.6 s so the sound model can label them: date them back.
    this.agent(nodeId, name).onSound({ ...s, t: now - (s.lateMs ?? 0) });
  }

  onAlert(nodeId: string, name: string, a: FusionAlert, now = Date.now()): void {
    const agent = this.agent(nodeId, name);
    // The person answered on the phone.
    // How the person answered: tapped, spoke, moved, or called out.
    const how = a.evidence?.[0] ?? '';
    if (a.kind === 'resolved') {
      const inc = this.latestOpen();
      if (inc) this.human(inc.incident.id, 'ok', `${name}: ${how || "tapped I'm OK"}`);
      return;
    }
    if (a.kind === 'escalation') {
      const inc = this.latestOpen();
      if (/help/i.test(a.title)) {
        if (inc) this.human(inc.incident.id, 'help', `${name}: ${how || 'tapped Get help'}`);
        else this.trigger(nodeId, 'help_pressed', `${a.title}${how ? ` (${how})` : ''}`, now);
      } else if (inc) this.human(inc.incident.id, 'no_answer', `${name}: nobody answered the phone's "Are you OK?"`);
      return;
    }
    if (a.kind === 'agent_check' || a.kind === 'sound') return;
    agent.onAlert({ t: now, kind: a.kind, severity: a.severity, title: a.title });
  }

  private latestOpen(): Live | null {
    const list = [...this.live.values()].filter((l) => !l.incident.simulated && Date.now() - l.incident.t0 < 180000 && !['stood_down', 'resolved_ok', 'resolved_help'].includes(l.incident.status));
    return list.sort((a, b) => b.incident.t0 - a.incident.t0)[0] ?? null;
  }

  // ---------------------------------------------------------------- incidents
  trigger(nodeId: string, kind: TriggerKind, detail: string, t: number, opts: { simulated?: boolean; scenario?: string; agents?: PhoneAgent[]; gatherMs?: number } = {}): void {
    for (const l of this.live.values()) {
      if (Math.abs(l.incident.t0 - t) <= SAME_EVENT_MS && l.incident.simulated === !!opts.simulated) return;
    }
    const urgentKind = kind === 'help_pressed' || kind === 'scream';
    if (!opts.simulated && !urgentKind) {
      // Someone just said they are fine: the next bumps are them getting up and moving about.
      // Kept short (getting up takes seconds), and a phone's own fall alarm always gets through.
      const calmMs = Number(process.env.ECHOSENSE_CALM_SECONDS ?? 20) * 1000;
      if (kind !== 'fall_alert' && Date.now() - this.lastOkAt < calmMs) {
        this.log(`ignored ${kind} on ${nodeId}: they said they were OK ${Math.round((Date.now() - this.lastOkAt) / 1000)} s ago`);
        return;
      }
      // One thing at a time: while the phones are already checking on them or help is coming, fold new bumps in.
      const busy = [...this.live.values()].find(
        (l) => !l.incident.simulated && Date.now() - l.incident.t0 < 180000 && ['gathering', 'deliberating', 'asking', 'urgent', 'escalated'].includes(l.incident.status),
      );
      if (busy) {
        this.log(`folded ${kind} on ${nodeId} into ${busy.incident.id} (${busy.incident.status})`);
        return;
      }
    }
    // Phones that are streaming right now (a locked phone cannot testify).
    const pool = opts.agents ?? [...this.agents.values()].filter((a) => !a.nodeId.startsWith('sim-') && Date.now() - a.lastSeen < 10000);
    const who = pool.find((a) => a.nodeId === nodeId) ?? this.agents.get(nodeId);
    const incident: Incident = {
      id: uid('incident'),
      t0: t,
      trigger: { nodeId, name: who?.name ?? nodeId, kind, detail },
      status: 'gathering',
      expected: pool.map((a) => a.nodeId),
      simulated: !!opts.simulated,
      scenario: opts.scenario,
    };
    const l: Live = { incident, reports: [], positions: [], outcome: null, askTimer: null, escalated: false, done: false, finishTimer: null, pool };
    this.live.set(incident.id, l);
    if (this.live.size > 60) this.live.delete(this.live.keys().next().value!);
    this.post({ type: 'incident', incident: { ...incident } });
    this.log(`incident ${incident.id}: ${incident.trigger.name} ${kind} (${detail})`);
    const wait = opts.gatherMs ?? Math.max(0, t + GATHER_MS - Date.now());
    // Help pressed needs no evidence window.
    // A cry for help is a fast safety path: ask right away, while the phones keep gathering evidence.
    // One sound classifier is never proof on its own, so this asks rather than calls.
    if (kind === 'scream' && !opts.simulated) {
      this.o.askPhones(incident.id, 'I heard someone cry out. Are you OK? Do you need help?', false, Math.round((this.o.askTimeoutMs ?? 40000) / 1000));
      this.action(l, 'ask_phone', true, `${who?.name ?? nodeId} heard someone cry out: asking "Are you OK?" right away while the other phones check`);
    }
    setTimeout(() => void this.run(l, pool), kind === 'help_pressed' ? 300 : wait);
  }

  private async run(l: Live, pool: PhoneAgent[]): Promise<void> {
    const now = Date.now();
    const at = l.incident.simulated ? l.incident.t0 + GATHER_MS : now;
    const bus = this.o.bus;
    const ids: string[] = [];
    const skipped: string[] = [];
    const stale: string[] = [];
    // Each phone agent posts its own report under its own identity on the channel.
    await Promise.all(
      pool.map(async (a) => {
        if ((this.quarantined.get(a.nodeId) ?? 0) > Date.now()) {
          skipped.push(a.name);
          return;
        }
        // Only live phones testify: a phone whose screen locked has nothing fresh to say.
        const age = Date.now() - a.lastSeen;
        if (!l.incident.simulated && age > 5000) {
          stale.push(`${a.name} (${Math.round(age / 1000)} s old)`);
          return;
        }
        let r: EvidenceReport = { ...a.report(l.incident.id, l.incident.t0, at), ageMs: l.incident.simulated ? 0 : age };
        if (this.compromised.has(a.nodeId)) r = forge(r, l.incident.t0);
        try {
          const m = await this.joinPhone(a);
          ids.push(r.id);
          l.reports.push(r);
          this.record({ type: 'report', report: r }, m.address);
          await m.publish({ type: 'report', report: r });
        } catch (e) {
          this.log(`${a.name} could not post its report: ${(e as Error).message}`);
        }
      }),
    );
    // The demo hack lasts for one incident.
    if (!l.incident.simulated) for (const a of pool) this.compromised.delete(a.nodeId);
    if (skipped.length) this.action(l, 'quarantine', true, `${skipped.join(', ')} is quarantined and was not asked to testify`);
    if (stale.length) this.action(l, 'ask_phone', false, `report rejected, not live: ${stale.join(', ')}. Keep Safari open and the screen on.`);
    l.incident.status = 'deliberating';
    this.post({ type: 'incident', incident: { ...l.incident } });
    await bus.moderator.publish({ type: 'evidence_closed', incident: { ...l.incident }, reportIds: ids });
    // If an agent goes quiet, decide with the positions that did arrive (the rule then leans to asking the person).
    l.finishTimer = setTimeout(() => void this.finish(l), this.o.llm.mode === 'narrate' || this.o.llm.mode === 'reason' ? 30000 : 15000);
  }

  private async finish(l: Live): Promise<void> {
    if (l.done) return;
    l.done = true;
    if (l.finishTimer) clearTimeout(l.finishTimer);
    const finals = ROLE_ORDER.map(
      (r) => l.positions.find((p) => p.agent === r && p.round === 2) ?? l.positions.find((p) => p.agent === r && p.round === 1),
    ).filter((p): p is Position => !!p);
    const outcome = resolve(l.incident, finals, l.reports, Date.now());
    const missing = ROLE_ORDER.filter((r) => !finals.some((p) => p.agent === r));
    if (missing.length) outcome.summary += ` ${missing.map((m) => ROLE_INFO[m].title).join(' and ')} did not answer in time.`;
    // Disagreement is negotiated, not voted on. Clear agreement never touches Claude.
    // Two of three on one side with nobody opposing is a consensus: no negotiation, no Claude.
    // Only a real split (the rule cannot decide) is negotiated.
    // Distress and help requests take the fixed safety path: no negotiation, no Claude, no delay.
    const contested = outcome.kind === 'ask_human' && finals.length === 3 && l.incident.trigger.kind !== 'help_pressed' && l.incident.trigger.kind !== 'scream' && !l.answer;
    if (contested) {
      const opening: Move[] = finals.map((p) => ({
        id: newId('move'),
        incidentId: l.incident.id,
        agent: p.agent as RoleName,
        round: 0,
        kind: 'offer',
        to: null,
        claim: null,
        plan: openingPlan(p),
        argument: p.argument,
        llm: p.llm,
        postedAt: Date.now(),
      }));
      const same = agreed(opening.map((m) => m.plan));
      const claude = this.o.llm.mode === 'agent' && !!this.o.llm.apiKey && (this.o.budget?.canSpend() ?? true);
      if (!same && claude) {
        l.negotiation = { round: 0, transcript: opening, ruleOutcome: outcome, timer: null };
        this.action(l, 'ask_phone', true, 'the agents disagree: they negotiate what to do (each agent is its own Claude, talking over the SLIM channel)');
        for (const m of opening) this.record({ type: 'move', move: m }, `${this.o.bus.info().channel.replace(/\/board$/, '')}/${m.agent}`);
        void this.nextRound(l);
        return;
      }
      if (!same && this.o.llm.mode === 'agent' && this.o.llm.apiKey) this.action(l, 'ask_phone', true, "the agents disagree, but today's Claude budget is used up, so the person is asked");
    }
    await this.conclude(l, outcome);
  }

  /** Open the next negotiation round: every role agent makes one move on the channel. */
  private async nextRound(l: Live): Promise<void> {
    const n = l.negotiation;
    if (!n) return;
    n.round++;
    const lastRound = n.round >= 3;
    n.timer = setTimeout(() => void this.closeRound(l), 28000);
    await this.o.bus.moderator.publish({ type: 'negotiate', incident: { ...l.incident }, round: n.round, lastRound, transcript: n.transcript });
  }

  private onMove(l: Live, m: Move, address: string): void {
    const n = l.negotiation;
    if (!n || m.round !== n.round || n.transcript.some((x) => x.round === n.round && x.agent === m.agent)) return;
    n.transcript.push(m);
    this.record({ type: 'move', move: m }, address);
    if (ROLE_ORDER.every((r) => n.transcript.some((x) => x.round === n.round && x.agent === r))) void this.closeRound(l);
  }

  /** After each round: a deal if all three now stand behind the same plan; otherwise another round; with no deal after the last, the disagreement is kept and the person is asked. */
  private async closeRound(l: Live): Promise<void> {
    const n = l.negotiation;
    if (!n) return;
    if (n.timer) clearTimeout(n.timer);
    n.timer = null;
    const plans = ROLE_ORDER.map((r) => [...n.transcript].reverse().find((m) => m.agent === r)!.plan);
    const deal = agreed(plans) ?? (n.round >= 3 ? nearAgreement(plans) : null);
    if (!deal && n.round < 3 && !l.answer) {
      await this.nextRound(l);
      return;
    }
    const plan: Plan = deal ?? noDeal(plans);
    l.negotiation = undefined;
    const outcome = negotiatedOutcome(n.ruleOutcome, n.transcript, plan, !!deal, n.round);
    await this.conclude(l, outcome);
  }

  /** The final outcome: post it, act on it, and remember it. */
  private async conclude(l: Live, outcome: Outcome, inv?: Position): Promise<void> {
    if (l.outcome) return;
    if (l.investigating) clearTimeout(l.investigating.timer);
    l.investigating = undefined;
    if (inv) outcome = withInvestigator(outcome, inv);
    l.outcome = outcome;
    if (!l.incident.simulated) {
      remember(this.memory, l.incident, l.reports, outcome, l.place ?? null);
      this.o.saveMemory?.(this.memory);
    }
    this.post({ type: 'outcome', outcome });
    this.log(`outcome ${outcome.kind}: ${outcome.headline}`);
    if (this.o.otlpEndpoint)
      void exportIncident(this.o.otlpEndpoint, { incident: l.incident, reports: l.reports, positions: l.positions, traces: l.traces ?? [], outcome }).then((ok) => {
        if (!ok) this.log(`could not send the trace to ${this.o.otlpEndpoint}`);
      });
    for (const q of outcome.quarantined) await this.quarantine(l, q);
    // The person already answered while the agents were arguing: their word stands.
    if (l.answer?.answer === 'ok') {
      this.action(l, 'ask_phone', true, `no call: they already said they are OK (${l.answer.source})`);
      return;
    }
    if (l.answer?.answer === 'help') return; // already called
    await this.act(l, outcome);
  }

  /** Removes a phone from the encrypted channel for two minutes. */
  private async quarantine(l: Live, name: string): Promise<void> {
    const pool = l.incident.simulated ? [...this.simAgents] : [...this.agents.values()];
    const a = pool.find((x) => x.name === name);
    if (!a) return;
    const id = this.phoneMember(a.nodeId);
    const ms = 120000;
    this.quarantined.set(a.nodeId, Date.now() + ms);
    let removed = false;
    try {
      removed = await this.o.bus.remove(id);
    } catch (e) {
      this.log(`could not remove ${id}: ${(e as Error).message}`);
    }
    const where = this.o.bus.kind === 'slim' ? 'the encrypted SLIM channel' : 'the channel';
    this.action(l, 'quarantine', removed, `${name} removed from ${where} for 2 minutes: its reports contradict the other phones${removed ? ', so it can no longer read or post' : ''}`);
    setTimeout(() => {
      this.quarantined.delete(a.nodeId);
      if (!a.nodeId.startsWith('sim-')) this.ensureJoined(a.nodeId);
    }, ms);
  }

  private action(l: Live, action: ActionRecord['action'], ok: boolean, detail: string): void {
    this.post({ type: 'action', action: { incidentId: l.incident.id, action, ok, detail, t: Date.now() } });
    this.log(`${action}: ${detail}`);
  }

  private setStatus(l: Live, s: Incident['status']): void {
    l.incident.status = s;
    this.post({ type: 'incident', incident: { ...l.incident } });
  }

  private async act(l: Live, o: Outcome): Promise<void> {
    if (o.plan) {
      await this.actOnPlan(l, o, o.plan);
      return;
    }
    const sim = l.incident.simulated;
    // Call at once only when waiting would be wrong: help asked for, or a question already went unanswered
    // with physical evidence behind it. A cry heard by one phone alone gets the countdown, not a call.
    if (o.kind === 'escalate') {
      if (l.incident.trigger.kind === 'help_pressed') await this.escalate(l, o.summary);
      else if (l.noAnswer && !this.audioOnly(l)) await this.escalate(l, `${o.summary} They did not answer the phone's question either.`);
      else this.urgentCheck(l);
      return;
    }
    if (o.kind === 'stand_down') {
      if (l.noAnswer && !sim) {
        // The agents see no emergency, but a direct question went unanswered: ask once more if anyone is there.
        const pool = (l.pool ?? []).filter((a) => !a.nodeId.startsWith('sim-'));
        if (pool.some((a) => a.seesSomeone(Date.now()))) {
          this.ask(l, 'Sorry to bother you again. Are you OK?');
          return;
        }
        this.action(l, 'ask_phone', true, 'nobody answered, but no phone sees anyone in the room now: they probably walked away');
      }
      this.setStatus(l, 'stood_down');
      this.watchAfter(l);
      return;
    }
    if (l.noAnswer) {
      if (this.audioOnly(l)) this.urgentCheck(l);
      else await this.escalate(l, `The agents were not sure, and they did not answer the phone's question. ${o.summary}`);
      return;
    }
    this.ask(l, 'Your sensors noticed something and are not sure you are OK.');
  }

  /**
   * The only evidence is one phone's sound classifier hearing distress: no
   * second phone heard it and no phone measured a bang or a body movement.
   * That could be a film or a child; it earns the countdown, never a call by itself.
   */
  private audioOnly(l: Live): boolean {
    const distress = l.reports.filter((r) => r.sound.distress || r.sound.screamDb !== null).length;
    const physical = l.reports.some((r) => (r.sonar.online && r.sonar.burstDb >= 16 && !phoneMovedItself(r)) || (r.sound.impactDb ?? 0) >= 15);
    return (l.incident.trigger.kind === 'scream' || distress > 0) && distress < 2 && !physical;
  }

  /** Carry out the plan the agents negotiated, including its condition. */
  private async actOnPlan(l: Live, o: Outcome, plan: Plan): Promise<void> {
    const sim = l.incident.simulated;
    if (plan.action === 'call') return this.escalate(l, o.headline);
    if (plan.action === 'urgent') {
      if (l.noAnswer && !this.audioOnly(l)) return this.escalate(l, `${o.headline}. They did not answer the phone either.`);
      this.urgentCheck(l);
    } else if (plan.action === 'ask') {
      if (l.noAnswer) return this.escalate(l, `${o.headline}. They did not answer the phone's question either.`);
      this.ask(l, 'Your sensors noticed something and want to make sure you are OK.');
    } else {
      this.setStatus(l, 'stood_down');
      this.watchAfter(l, plan.action === 'watch' ? (plan.callIfNoMovementS ?? 60) : undefined);
      return;
    }
    // The condition they agreed on: call early if nobody moves.
    const s = plan.callIfNoMovementS;
    if (s && !sim) {
      const from = Date.now();
      this.action(l, 'ask_phone', true, `agreed condition: if no phone sees movement within ${s} s, call at once`);
      setTimeout(() => {
        if (l.incident.status !== 'asking' && l.incident.status !== 'urgent') return;
        const pool = (l.pool ?? []).filter((a) => !a.nodeId.startsWith('sim-'));
        if (pool.some((a) => a.movedSince(from))) return;
        this.human(l.incident.id, 'no_answer', `nobody moved within ${s} s (the condition the agents agreed on)`);
      }, s * 1000);
    } else if (s && sim) this.action(l, 'ask_phone', true, `agreed condition: call at once if nobody moves within ${s} s (simulation: not checked)`);
  }

  /** Gentle check-in: "Are you OK?" No answer in time means help is called. */
  private ask(l: Live, reason: string): void {
    const sim = l.incident.simulated;
    this.setStatus(l, 'asking');
    if (!sim) this.o.askPhones(l.incident.id, reason, false, Math.round((this.o.askTimeoutMs ?? 40000) / 1000));
    this.action(l, 'ask_phone', true, sim ? `simulation (demo timer 8 s, real use ${Math.round((this.o.askTimeoutMs ?? 40000) / 1000)} s): the phones would ask "Are you OK?"` : 'asking "Are you OK?" out loud on every phone');
    const ms = sim ? 8000 : (this.o.askTimeoutMs ?? 40000);
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = setTimeout(() => this.human(l.incident.id, 'no_answer', `no answer within ${Math.round(ms / 1000)} s`), ms);
  }

  /**
   * The agents want help called. Like a fall detecting watch, say so out loud
   * first and count down: "I'm OK" cancels, "help" or silence calls at once.
   */
  private urgentCheck(l: Live): void {
    const sim = l.incident.simulated;
    const ms = sim ? 6000 : (this.o.urgentMs ?? 25000);
    this.setStatus(l, 'urgent');
    if (!sim) this.o.askPhones(l.incident.id, 'It looks like you may have fallen.', true, Math.round(ms / 1000));
    this.action(
      l,
      'ask_phone',
      true,
      sim ? `simulation (demo timer ${Math.round(ms / 1000)} s, real use ${Math.round((this.o.urgentMs ?? 25000) / 1000)} s): the phones would say "It looks like you may have fallen" and call unless they say they are OK` : `the agents want help: told them out loud, calling in ${Math.round(ms / 1000)} s unless they say they are OK`,
    );
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = setTimeout(() => this.human(l.incident.id, 'no_answer', `no answer within ${Math.round(ms / 1000)} s of "It looks like you may have fallen"`), ms);
  }

  /**
   * Watchful waiting. If the agents stood down because the person seemed to sit
   * or lie down, that explanation predicts they will move again. If no phone
   * sees them move for a minute, ask them after all.
   */
  private watchAfter(l: Live, agreedS?: number): void {
    if (l.incident.simulated) return;
    const bodyDown = l.reports.some((r) => r.sonar.sawPersonBefore && r.sonar.burstDb >= 16 && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
    if (!bodyDown && agreedS === undefined) return;
    const from = agreedS !== undefined ? Date.now() : l.incident.t0 + 12000;
    const ms = (agreedS ?? Number(process.env.ECHOSENSE_WATCH_SECONDS ?? 60)) * 1000;
    this.action(l, 'ask_phone', true, `watching: if nobody moves in the next ${Math.round(ms / 1000)} s, they will be asked`);
    setTimeout(() => {
      if (l.incident.status !== 'stood_down') return;
      const pool = [...this.agents.values()].filter((a) => !a.nodeId.startsWith('sim-') && l.incident.expected.includes(a.nodeId));
      const moved = pool.some((a) => a.movedSince(from));
      const someone = pool.some((a) => a.seesSomeone(Date.now()));
      if (moved || !someone) {
        this.action(l, 'ask_phone', true, moved ? 'they moved again: nothing to do' : 'nobody in view any more: they got up and left');
        return;
      }
      this.setStatus(l, 'asking');
      const reason = 'You have not moved for a while. Are you OK?';
      this.o.askPhones(l.incident.id, reason);
      this.action(l, 'ask_phone', true, `no movement for ${Math.round((Date.now() - from) / 1000)} s since: asking "Are you OK?" on every phone`);
      l.askTimer = setTimeout(() => this.human(l.incident.id, 'no_answer', 'no answer to the follow up check-in'), this.o.askTimeoutMs ?? 40000);
    }, ms);
  }

  private async escalate(l: Live, why: string): Promise<void> {
    if (l.escalated) return;
    l.escalated = true;
    this.setStatus(l, 'escalated');
    const sim = l.incident.simulated;
    // The person hears it first.
    if (!sim) {
      this.o.clearPhones?.();
      this.o.tellPhones('Help has been called.');
    }
    const place = l.incident.trigger.name;
    const said = l.answer?.transcript;
    const when = new Date(l.incident.t0).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const spoken = `This is EchoSense. ${sim ? 'This is a simulation. ' : ''}A possible fall was detected near ${place}.${said ? ` They said: ${said}.` : l.answer?.answer === 'no_answer' ? ' They did not answer when asked if they were OK.' : ''} Please check on them.`;
    const finals = ['responder', 'skeptic', 'auditor'].map((r) => [...l.positions].reverse().find((p) => p.agent === r)).filter((p): p is Position => !!p);
    const fallback = `${sim ? '(Simulation) ' : ''}Possible fall near ${place} at ${when}. ${why}`.slice(0, 600);
    const useClaude = this.o.llm.mode !== 'off' && (this.o.budget?.canSpend() ?? true);
    const brief = await caregiverBrief(
      useClaude ? this.o.llm : null,
      {
        place,
        time: when,
        simulation: sim,
        trigger: l.incident.trigger.detail,
        person_said: said ?? null,
        injury: l.answer?.injury ?? null,
        answered: l.answer?.answer ?? null,
        why_help_is_called: why,
        agents: finals.map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument })),
      },
      fallback,
      (u) => this.o.budget?.add(u),
    );
    const text = `EchoSense${sim ? ' (simulation)' : ''}: ${brief}`.slice(0, 600);
    const real = !sim || this.realCallsForSims;
    const facts = [
      { title: 'Where', value: `${place}, ${when}` },
      ...(said ? [{ title: 'They said', value: `"${said}"` }] : []),
      ...(l.outcome?.plan ? [{ title: l.outcome.negotiation?.agreed ? 'Agents agreed' : 'Agents disagreed', value: l.outcome.negotiation?.agreed ? describePlan(l.outcome.plan) : 'the evidence was not enough to agree, so the person was asked' }] : []),
      ...finals.map((p) => ({ title: ROLE_INFO[p.agent].title, value: `${stanceWord(p.stance)}: ${p.argument}`.slice(0, 300) })),
    ];
    const n = this.o.notifier;
    // Webex goes out for scenarios too: it is the console's "chat" for the demo.
    const [c, s, w, x] = await Promise.all([
      real ? n.call(l.incident.id, spoken) : Promise.resolve({ ok: true, detail: `simulation: would call the caregiver and say "${spoken}"` }),
      real ? n.sms(text) : Promise.resolve({ ok: true, detail: 'simulation: would text the caregiver' }),
      real ? n.webhook(text) : Promise.resolve({ ok: true, detail: 'simulation: would post to the chat webhook' }),
      n.webex(l.incident.id, `${sim ? 'Simulation: ' : ''}possible fall near ${place}`, brief, facts, true),
    ]);
    this.action(l, 'call', c.ok, c.detail);
    this.action(l, 'sms', s.ok, s.detail);
    this.action(l, 'webhook', w.ok, w.detail);
    this.action(l, 'webex', x.ok, x.detail);
  }

  /** A human answered: the person on the phone, the caregiver on the call, or someone at the console. */
  human(incidentId: string, answer: 'ok' | 'help' | 'no_answer', source: string, extra: { transcript?: string; injury?: string | null } = {}): void {
    const l = this.live.get(incidentId);
    if (!l) return;
    const prev = l.answer?.answer;
    // The same answer twice (the phone and the hub both report it) changes nothing.
    if (prev === answer && answer !== 'no_answer') return;
    if (prev === 'help' && answer !== 'ok') return;
    if (prev === 'ok' && answer === 'no_answer') return;
    if (answer === 'no_answer' && !l.outcome) {
      // A phone's own question timed out while the agents are still arguing: remember it, they decide with it.
      l.noAnswer = true;
      this.action(l, 'ask_phone', true, `${source}; the agents will take that into account`);
      return;
    }
    if (answer === 'no_answer' && l.outcome?.kind === 'stand_down' && l.incident.status === 'stood_down') return;
    if (answer === 'no_answer' && l.incident.status === 'asking' && this.audioOnly(l) && !l.askedTwice) {
      l.askedTwice = true;
      this.action(l, 'ask_phone', true, `${source}; only one phone heard a cry and nothing physical backs it up, so the countdown comes before any call`);
      this.urgentCheck(l);
      return;
    }
    if (l.askTimer) clearTimeout(l.askTimer);
    l.askTimer = null;
    l.answer = { answer, source, t: Date.now(), ...extra };
    this.post({ type: 'human', incidentId, answer, source, t: Date.now(), ...extra });
    this.learnFrom(incidentId, answer, source);
    const said = extra.transcript ? ` They said: "${extra.transcript}".` : '';
    if (answer === 'ok') {
      const was = l.escalated;
      const asked = l.incident.status === 'asking' || l.incident.status === 'urgent';
      if (!l.incident.simulated) this.lastOkAt = Date.now();
      this.setStatus(l, 'resolved_ok');
      if (!l.incident.simulated) {
        this.o.clearPhones?.();
        this.o.tellPhones(was ? "Okay. I've told your family you're OK." : "Okay, glad you're OK.");
      }
      if (was && !l.incident.simulated) void this.o.notifier.sms(`EchoSense: update, they say they are OK (${source}).${said}`);
      if (was) void this.o.notifier.webexText(`**EchoSense update: they are OK.** ${source}.${said}`);
      else if (asked && !l.incident.simulated)
        void this.o.notifier.webexText(`EchoSense checked in after ${describeTrigger(l.incident)} near ${l.incident.trigger.name}: they said they are OK (${source}).${said} No action needed.`);
      return;
    }
    const why =
      answer === 'help'
        ? `They asked for help (${source}).${said}${extra.injury ? ` Injury: ${extra.injury}.` : ''}`
        : `Asked if they were OK and got no answer (${source}).`;
    void this.escalate(l, why).then(() => {
      if (answer === 'help') this.setStatus(l, 'resolved_help');
    });
  }

  /**
   * The person spoke and the hub understood it (speech to text, then Claude or
   * the keyword rules). Applies to the open incident, or opens one if they
   * asked for help out of the blue.
   */
  personSaid(nodeId: string, name: string, transcript: string, answer: 'ok' | 'help', injury: string | null): boolean {
    const inc = this.latestOpen();
    if (inc) {
      this.human(inc.incident.id, answer, `${name}: said "${transcript}"`, { transcript, injury });
      return true;
    }
    if (answer === 'help') {
      this.trigger(nodeId, 'help_pressed', `said "${transcript}"`, Date.now());
      return true;
    }
    this.lastOkAt = Date.now();
    return false;
  }

  /** A line on the console under the open incident (or on its own). */
  note(detail: string): void {
    const inc = this.latestOpen();
    this.post({ type: 'action', action: { incidentId: inc?.incident.id ?? '-', action: 'ask_phone', ok: true, detail, t: Date.now() } });
  }

  /** A person's answer is the label the agents learn from. */
  /** Everything the phones and agents produced for one incident, for a labelled training record. */
  incidentRecord(id: string): { incident: Incident; reports: EvidenceReport[]; positions: Position[]; outcome: Outcome | null; answer: Live['answer'] | null; moves: Move[]; escalated: boolean } | null {
    const l = this.live.get(id);
    if (!l) return null;
    return { incident: l.incident, reports: l.reports, positions: l.positions, outcome: l.outcome, answer: l.answer ?? null, moves: l.negotiation?.transcript ?? [], escalated: l.escalated };
  }

  private learnFrom(incidentId: string, answer: 'ok' | 'help' | 'no_answer', source: string): void {
    const l = this.live.get(incidentId);
    if (!l || l.incident.simulated) return;
    learn(this.memory, incidentId, answer, source);
    this.o.saveMemory?.(this.memory);
  }

  /** Caregiver pressed a key on the call. */
  caregiver(incidentId: string, digit: string, by?: string): void {
    const l = this.live.get(incidentId);
    if (!l) return;
    if (digit === '1') {
      if (l.askTimer) clearTimeout(l.askTimer);
      l.askTimer = null;
      l.answer = { answer: 'help', source: by ? `${by} is on the way` : 'caregiver pressed 1: on the way', t: Date.now() };
      this.post({ type: 'human', incidentId, answer: 'help', source: l.answer.source, t: Date.now() });
      this.learnFrom(incidentId, 'help', by ?? 'caregiver');
      void this.o.notifier.webexText(`EchoSense: ${by ?? 'a caregiver'} is on the way. Told the phones.`);
      this.setStatus(l, 'resolved_help');
      if (!l.incident.simulated) this.o.tellPhones('Help is on the way.');
    } else if (digit === '2') this.human(incidentId, 'ok', by ? `${by} says they are OK` : 'caregiver pressed 2: false alarm');
  }

  // ---------------------------------------------------------------- room map
  private saveSoon(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.o.saveMap?.(this.map);
    }, 2000);
  }

  /** "I'm standing at the sofa": every phone that can see you records how far away you are. */
  async markPlace(name: string, kind: PlaceKind): Promise<{ ok: boolean; detail: string }> {
    // Sonar loses a person who stands perfectly still, so measure while they sway for 5 s.
    await new Promise((r) => setTimeout(r, 5000));
    const now = Date.now();
    const ranges: Record<string, number> = {};
    const parts: string[] = [];
    const missed: string[] = [];
    const live = [...this.agents.values()].filter((a) => !a.nodeId.startsWith('sim-') && now - a.lastSeen <= 5000);
    for (const a of live) {
      const r = a.recentRange(5500, now);
      if (r !== null) {
        ranges[a.nodeId] = r;
        parts.push(`${a.name} ${r.toFixed(1)} m`);
      } else missed.push(a.name);
    }
    if (!live.length) return { ok: false, detail: 'No phone is connected and sensing. Open the link on the phones first.' };
    if (!parts.length)
      return {
        ok: false,
        detail: `No phone could see you (${missed.join(', ')}). Stand within about 3 m of a phone, in front of its bottom edge, sway gently, and try again.`,
      };
    const clean = name.trim().slice(0, 40) || PLACE_KINDS.find((k) => k.kind === kind)?.label || 'place';
    this.map.places = this.map.places.filter((p) => p.name.toLowerCase() !== clean.toLowerCase());
    this.map.places.push({ id: uid('place'), name: clean, kind, ranges, createdAt: now });
    this.o.saveMap?.(this.map);
    return { ok: true, detail: `Saved "${clean}": ${parts.join(', ')}${missed.length ? ` (${missed.join(', ')} could not see you, which is fine)` : ''}` };
  }

  removePlace(id: string): void {
    this.map.places = this.map.places.filter((p) => p.id !== id);
    this.o.saveMap?.(this.map);
  }

  labelPhone(nodeId: string, label: string, near?: PlaceKind): void {
    if (!label && !near) delete this.map.phones[nodeId];
    else this.map.phones[nodeId] = { label: label.slice(0, 40), near };
    this.o.saveMap?.(this.map);
  }

  // ---------------------------------------------------------------- demo controls
  setCompromised(nodeId: string, on: boolean): void {
    if (on) this.compromised.add(nodeId);
    else this.compromised.delete(nodeId);
  }

  /** A compromised phone injects a fake fall right now. */
  injectFake(nodeId: string): void {
    const a = this.agents.get(nodeId);
    if (!a) return;
    this.compromised.add(nodeId);
    this.trigger(nodeId, 'fall_alert', 'Possible fall (reported by this phone)', Date.now() - 6000);
  }

  /** Plays a simulated scenario through virtual phone agents and the same protocol. */
  runScenario(key: string, seed = Math.floor(Math.random() * 1000) + 1): boolean {
    const spec = SCENARIOS.find((s) => s.key === key);
    if (!spec || this.simRunning) return false;
    this.simRunning = true;
    setTimeout(() => (this.simRunning = false), 3000);
    const trial = generate(spec, seed);
    this.simMap = simHomeMap(trial);
    // Shift the recording so the event happened GATHER_MS ago.
    const shift = Date.now() - GATHER_MS - T0;
    const triggers: { t: number; nodeId: string; kind: TriggerKind; detail: string }[] = [];
    const agents = trial.streams.map((s) => new PhoneAgent(s.phone.nodeId, `Sim ${s.phone.name}`, (kind, detail, t) => triggers.push({ t, nodeId: s.phone.nodeId, kind, detail })));
    this.simAgents = agents;
    // Simulated phones may have been quarantined by an earlier scenario: let them back in.
    for (const a of agents) this.quarantined.delete(a.nodeId);
    const evs: { t: number; run: () => void }[] = [];
    trial.streams.forEach((s, i) => {
      for (const x of s.samples) evs.push({ t: x.t + shift, run: () => agents[i].onSample({ ...x, t: x.t + shift }) });
      for (const x of s.sounds) evs.push({ t: x.t + shift, run: () => agents[i].onSound({ ...x, t: x.t + shift }) });
      for (const x of s.alerts) evs.push({ t: x.t + shift, run: () => agents[i].onAlert({ ...x, t: x.t + shift }) });
    });
    evs.sort((a, b) => a.t - b.t);
    for (const e of evs) e.run();
    // Play the incident around the scripted moment (the evaluation also scores any others).
    const t0 = T0 + shift;
    const main = triggers.filter((tr) => tr.t >= t0 - SAME_EVENT_MS && tr.t <= t0 + 9000).sort((a, b) => a.t - b.t)[0];
    if (main) this.trigger(main.nodeId, main.kind, main.detail, main.t, { simulated: true, scenario: spec.key, agents, gatherMs: 2500 });
    if (!main) {
      this.post({
        type: 'action',
        action: { incidentId: '-', action: 'ask_phone', ok: true, detail: `${spec.title}: no phone raised anything, nothing to deliberate`, t: Date.now() },
      });
    }
    this.log(`scenario ${spec.key} seed ${seed}: ${triggers.length} triggers`);
    return true;
  }
}

function describeTrigger(i: Incident): string {
  return { impact: 'a loud bang', burst: 'a sudden movement', fall_alert: 'a possible fall', scream: 'a scream', help_pressed: 'a call for help', phone_drop: 'a dropped phone' }[i.trigger.kind];
}

/** What a compromised phone sends instead of the truth: an internally consistent fake fall. */
function forge(r: EvidenceReport, t0: number): EvidenceReport {
  const rng = new Rng(t0 % 100000);
  const r0 = rng.uniform(1.3, 1.8);
  return {
    ...r,
    samples: Math.max(r.samples, 80),
    silenceMs: 100,
    sound: {
      impactDb: rng.uniform(28, 33),
      impactRepetitive: false,
      screamDb: null,
      mediaEventsBefore: 0,
      voiceAfter: false,
      impactAi: { group: 'thud', score: 0.6, label: 'Thump, thud' },
      media: 0,
      distress: false,
    },
    sonar: {
      online: true,
      medianLinkDb: 24,
      sawPersonBefore: true,
      rangeBefore: r0,
      rangeAfter: r0 + 0.55,
      burstDb: rng.uniform(26, 30),
      stillAfter: 1,
      motionResumed: false,
      presentAfter: true,
      lastSeenAgo: 0.5,
      firstMoveAfter: null,
      breathingAfter: null,
      roomChangeDb: 2,
    },
    imu: { moved: false, dropped: false },
    localVerdict: 'fall',
  };
}

export { ROLE_INFO, stanceWord };
