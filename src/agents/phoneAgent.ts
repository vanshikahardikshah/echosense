import type { AlertObs, EvidenceReport, ImuObs, SoundObs, StreamSample, TriggerKind } from './types';

/** Evidence windows relative to the incident time, ms. */
export const WINDOW = {
  before: [-4500, -400] as const,
  around: [-2000, 1500] as const,
  after: [1500, 11500] as const,
  sound: [-2500, 2500] as const,
  media: [-12000, -500] as const,
};
/** How long after the incident the phone agents wait before reporting. */
export const GATHER_MS = WINDOW.after[1] + 300;
/** Triggers this close to an open incident belong to the same event. */
export const SAME_EVENT_MS = 3000;

const BURST_DB = 20;
const MOVING_DB = 12;

let seq = 0;
export function uid(prefix: string): string {
  seq = (seq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

/**
 * A "scream" from the loudness detector is only believed when the sound model
 * agrees (screaming, crying, groaning). Animated talking on a phone call is
 * loud and high pitched too; the model hears it as speech.
 */
function screamConfirmed(e: SoundObs): boolean {
  if (e.ai) return e.ai.group === 'distress' && e.ai.score >= 0.5;
  return e.confidence >= 0.8 && e.aboveFloorDb >= 28;
}
function isDistressSound(e: SoundObs): boolean {
  if (e.ai) return e.ai.group === 'distress' && e.ai.score >= 0.5;
  return e.cls === 'scream' && screamConfirmed(e);
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

/**
 * A phone as an agent. It keeps a short rolling memory of its own stream,
 * raises triggers when something happens, and, when an incident opens
 * anywhere in the home, answers with what it saw: no raw audio, only
 * measured facts with numbers.
 */
export class PhoneAgent {
  private samples: StreamSample[] = [];
  private sounds: SoundObs[] = [];
  private alerts: AlertObs[] = [];
  private imu: ImuObs[] = [];
  private lastBurstTrigger = -1e12;
  lastSeen = 0;

  constructor(
    readonly nodeId: string,
    public name: string,
    private readonly onTrigger: (kind: TriggerKind, detail: string, t: number) => void = () => {},
  ) {}

  private trim(now: number): void {
    const keep = now - 40000;
    while (this.samples.length && this.samples[0].t < keep) this.samples.shift();
    while (this.sounds.length && this.sounds[0].t < keep) this.sounds.shift();
    while (this.alerts.length && this.alerts[0].t < keep) this.alerts.shift();
    while (this.imu.length && this.imu[0].t < keep) this.imu.shift();
  }

  onSample(s: StreamSample): void {
    this.samples.push(s);
    this.lastSeen = s.t;
    this.trim(s.t);
    if (s.sonarOk && s.fastMotionDb >= BURST_DB + 4 && s.t - this.lastBurstTrigger > 10000) {
      this.lastBurstTrigger = s.t;
      this.stillCand = null;
      this.onTrigger('burst', `sudden body motion, ${s.fastMotionDb.toFixed(0)} dB`, s.t);
      return;
    }
    // Quieter pattern: sudden movement followed by stillness (a slow collapse
    // makes no bang). Sitting down looks the same; the agents sort that out.
    const present = s.presence === 'moving' || s.presence === 'still';
    if (s.sonarOk && present && s.fastMotionDb >= 16) {
      this.stillCand = { t: s.t, db: s.fastMotionDb };
    } else if (this.stillCand && s.t - this.stillCand.t >= 6000) {
      const c = this.stillCand;
      this.stillCand = null;
      const after = this.samples.filter((x) => x.t > c.t + 1500);
      const ok = after.length >= 10 && after.every((x) => x.sonarOk);
      const still = ok && after.filter((x) => x.fastMotionDb < MOVING_DB).length / after.length >= 0.85;
      const stayed = ok && after.filter((x) => x.presence === 'moving' || x.presence === 'still').length / after.length >= 0.5;
      if (still && stayed && c.t - this.lastBurstTrigger > 20000) {
        this.lastBurstTrigger = c.t;
        this.onTrigger('burst', `sudden movement (${c.db.toFixed(0)} dB), then no movement`, c.t);
      }
    }
  }
  private stillCand: { t: number; db: number } | null = null;

  onSound(e: SoundObs): void {
    this.sounds.push(e);
    this.lastSeen = Math.max(this.lastSeen, e.t);
    this.trim(e.t);
    // The phone's sound model called it harmless (a snap, a tap, talking, TV). Very loud
    // sounds still go to the agents, in case the model is wrong.
    // A soft fall onto a rug or a cushion can sound like a tap. The label only counts as harmless
    // when the sonar saw no sudden body movement around the same moment.
    const bodyMoved = this.samples.some((x) => x.sonarOk && Math.abs(x.t - e.t) <= 1500 && x.fastMotionDb >= 16);
    if (e.benign && e.aboveFloorDb < 30 && !bodyMoved) return;
    if (e.cls === 'impact' && ((e.confidence >= 0.55 && e.aboveFloorDb >= 15) || (bodyMoved && e.aboveFloorDb >= 10))) {
      this.onTrigger('impact', `impact ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    } else if (e.cls === 'scream' && e.confidence >= 0.6 && screamConfirmed(e)) {
      this.onTrigger('scream', `scream ${e.aboveFloorDb.toFixed(0)} dB above the room (${e.ai?.top?.[0]?.name ?? 'loud'})`, e.t);
    } else if (e.cls === 'scream' && e.aboveFloorDb >= 30 && e.ai && e.ai.group !== 'media' && (e.ai.top ?? []).some((x) => /Shout|Yell|Screaming/.test(x.name) && x.score >= 0.4)) {
      // "Help!" shouted across the room: far louder than conversation. It only starts a check-in.
      this.onTrigger('scream', `a loud shout, ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    }
  }

  onAlert(a: AlertObs): void {
    this.alerts.push(a);
    this.lastSeen = Math.max(this.lastSeen, a.t);
    if (a.kind === 'fall') {
      // The phone decides about 6 s after the event; anchor to the event itself.
      const recent = [
        ...this.sounds.filter((e) => e.cls === 'impact' || e.cls === 'knock').map((e) => e.t),
        ...this.samples.filter((x) => x.sonarOk && x.fastMotionDb >= BURST_DB).map((x) => x.t),
      ].filter((t) => t <= a.t && t >= a.t - 9000);
      this.onTrigger('fall_alert', a.title, recent.length ? Math.min(...recent.filter((t) => t >= Math.max(...recent) - 2500)) : a.t - 6000);
    }
    else if (a.kind === 'escalation' && /help/i.test(a.title)) this.onTrigger('help_pressed', a.title, a.t);
    else if (a.kind === 'phone_drop') {
      this.imu.push({ t: a.t, type: 'drop' });
      this.onTrigger('phone_drop', a.title, a.t);
    } else if (a.kind === 'phone_moved') this.imu.push({ t: a.t, type: 'moved' });
  }

  /** Whether this phone saw someone move (not just breathe) between t and now. */
  movedSince(t: number): boolean {
    return this.samples.filter((s) => s.t >= t && s.sonarOk && s.fastMotionDb >= 14 && s.motionDb >= 14).length >= 6;
  }

  /** Whether this phone sees someone right now. */
  seesSomeone(now: number): boolean {
    const xs = this.samples.filter((s) => s.t >= now - 3000 && s.sonarOk);
    return xs.length > 5 && xs.filter((s) => s.presence === 'moving' || s.presence === 'still').length / xs.length >= 0.5;
  }

  /**
   * A fresh look, on request from a role agent: what this phone measures right
   * now and since the incident (the report only covers the first 11 seconds).
   */
  lookNow(t0: number, now: number): Record<string, unknown> {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.t > 5000) return { streaming: false, note: 'this phone is not streaming right now (locked, closed, or a recording that has ended)' };
    const recent = this.samples.filter((s) => s.t >= now - 4000 && s.sonarOk);
    const since = this.samples.filter((s) => s.t >= t0 + 11500 && s.sonarOk);
    const moving = recent.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length;
    let breathing: number | null = null;
    for (const s of recent) if (s.breathing && s.breathing.quality >= 0.3) breathing = Math.round(s.breathing.rateBpm);
    const sounds = this.sounds.filter((e) => e.t >= t0 + 2500 && e.t <= now);
    const heard = [...new Set(sounds.map((e) => (e.ai && e.ai.score >= 0.3 ? (e.ai.words ?? e.ai.group) : e.cls)))].slice(0, 6);
    return {
      streaming: true,
      seconds_since_incident: Math.round((now - t0) / 1000),
      sonar_running: recent.length >= 5,
      sees_someone_now: this.seesSomeone(now),
      moving_now: recent.length ? moving / recent.length >= 0.25 : null,
      distance_now_m: this.recentRange(4000, now)?.toFixed(2) ?? null,
      breathing_bpm_now: breathing,
      moved_since_report: since.length ? this.movedSince(t0 + 11500) : null,
      sounds_since_incident: heard,
      voice_since_incident: sounds.some((e) => e.cls === 'voice' || e.ai?.group === 'speech'),
      distress_since_incident: sounds.some(isDistressSound),
    };
  }

  /** Median distance of a confirmed target over the last span ms (null if none seen). */
  recentRange(span: number, now: number): number | null {
    // Any credible echo of the person counts here: a track (even unconfirmed) or the breathing range.
    const xs = this.samples
      .filter((s) => s.t >= now - span && s.sonarOk)
      .map((s) => (s.range !== null && (s.confirmed || s.snrDb >= 10) ? s.range : s.breathing ? s.breathing.range : null))
      .filter((r): r is number => r !== null);
    if (xs.length < 3) return null;
    return median(xs);
  }

  /** Build this phone's evidence report for an incident at t0 (ms). */
  report(incidentId: string, t0: number, now: number): EvidenceReport {
    const inWin = <T extends { t: number }>(xs: T[], w: readonly [number, number]) => xs.filter((x) => x.t >= t0 + w[0] && x.t <= t0 + w[1]);
    const all = inWin(this.samples, [WINDOW.before[0], WINDOW.after[1]]);
    const before = inWin(this.samples, WINDOW.before);
    const around = inWin(this.samples, WINDOW.around);
    const after = inWin(this.samples, WINDOW.after);
    const sonarAll = all.filter((s) => s.sonarOk);
    const medianLinkDb = median(sonarAll.map((s) => s.linkSnrDb));
    const online = sonarAll.length >= Math.max(8, 0.6 * all.length) && medianLinkDb >= 10;

    const present = (s: StreamSample) =>
      (s.presence === 'moving' || s.presence === 'still') && (s.confirmed || s.breathing !== null || s.motionDb >= 14);
    const sawPersonBefore = online && before.length > 3 && before.filter(present).length / before.length >= 0.4;
    const lastRange = (xs: StreamSample[]) => {
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i].range !== null && xs[i].confirmed) return xs[i].range;
      return null;
    };
    const burstDb = around.filter((s) => s.sonarOk).reduce((m, s) => Math.max(m, s.fastMotionDb), 0);
    const afterOk = after.filter((s) => s.sonarOk);
    const stillAfter = afterOk.length ? afterOk.filter((s) => s.fastMotionDb < MOVING_DB).length / afterOk.length : 0;
    const motionResumed = afterOk.length > 5 && afterOk.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length / afterOk.length >= 0.25;
    const presentAfter = afterOk.length > 5 && afterOk.filter(present).length / afterOk.length >= 0.5;
    const firstMove = afterOk.find((s) => s.t >= t0 + 2500 && s.fastMotionDb >= 13.5 && present(s));
    let breathingAfter: number | null = null;
    for (const s of afterOk) if (s.breathing) breathingAfter = s.breathing.rateBpm;
    const roomChangeDb = around.concat(after).reduce((m, s) => Math.max(m, s.staticChangeDb), 0);

    const snd = inWin(this.sounds, WINDOW.sound);
    const impacts = snd.filter((e) => (e.cls === 'impact' || e.cls === 'knock') && e.confidence >= 0.45);
    const aiImpact = impacts.filter((e) => e.ai).sort((a, b) => b.aboveFloorDb - a.aboveFloorDb)[0]?.ai ?? null;
    const distress = inWin(this.sounds, [-3000, 9000]).some(isDistressSound);
    const mediaSamples = inWin(this.samples, [-12000, 0]).filter((x) => x.media !== undefined);
    const media = mediaSamples.length ? mediaSamples.reduce((a, x) => a + (x.media ?? 0), 0) / mediaSamples.length : null;
    const seenBefore = this.samples.filter((x) => x.t <= t0 && x.t >= t0 - 40000 && x.sonarOk && (x.presence === 'moving' || x.presence === 'still') && (x.confirmed || x.motionDb >= 14));
    const loudest = impacts.reduce<SoundObs | null>((m, e) => (!m || e.aboveFloorDb > m.aboveFloorDb ? e : m), null);
    const screams = inWin(this.sounds, [-3000, 7500]).filter((e) => e.cls === 'scream' && screamConfirmed(e));
    const mediaEv = inWin(this.sounds, WINDOW.media).filter((e) => e.cls === 'voice' || e.cls === 'sustained' || e.repetitive);
    const voiceAfter = inWin(this.sounds, WINDOW.after).some((e) => e.cls === 'voice');

    const imu = inWin(this.imu, [-3000, 3000]);
    const alerts = inWin(this.alerts, [-1000, GATHER_MS + 2000]).filter((a) => a.kind === 'fall');
    const localVerdict = alerts.some((a) => a.severity === 'critical') ? 'fall' : alerts.length ? 'possible_fall' : 'none';
    const lastBefore = this.samples.filter((s) => s.t <= t0).pop();

    return {
      id: uid('report'),
      incidentId,
      nodeId: this.nodeId,
      name: this.name,
      postedAt: now,
      samples: all.length,
      silenceMs: lastBefore ? t0 - lastBefore.t : 1e9,
      sound: {
        impactDb: loudest ? loudest.aboveFloorDb : null,
        impactRepetitive: loudest ? loudest.repetitive : false,
        screamDb: screams.length ? Math.max(...screams.map((e) => e.aboveFloorDb)) : null,
        mediaEventsBefore: mediaEv.length,
        voiceAfter,
        impactAi: aiImpact ? { group: aiImpact.group, score: aiImpact.score, label: aiImpact.top?.[0]?.name ?? aiImpact.group } : null,
        media,
        distress,
      },
      sonar: {
        online,
        medianLinkDb,
        sawPersonBefore,
        rangeBefore: online ? lastRange(before) : null,
        rangeAfter: online ? lastRange(after) : null,
        burstDb: online ? burstDb : 0,
        stillAfter: online ? stillAfter : 0,
        motionResumed: online && motionResumed,
        presentAfter: online && presentAfter,
        lastSeenAgo: online && seenBefore.length ? (t0 - seenBefore[seenBefore.length - 1].t) / 1000 : null,
        firstMoveAfter: online && firstMove ? (firstMove.t - t0) / 1000 : null,
        breathingAfter: online ? breathingAfter : null,
        roomChangeDb,
      },
      imu: { moved: imu.some((e) => e.type === 'moved'), dropped: imu.some((e) => e.type === 'drop') },
      localVerdict,
    };
  }
}
