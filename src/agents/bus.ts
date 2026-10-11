import { fromA2A, toA2A } from './a2a';
import type { BoardMsg, EvidenceReport, Incident } from './types';

/**
 * The shared channel the agents talk on.
 *
 * With AGNTCY SLIM (default when the package is installed) every agent has its
 * own SLIM identity, witness/<home>/<agent>, and joins one group session with
 * MLS end to end encryption. The hub runs the SLIM node in process (or connects
 * to one given by SLIM_ENDPOINT), acts as the channel moderator, and removes a
 * phone from the group when the Auditor quarantines it.
 *
 * Without SLIM the same protocol runs over an in memory bus.
 */

export type WireMsg =
  | BoardMsg
  | { type: 'evidence_closed'; incident: Incident; reportIds: string[] }
  /** The role agents could not agree: the moderator calls in the Investigator with what they said. */
  | { type: 'investigate'; incident: Incident; positions: import('./types').Position[] }
  /**
   * The Investigator asks phones to look again. target null is a broadcast
   * (every phone in the incident answers, like the AGNTCY auction pattern);
   * a phone name addresses one phone.
   */
  /** The moderator opens a negotiation round: every role agent answers with one move. */
  | { type: 'negotiate'; incident: Incident; round: number; lastRound: boolean; transcript: import('./negotiation').Move[] }
  | { type: 'look_request'; requestId: string; incidentId: string; target: string | null; waitS: number }
  | { type: 'look_reply'; requestId: string; incidentId: string; phone: string; look: Record<string, unknown> }
  | { type: 'hello'; agent: string };

export interface BusMember {
  readonly id: string;
  /** Full identity on the channel, e.g. witness/home/responder. */
  readonly address: string;
  publish(msg: WireMsg): Promise<void>;
  onMessage(handler: (from: string, msg: WireMsg) => void): void;
}

export interface BusInfo {
  kind: 'slim' | 'local';
  channel: string;
  encrypted: boolean;
  endpoint: string;
  members: string[];
  removed: string[];
  note: string;
}

export interface Bus {
  readonly kind: 'slim' | 'local';
  readonly moderator: BusMember;
  join(id: string): Promise<BusMember>;
  /** Kick a member out of the channel (it can no longer read or post). */
  remove(id: string): Promise<boolean>;
  isMember(id: string): boolean;
  info(): BusInfo;
}

export function memberId(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48) || 'agent';
}

// ---------------------------------------------------------------- in memory
class LocalMember implements BusMember {
  handlers: ((from: string, msg: WireMsg) => void)[] = [];
  constructor(
    readonly id: string,
    readonly address: string,
    private readonly bus: LocalBus,
  ) {}
  async publish(msg: WireMsg): Promise<void> {
    this.bus.deliver(this, msg);
  }
  onMessage(h: (from: string, msg: WireMsg) => void): void {
    this.handlers.push(h);
  }
}

export class LocalBus implements Bus {
  readonly kind = 'local' as const;
  readonly moderator: LocalMember;
  private members = new Map<string, LocalMember>();
  private removed = new Set<string>();
  constructor(
    private readonly home = 'home',
    private readonly note = 'in memory channel',
  ) {
    this.moderator = new LocalMember('moderator', `witness/${home}/moderator`, this);
    this.members.set('moderator', this.moderator);
  }
  deliver(from: LocalMember, msg: WireMsg): void {
    if (!this.members.has(from.id)) return;
    const copy = fromA2A(JSON.parse(JSON.stringify(toA2A(msg, from.address))))!;
    for (const m of this.members.values()) {
      if (m === from) continue;
      queueMicrotask(() => {
        for (const h of m.handlers) h(from.id, copy);
      });
    }
  }
  async join(raw: string): Promise<BusMember> {
    const id = memberId(raw);
    let m = this.members.get(id);
    if (!m) {
      m = new LocalMember(id, `witness/${this.home}/${id}`, this);
      this.members.set(id, m);
    }
    this.removed.delete(id);
    return m;
  }
  async remove(raw: string): Promise<boolean> {
    const id = memberId(raw);
    const had = this.members.delete(id);
    if (had) this.removed.add(id);
    return had;
  }
  isMember(raw: string): boolean {
    return this.members.has(memberId(raw));
  }
  info(): BusInfo {
    return {
      kind: 'local',
      channel: `witness/${this.home}/board`,
      encrypted: false,
      endpoint: 'in process',
      members: [...this.members.keys()],
      removed: [...this.removed],
      note: this.note,
    };
  }
}

// ---------------------------------------------------------------- AGNTCY SLIM
/* eslint-disable @typescript-eslint/no-explicit-any */
type Slim = any;

// Keep a real dynamic import (the hub is bundled as CommonJS; the bindings are an ES module).
const importEsm = new Function('s', 'return import(s)') as (s: string) => Promise<Slim>;

class SlimMember implements BusMember {
  handlers: ((from: string, msg: WireMsg) => void)[] = [];
  session: any = null;
  alive = true;
  constructor(
    readonly id: string,
    readonly address: string,
    readonly name: any,
    readonly app: any,
    /** Every call into the native library goes through one queue (mixing calls can deadlock it). */
    private readonly run: <T>(f: () => Promise<T>) => Promise<T>,
  ) {}
  async publish(msg: WireMsg): Promise<void> {
    if (!this.session || !this.alive) return;
    const data = Buffer.from(JSON.stringify(toA2A(msg)));
    await this.run(() => (this.alive ? this.session.publishAndWaitAsync(data, 'application/json', undefined) : Promise.resolve()));
  }
  onMessage(h: (from: string, msg: WireMsg) => void): void {
    this.handlers.push(h);
  }
  async loop(onEnd: () => void): Promise<void> {
    while (this.alive && this.session) {
      let rec: any;
      try {
        rec = await this.session.getMessageAsync(60000);
      } catch (e: any) {
        const why = String(e?.inner?.message ?? e?.message ?? e);
        if (/timeout|timed out/i.test(why)) continue;
        this.alive = false;
        onEnd();
        return;
      }
      try {
        const msg = fromA2A(JSON.parse(Buffer.from(rec.payload).toString('utf8')));
        if (!msg) continue;
        const from = String(rec.context.sourceName).split('/').pop() ?? '?';
        for (const h of this.handlers) h(from, msg);
      } catch {
        /* not ours */
      }
    }
  }
}

export interface SlimOptions {
  home: string;
  /** Connect to this SLIM node instead of running one in process, e.g. http://localhost:46357 */
  endpoint?: string;
  /** Address for the in process node. */
  listen: string;
  secret: string;
  log: (s: string) => void;
}

export class SlimBus implements Bus {
  readonly kind = 'slim' as const;
  moderator!: SlimMember;
  private slim: Slim;
  private service: any;
  private connId = 0n;
  private session: any;
  private members = new Map<string, SlimMember>();
  private removed = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();
  private endpoint = '';
  private mls = false;

  private constructor(private readonly o: SlimOptions) {}

  static async start(o: SlimOptions): Promise<SlimBus> {
    const bus = new SlimBus(o);
    await bus.init();
    return bus;
  }

  private async init(): Promise<void> {
    const slim = (this.slim = await importEsm('@agntcy/slim-bindings'));
    if (!slim.isInitialized?.()) {
      slim.initializeWithConfigs(slim.newRuntimeConfig(), slim.newTracingConfigWith('error', false, false, []), [slim.newServiceConfig()]);
    }
    this.service = slim.getGlobalService();
    if (!this.o.endpoint) {
      this.service.runServer(slim.newInsecureServerConfig(this.o.listen));
      await new Promise((r) => setTimeout(r, 300));
      this.endpoint = `http://${this.o.listen.replace('0.0.0.0', '127.0.0.1')}`;
    } else this.endpoint = this.o.endpoint;
    this.connId = BigInt(await this.service.connectAsync(slim.newInsecureClientConfig(this.endpoint)));
    const mod = await this.makeApp('moderator');
    this.moderator = mod;
    this.session = await mod.app.createSessionAndWaitAsync(
      {
        sessionType: slim.SessionType.Group,
        maxRetries: 5,
        interval: 1000,
        metadata: new Map([['purpose', 'witness deliberation board']]),
        mlsSettings: { headerIntegrityValidationPercent: 100 },
      },
      new slim.Name('witness', this.o.home, 'board'),
    );
    mod.session = this.session;
    this.mls = !!this.session.config?.()?.mlsSettings;
    this.members.set('moderator', mod);
    void mod.loop(() => this.o.log('moderator session ended'));
  }

  private async makeApp(id: string): Promise<SlimMember> {
    const name = new this.slim.Name('witness', this.o.home, id);
    const app = this.service.createAppWithSecret(name, this.o.secret);
    await app.subscribeAsync(name, this.connId);
    return new SlimMember(id, `witness/${this.o.home}/${id}`, name, app, this.run);
  }

  private readonly run = <T>(f: () => Promise<T>): Promise<T> => this.serial(f);

  /** Invites, removals and publishes run one at a time (each invite is an MLS commit). */
  private serial<T>(f: () => Promise<T>): Promise<T> {
    const next = this.queue.then(f, f);
    this.queue = next.catch(() => undefined);
    return next;
  }

  join(raw: string): Promise<BusMember> {
    const id = memberId(raw);
    const have = this.members.get(id);
    if (have && have.alive) return Promise.resolve(have);
    return this.serial(async () => {
      const again = this.members.get(id);
      if (again && again.alive) return again;
      const m = again && !again.alive ? new SlimMember(id, again.address, again.name, again.app, this.run) : await this.makeApp(id);
      if (again) m.handlers = again.handlers;
      let lastErr: unknown = null;
      for (let attempt = 0; attempt < 3 && !m.session; attempt++) {
        if (attempt) await new Promise((r) => setTimeout(r, 700));
        const listening = m.app.listenForSessionAsync(6000) as Promise<unknown>;
        listening.catch(() => undefined);
        try {
          await this.moderator.app.setRouteAsync(m.name, this.connId);
          await this.session.inviteAndWaitAsync(m.name);
          m.session = await listening;
        } catch (e) {
          lastErr = e;
        }
      }
      if (!m.session) throw new Error(`could not invite ${m.address}: ${String((lastErr as any)?.inner?.message ?? lastErr)}`);
      m.alive = true;
      this.members.set(id, m);
      this.removed.delete(id);
      void m.loop(() => this.o.log(`${m.address} left the channel`));
      return m;
    });
  }

  remove(raw: string): Promise<boolean> {
    const id = memberId(raw);
    return this.serial(async () => {
      const m = this.members.get(id);
      if (!m || !m.alive) return false;
      await this.session.removeAndWaitAsync(m.name);
      m.alive = false;
      this.removed.add(id);
      return true;
    });
  }

  isMember(raw: string): boolean {
    return !!this.members.get(memberId(raw))?.alive;
  }

  info(): BusInfo {
    return {
      kind: 'slim',
      channel: `witness/${this.o.home}/board`,
      encrypted: this.mls,
      endpoint: this.o.endpoint ? this.endpoint : `${this.endpoint} (SLIM node inside the hub)`,
      members: [...this.members.values()].filter((m) => m.alive).map((m) => m.id),
      removed: [...this.removed],
      note: 'AGNTCY SLIM group session',
    };
  }
}

/** SLIM when available, otherwise the in memory bus. */
export async function startBus(o: SlimOptions & { enabled: boolean }): Promise<Bus> {
  if (!o.enabled) return new LocalBus(o.home, 'SLIM turned off (ECHOSENSE_SLIM=0)');
  try {
    const bus = await SlimBus.start(o);
    o.log(`AGNTCY SLIM channel ${bus.info().channel} ready (${bus.info().encrypted ? 'MLS encrypted' : 'not encrypted'}) at ${bus.info().endpoint}`);
    return bus;
  } catch (e) {
    const why = (e as Error).message ?? String(e);
    o.log(`SLIM unavailable (${why.slice(0, 160)}). Run "npm install" in the echosense folder to enable it. Using the in memory channel.`);
    return new LocalBus(o.home, 'SLIM not installed: run npm install');
  }
}

export type { EvidenceReport };
