import { SoundEvent } from '../audio/passive';
import { GROUP_WORDS, groupsBetween, impactLabel, isDistress, type AiFrame, type SoundGroup } from '../audio/soundLabels';
import { SonarFrame } from '../dsp/sonar';
import { ImuEvent, ImuState } from '../motion/imu';

export type Severity = 'info' | 'notice' | 'warning' | 'critical';

export type AlertKind =
  | 'presence'
  | 'left'
  | 'approach'
  | 'breathing'
  | 'impact'
  | 'scream'
  | 'glass'
  | 'fall'
  | 'sudden_drop'
  | 'escalation'
  | 'resolved'
  | 'phone_moved'
  | 'phone_drop'
  | 'sensor'
  | 'agent_check'
  | 'sound';

export interface FusionAlert {
  id: string;
  t: number;
  kind: AlertKind;
  severity: Severity;
  title: string;
  detail: string;
  confidence: number;
  evidence: string[];
}

export type Presence = 'unknown' | 'empty' | 'moving' | 'still';

export interface CheckIn {
  id: string;
  alertId: string;
  startedAt: number;
  deadline: number;
  reason: string;
  state: 'pending' | 'ok' | 'help' | 'escalated';
  /** The home's agents think it was a fall: only "I'm OK" (said or tapped) cancels, moving does not. */
  urgent?: boolean;
}

export interface FusionState {
  t: number;
  mode: 'room' | 'body';
  presence: Presence;
  presenceConfidence: number;
  /** Seconds in the current presence state. */
  presenceFor: number;
  target: { range: number; velocity: number; snrDb: number } | null;
  breathing: { rateBpm: number; quality: number; range: number } | null;
  /** 0..1 recent activity level. */
  activity: number;
  inZone: boolean;
  status: 'calibrating' | 'ok' | 'attention' | 'alert' | 'degraded';
  headline: string;
  subline: string;
  sonarHealth: 'ok' | 'weak' | 'lost' | 'paused';
  checkIn: CheckIn | null;
}

export interface FusionConfig {
  mode: 'room' | 'body';
  /** Personal-space radius for approach alerts, metres. */
  zoneRadius: number;
  /** Seconds of stillness after an incident before deciding it was a fall. */
  stillWindow: number;
  /** Seconds to wait for a check-in response before escalating. */
  checkInTimeout: number;
  /** Fast-motion level counted as a body-motion burst, dB. */
  burstDb: number;
  /** Link SNR below which the sonar is considered weak, dB. */
  weakLinkDb: number;
  /**
   * The hub understands spoken answers (speech to text plus meaning). Then
   * talking is sent there instead of counting as "I'm OK" here: "No, I'm hurt"
   * is speech too.
   */
  speechToHub?: boolean;
}

export const DEFAULT_FUSION: FusionConfig = {
  mode: 'room',
  zoneRadius: 1.2,
  stillWindow: 4.5,
  checkInTimeout: 30,
  burstDb: 20,
  weakLinkDb: 14,
};

interface Hist {
  t: number;
  fast: number;
  gross: boolean;
  motion: number;
  range: number; // -1 if none
  vel: number;
  present: boolean;
}

interface Incident {
  t0: number;
  cause: 'impact' | 'burst' | 'imu';
  sound: SoundEvent | null;
  decideAt: number;
}

let counter = 0;
function uid(prefix: string): string {
  counter = (counter + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}-${counter}`;
}

/**
 * Multimodal event fusion: turns per-frame sonar measurements, classified
 * sounds and inertial events into presence state, explainable alerts and a
 * check-in / escalation workflow.
 *
 * Every alert carries its evidence (what each modality saw, with numbers), and
 * no single modality can raise a fall on its own in room mode: a loud thud
 * without a body-motion burst and subsequent stillness, or a fast movement
 * without an impact, are reported at lower severity without a check-in.
 */
export class FusionEngine {
  cfg: FusionConfig;
  private hist: Hist[] = [];
  private sounds: SoundEvent[] = [];
  private incidents: Incident[] = [];
  private lastIncidentT = -100;
  private lastFallT = -100;
  /** Last time anyone was seen by the sonar (a loud impact matters if someone was around recently). */
  private lastSeenT = -1000;
  private presence: Presence = 'unknown';
  private presenceSince = 0;
  private lastMotionT = -100;
  private lastBreathAlertT = -100;
  private lastApproachT = -100;
  private prevRange = -1;
  private approachStart: { t: number; range: number } | null = null;
  private activity = 0;
  private checkIn: CheckIn | null = null;
  private latest: SonarFrame | null = null;
  private sonarPaused = false;
  private calibrating = true;
  private lastSensorAlertT = -100;
  private alerts: FusionAlert[] = [];
  private stillPresenceEvidenceT = -100;
  /** Sound recognition frames (YAMNet), newest last. */
  private ai: AiFrame[] = [];
  aiReady = false;
  private pendingSounds: SoundEvent[] = [];
  private aiMutedUntil = -1;
  private prompts: number[] = [];

  constructor(cfg: Partial<FusionConfig> = {}, private readonly emit: (a: FusionAlert) => void = () => {}) {
    this.cfg = { ...DEFAULT_FUSION, ...cfg };
  }

  get recentAlerts(): FusionAlert[] {
    return this.alerts;
  }

  private raise(a: Omit<FusionAlert, 'id'>): FusionAlert {
    const full = { ...a, id: uid(a.kind) };
    this.alerts.push(full);
    if (this.alerts.length > 200) this.alerts.shift();
    this.emit(full);
    return full;
  }

  setCalibrating(v: boolean): void {
    this.calibrating = v;
  }

  setSonarPaused(v: boolean): void {
    this.sonarPaused = v;
    if (v) {
      this.hist = [];
      this.prevRange = -1;
      this.approachStart = null;
    }
  }

  onSonar(f: SonarFrame): void {
    this.latest = f;
    if (f.phase !== 'running') return;
    this.calibrating = false;
    const t = f.t;
    // Presence needs credible evidence: a confirmed, reasonably strong track,
    // strong clutter-removed motion, or a valid breathing signal.
    const present =
      (f.primary !== null && f.primary.confirmed && f.primary.snrDb >= 15) || f.motionDb >= 16 || f.breathing.valid;
    this.hist.push({
      t,
      fast: f.fastMotionDb,
      gross: f.grossMotion,
      motion: f.motionDb,
      range: f.primary ? f.primary.range : -1,
      vel: f.primary ? f.primary.velocity : 0,
      present,
    });
    while (this.hist.length && t - this.hist[0].t > 15) this.hist.shift();
    // "Motion" means body movement (Doppler high-passed), not the slow chest
    // movement of breathing, which also shows up in the 1 s clutter residual.
    if (f.grossMotion && f.motionDb >= 14) this.lastMotionT = t;
    if (present) this.lastSeenT = t;
    const actTarget = f.grossMotion ? Math.min(1, (f.fastMotionDb - 6) / 25) : 0;
    this.activity += 0.05 * (actTarget - this.activity);

    if (this.cfg.mode === 'room' && !this.sonarPaused) {
      this.updatePresence(f);
      this.detectApproach(f);
      this.detectBurst(f);
    }
    this.evaluateIncidents(t);
    this.listenForAnswer(t);
    this.updateCheckIn(t);
    this.checkHealth(f);
    this.flushStale(t);
  }

  private updatePresence(f: SonarFrame): void {
    const t = f.t;
    let next: Presence;
    let conf: number;
    const recentMotion = t - this.lastMotionT;
    const credibleTrack = f.primary !== null && f.primary.confirmed && f.primary.snrDb >= 15;
    if ((f.grossMotion && f.motionDb >= 14) || (credibleTrack && recentMotion < 1.5)) {
      next = 'moving';
      conf = Math.min(1, 0.5 + f.motionDb / 40);
    } else if (f.breathing.valid) {
      next = 'still';
      conf = Math.min(1, f.breathing.quality);
      this.stillPresenceEvidenceT = t;
    } else if (recentMotion < 8 || credibleTrack) {
      next = this.presence === 'empty' || this.presence === 'unknown' ? 'moving' : 'still';
      conf = 0.6;
    } else if (recentMotion < 40 && (f.staticChangeDb > 15 || t - this.stillPresenceEvidenceT < 20)) {
      next = 'still';
      conf = 0.4;
    } else {
      next = 'empty';
      conf = 0.7;
    }
    if (next !== this.presence) {
      const prev = this.presence;
      this.presence = next;
      this.presenceSince = t;
      if ((prev === 'empty' || prev === 'unknown') && next !== 'empty' && prev !== 'unknown') {
        const r = f.primary ? `${f.primary.range.toFixed(1)} m` : 'in range';
        this.raise({
          t,
          kind: 'presence',
          severity: 'info',
          title: 'Someone entered',
          detail: `Movement detected ${r} from the phone`,
          confidence: conf,
          evidence: [`sonar echo ${f.motionDb.toFixed(0)} dB over the room baseline`],
        });
      }
      if (next === 'empty' && (prev === 'moving' || prev === 'still')) {
        this.raise({
          t,
          kind: 'left',
          severity: 'info',
          title: 'Room clear',
          detail: 'No motion or breathing detected for a while',
          confidence: conf,
          evidence: [`no sonar motion for ${(t - this.lastMotionT).toFixed(0)} s`],
        });
      }
    }
    if (f.breathing.valid && t - this.lastBreathAlertT > 120 && f.breathing.quality > 0.6) {
      this.lastBreathAlertT = t;
      this.raise({
        t,
        kind: 'breathing',
        severity: 'info',
        title: `Breathing detected: ${f.breathing.rateBpm.toFixed(0)}/min`,
        detail: `Contactless respiration at ${f.breathing.range.toFixed(1)} m`,
        confidence: f.breathing.quality,
        evidence: [
          `periodicity ${(f.breathing.quality * 100).toFixed(0)}%`,
          `chest-motion band ${f.breathing.prominenceDb.toFixed(0)} dB above the room`,
          `${f.breathing.stillSeconds.toFixed(0)} s of stillness analysed`,
        ],
      });
    }
    this.latestPresenceConf = conf;
  }

  private latestPresenceConf = 0;

  private detectApproach(f: SonarFrame): void {
    const t = f.t;
    const p = f.primary;
    if (!p || !p.confirmed) {
      this.approachStart = null;
      this.prevRange = -1;
      return;
    }
    if (p.velocity < -0.25) {
      if (!this.approachStart) this.approachStart = { t, range: p.range };
    } else if (p.velocity > -0.05) this.approachStart = null;
    const r = this.cfg.zoneRadius;
    if (
      this.approachStart &&
      this.prevRange > r &&
      p.range <= r &&
      this.approachStart.range - p.range > 0.4 &&
      t - this.lastApproachT > 8
    ) {
      this.lastApproachT = t;
      const dt = t - this.approachStart.t;
      this.raise({
        t,
        kind: 'approach',
        severity: 'notice',
        title: 'Someone is approaching',
        detail: `${this.approachStart.range.toFixed(1)} m to ${p.range.toFixed(1)} m in ${dt.toFixed(1)} s`,
        confidence: Math.min(0.95, 0.5 + p.snrDb / 60),
        evidence: [
          `range rate ${p.velocity.toFixed(2)} m/s`,
          `entered the ${r.toFixed(1)} m zone`,
          `echo ${p.snrDb.toFixed(0)} dB`,
        ],
      });
    }
    this.prevRange = p.range;
  }

  private detectBurst(f: SonarFrame): void {
    if (f.fastMotionDb >= this.cfg.burstDb) this.openIncident(f.t, 'burst', null);
  }

  /** A sound recognition result arrived (one per half second while running). */
  onAi(f: AiFrame): void {
    this.aiReady = true;
    if (f.t - 1.0 < this.aiMutedUntil) return; // the phone itself was talking
    this.ai.push(f);
    while (this.ai.length && f.t - this.ai[0].t > 40) this.ai.shift();
    this.flushSounds(f.t);
    this.listenForAnswer(f.t);
  }

  /** The phone is about to speak: ignore what it hears of itself. */
  muteUntil(t: number): void {
    this.aiMutedUntil = Math.max(this.aiMutedUntil, t);
  }

  private aiAround(t0: number, t1: number): Record<SoundGroup, number> | null {
    return groupsBetween(this.ai, t0, t1);
  }

  /** Recent share of TV, music or film sound, 0..1. */
  mediaLevel(t: number, span = 12): number {
    const fr = this.ai.filter((f) => f.t > t - span && f.t <= t);
    if (!fr.length) return 0;
    return fr.filter((f) => f.groups.media >= 0.3).length / fr.length;
  }

  private flushSounds(t: number): void {
    const keep: SoundEvent[] = [];
    for (const ev of this.pendingSounds) {
      // Wait until the model has heard a full window past the event (or give up after 2.5 s).
      if (t < ev.t + 0.7 && t < ev.t + 2.5) keep.push(ev);
      else this.handleSound(ev);
    }
    this.pendingSounds = keep;
  }

  /** If the model stalls, do not hold sounds back for more than 2.5 s. */
  private flushStale(t: number): void {
    if (!this.pendingSounds.length) return;
    const stale = this.pendingSounds.filter((ev) => t >= ev.t + 2.5);
    if (!stale.length) return;
    this.pendingSounds = this.pendingSounds.filter((ev) => t < ev.t + 2.5);
    for (const ev of stale) this.handleSound(ev);
  }

  onSound(ev: SoundEvent): void {
    this.sounds.push(ev);
    while (this.sounds.length && ev.t - this.sounds[0].t > 20) this.sounds.shift();
    const notable = (ev.cls === 'impact' && !ev.repetitive && ev.confidence >= 0.55) || ev.cls === 'scream' || ev.cls === 'glass';
    if (notable && this.aiReady) {
      this.pendingSounds.push(ev);
      return;
    }
    this.handleSound(ev);
  }

  private handleSound(ev: SoundEvent): void {
    const g = this.aiReady ? this.aiAround(ev.t - 0.2, ev.t + 0.4) : null;
    if (g) {
      const lab = impactLabel(g);
      const top = this.ai.filter((f) => f.t >= ev.t - 0.2 && f.t - 0.975 <= ev.t + 0.4).flatMap((f) => f.top);
      top.sort((a, b) => b.score - a.score);
      ev.ai = { group: lab.group, score: lab.score, words: GROUP_WORDS[lab.group], top: top.slice(0, 3) };
      const harmless: SoundGroup[] = ['tap', 'speech', 'media', 'footsteps'];
      if (ev.cls === 'impact' && ev.aboveFloorDb < 30 && ((harmless.includes(lab.group) && lab.score >= (lab.group === 'speech' || lab.group === 'media' ? 0.2 : 0.35)) || (lab.group === 'object' && lab.score >= 0.35 && g.thud < 0.15)) && g.distress < 0.3) {
        ev.benign = true;
        this.raise({
          t: ev.t,
          kind: 'sound',
          severity: 'info',
          title: `Sound: ${GROUP_WORDS[lab.group]}`,
          detail: `${top[0]?.name ?? lab.group} (${Math.round((top[0]?.score ?? lab.score) * 100)}%), not treated as a fall`,
          confidence: lab.score,
          evidence: [ev.evidence, `sound model: ${top.map((x) => `${x.name} ${Math.round(x.score * 100)}%`).join(', ')}`],
        });
        return;
      }
    }
    if (ev.cls === 'impact' && !ev.repetitive && ev.confidence >= 0.55) {
      this.raise({
        t: ev.t,
        kind: 'impact',
        severity: 'notice',
        title: ev.ai ? `Loud impact: ${ev.ai.words}` : 'Loud impact heard',
        detail: ev.evidence,
        confidence: ev.confidence,
        evidence: ev.ai ? [ev.evidence, `sound model: ${ev.ai.top.map((x) => `${x.name} ${Math.round(x.score * 100)}%`).join(', ')}`] : [ev.evidence],
      });
      this.openIncident(ev.t, 'impact', ev);
    } else if (ev.cls === 'scream' && ev.confidence >= 0.6 && (g ? isDistress(g) : ev.confidence >= 0.8)) {
      // The loudness detector alone mistakes animated talking for a scream: the sound model has to agree.
      this.raise({
        t: ev.t,
        kind: 'scream',
        severity: 'warning',
        title: 'Scream detected',
        detail: ev.evidence,
        confidence: ev.confidence,
        evidence: [ev.evidence],
      });
    } else if (ev.cls === 'glass' && ev.confidence >= 0.7) {
      this.raise({
        t: ev.t,
        kind: 'glass',
        severity: 'notice',
        title: 'Glass break or metallic crash',
        detail: ev.evidence,
        confidence: ev.confidence,
        evidence: [ev.evidence],
      });
    }
  }

  onImu(ev: ImuEvent, imu: ImuState): void {
    if (ev.type === 'moved' && this.cfg.mode === 'room') {
      this.raise({
        t: ev.t,
        kind: 'phone_moved',
        severity: 'notice',
        title: 'Phone moved: recalibrating',
        detail: ev.detail,
        confidence: ev.confidence,
        evidence: [ev.detail, `${imu.accelG.toFixed(2)} g, ${imu.gyroDps.toFixed(0)} deg/s`],
      });
    } else if (ev.type === 'drop') {
      this.raise({
        t: ev.t,
        kind: 'phone_drop',
        severity: 'warning',
        title: 'Phone dropped',
        detail: ev.detail,
        confidence: ev.confidence,
        evidence: [ev.detail],
      });
    } else if (ev.type === 'body_fall' && this.cfg.mode === 'body') {
      const alert = this.raise({
        t: ev.t,
        kind: 'fall',
        severity: 'critical',
        title: 'Possible fall (wearer)',
        detail: ev.detail,
        confidence: ev.confidence,
        evidence: [ev.detail],
      });
      this.startCheckIn(ev.t, alert, 'The phone registered an impact and a change of orientation.');
    }
  }

  private openIncident(t: number, cause: Incident['cause'], sound: SoundEvent | null): void {
    // An impact re-anchors any pending burst within 3 s: the sound is the sharper timestamp.
    const open = this.incidents.find((i) => Math.abs(i.t0 - t) <= 3);
    if (open) {
      if (sound && !open.sound) {
        open.sound = sound;
        open.t0 = t;
        open.cause = 'impact';
        open.decideAt = t + 1.5 + this.cfg.stillWindow;
      }
      return;
    }
    if (cause === 'burst' && t - this.lastIncidentT < 3) return;
    this.lastIncidentT = t;
    this.incidents.push({ t0: t, cause, sound, decideAt: t + 1.5 + this.cfg.stillWindow });
  }

  private evaluateIncidents(t: number): void {
    const keep: Incident[] = [];
    for (const inc of this.incidents) {
      if (t < inc.decideAt) {
        keep.push(inc);
        continue;
      }
      this.decide(inc, t);
    }
    this.incidents = keep;
  }

  private decide(inc: Incident, t: number): void {
    const t0 = inc.t0;
    const around = this.hist.filter((h) => h.t >= t0 - 2 && h.t <= t0 + 1.5);
    const after = this.hist.filter((h) => h.t > t0 + 1.5 && h.t <= t0 + 1.5 + this.cfg.stillWindow);
    const sonarOk = around.length > 10 && !this.sonarPaused;
    const burst = around.reduce((m, h) => Math.max(m, h.fast), 0);
    const hasBurst = sonarOk && burst >= this.cfg.burstDb;
    const sound =
      inc.sound ??
      this.sounds.find((s) => s.cls === 'impact' && !s.repetitive && !s.benign && Math.abs(s.t - t0) <= 2 && s.confidence >= 0.55) ??
      null;
    const presentBefore = around.filter((h) => h.t < t0 - 0.2 && h.present).length > 5;
    const stillFrac = after.length ? after.filter((h) => !h.gross).length / after.length : 0;
    const still = sonarOk && after.length > 10 && stillFrac >= 0.85;
    const presentAfter = after.length ? after.filter((h) => h.present).length / after.length : 0;
    // Where did the target end up, and did the range jump (body moved to the floor)?
    const before = around.filter((h) => h.range > 0 && h.t < t0 - 0.3);
    const late = after.filter((h) => h.range > 0);
    const r0 = before.length ? before[before.length - 1].range : -1;
    const r1 = late.length ? late[late.length - 1].range : -1;

    const evidence: string[] = [];
    if (sonarOk) evidence.push(`sonar: ${hasBurst ? 'sudden whole-body motion' : 'no strong motion burst'} (${burst.toFixed(0)} dB)`);
    else evidence.push('sonar: unavailable');
    if (sound) evidence.push(`audio: impact, ${sound.evidence}${sound.ai ? `; sound model: ${sound.ai.words} (${Math.round(sound.ai.score * 100)}%)` : ''}`);
    else evidence.push('audio: no impact sound');
    if (sonarOk) evidence.push(`then ${(stillFrac * 100).toFixed(0)}% still for ${this.cfg.stillWindow.toFixed(1)} s`);
    if (r0 > 0 && r1 > 0) evidence.push(`target ${r0.toFixed(1)} m to ${r1.toFixed(1)} m`);
    if (presentAfter > 0.3) evidence.push('person still detected afterwards');

    if (t - this.lastFallT < 30) return;
    if (hasBurst && sound && still) {
      this.lastFallT = t;
      const conf = Math.min(0.97, 0.6 + 0.15 * sound.confidence + 0.006 * (burst - this.cfg.burstDb) + 0.1 * presentAfter);
      const a = this.raise({
        t,
        kind: 'fall',
        severity: 'critical',
        title: 'Possible fall',
        detail: 'Sudden movement and an impact, followed by stillness',
        confidence: conf,
        evidence,
      });
      this.startCheckIn(t, a, 'EchoSense sensed a sudden movement and an impact, then no movement.');
    } else if (
      sound &&
      still &&
      sound.confidence >= 0.7 &&
      !(sonarOk && presentBefore) &&
      t0 - this.lastSeenT < 90 &&
      // A bang alone is weak evidence: it has to sound like a body hitting the floor.
      (sound.ai ? sound.ai.group === 'thud' || sound.ai.group === 'distress' : sound.confidence >= 0.85 && sound.aboveFloorDb >= 28)
    ) {
      // Only when the sonar could not see anyone beforehand: if it was watching
      // a person and saw no burst, the impact was something else (a dropped object).
      this.lastFallT = t;
      const strong = !!sound.ai && sound.ai.score >= 0.45;
      const a = this.raise({
        t,
        kind: 'fall',
        severity: 'warning',
        title: 'Loud thud, then no movement',
        detail: 'Possible fall outside the sonar view',
        confidence: Math.min(0.75, 0.4 + 0.3 * sound.confidence),
        evidence,
      });
      // Only a convincing thud asks the person directly; otherwise the home's agents decide.
      if (strong) this.startCheckIn(t, a, 'EchoSense heard a heavy thud and has not seen movement since.');
    } else if (hasBurst && still && presentAfter > 0.5 && inc.cause === 'burst' && r0 > 0 && r1 > 0 && Math.abs(r1 - r0) > 0.35) {
      this.raise({
        t,
        kind: 'sudden_drop',
        severity: 'info',
        title: 'Sudden movement, then stillness',
        detail: 'No impact sound: probably sitting or lying down quickly',
        confidence: 0.35,
        evidence,
      });
    }
  }

  /** The phone spoke the check-in question at time t (seconds). */
  prompted(t: number): void {
    this.prompts.push(t);
  }

  /**
   * Hands free answers: after the spoken question, someone talking, or moving
   * on the sonar, counts as "I'm OK"; a scream, groan or crying counts as help.
   * Nobody has to find the phone or read the screen.
   */
  private listenForAnswer(t: number): void {
    const c = this.checkIn;
    if (!c || c.state !== 'pending') return;
    const from = Math.max(c.startedAt + 3, (this.prompts[this.prompts.length - 1] ?? c.startedAt) + 3.5);
    if (t < from) return;
    const recentAi = this.ai.filter((f) => f.t - 0.975 >= from - 0.5);
    const distress = recentAi.find((f) => isDistress(f.groups));
    // Offline only: with the hub connected, the answer (words or crying) is judged there with the other phones.
    if (distress && !this.cfg.speechToHub) {
      this.autoAnswer('help', `called out in distress (${distress.top[0]?.name ?? 'distress'})`, t);
      return;
    }
    // With the hub listening for the words, speech is not an answer by itself here.
    if (!this.cfg.speechToHub && !c.urgent) {
      const media = this.mediaLevel(t, 15) > 0.4;
      const spoke = recentAi.find((f) => f.groups.speech >= 0.6 && f.groups.media < 0.3);
      const voiceEv = this.sounds.find((s) => s.t >= from && s.cls === 'voice');
      if (!media && (spoke || (voiceEv && !this.aiReady))) {
        this.autoAnswer('ok', 'answered out loud', t);
        return;
      }
    }
    // Moving about answers a gentle question, but someone hurt on the floor moves too.
    if (c.urgent) return;
    const moved = this.hist.filter((h) => h.t >= from && h.gross && h.fast >= 14 && h.motion >= 14);
    if (moved.length >= 12) this.autoAnswer('ok', 'moved after the question', t);
  }

  private autoAnswer(answer: 'ok' | 'help', why: string, t: number): void {
    const c = this.checkIn;
    if (!c || c.state !== 'pending') return;
    c.state = answer;
    this.raise({
      t,
      kind: answer === 'ok' ? 'resolved' : 'escalation',
      severity: answer === 'ok' ? 'info' : 'critical',
      title: answer === 'ok' ? `Check-in answered: OK (${why})` : 'Help requested',
      detail: answer === 'ok' ? `They ${why} ${(t - c.startedAt).toFixed(0)} s after the question` : `They ${why}`,
      confidence: answer === 'ok' ? 0.85 : 0.9,
      evidence: [why],
    });
  }

  private startCheckIn(t: number, alert: FusionAlert, reason: string): void {
    if (this.checkIn && this.checkIn.state === 'pending') return;
    this.prompts = [];
    this.checkIn = {
      id: uid('checkin'),
      alertId: alert.id,
      startedAt: t,
      deadline: t + this.cfg.checkInTimeout,
      reason,
      state: 'pending',
    };
  }

  /** The home's agents disagree and want to hear from the person directly. */
  requestCheckIn(t: number, reason: string, urgent = false, seconds?: number): void {
    const c = this.checkIn;
    if (c && c.state === 'pending') {
      // Already asking: an urgent request upgrades it (new words, the hub's countdown).
      // The hub's question replaces the phone's own shorter timer.
      if (seconds) c.deadline = Math.max(c.deadline, t + seconds + 5);
      if (urgent && !c.urgent) {
        c.urgent = true;
        c.reason = reason;
        c.startedAt = t;
        c.deadline = t + (seconds ?? this.cfg.checkInTimeout) + 5;
        this.prompts = [];
      }
      return;
    }
    const a = this.raise({
      t,
      kind: 'agent_check',
      severity: 'warning',
      title: 'Checking in',
      detail: reason,
      confidence: 0.5,
      evidence: ['the home sensors disagree about what happened'],
    });
    this.startCheckIn(t, a, reason);
    if (this.checkIn && (urgent || seconds)) {
      this.checkIn.urgent = urgent;
      // The hub decides when its own timer ends; this one is only the backstop if the hub is gone.
      this.checkIn.deadline = t + (seconds ?? this.cfg.checkInTimeout) + 5;
    }
  }

  /** The person (or a caregiver) answered the check-in. */
  respond(answer: 'ok' | 'help', t: number): void {
    const c = this.checkIn;
    // An answer after escalation still counts: it tells contacts the person is fine.
    if (!c || (c.state !== 'pending' && c.state !== 'escalated')) return;
    c.state = answer;
    if (answer === 'ok') {
      this.raise({
        t,
        kind: 'resolved',
        severity: 'info',
        title: 'Check-in answered: OK',
        detail: `Responded after ${(t - c.startedAt).toFixed(0)} s`,
        confidence: 1,
        evidence: ['tapped "I\'m OK"'],
      });
    } else {
      this.raise({
        t,
        kind: 'escalation',
        severity: 'critical',
        title: 'Help requested',
        detail: 'The person asked for help from the check-in',
        confidence: 1,
        evidence: ['tapped "Get help"'],
      });
    }
  }

  private updateCheckIn(t: number): void {
    const c = this.checkIn;
    if (!c || c.state !== 'pending') return;
    if (t >= c.deadline) {
      c.state = 'escalated';
      this.raise({
        t,
        kind: 'escalation',
        severity: 'critical',
        title: 'No response: alerting contacts',
        detail: `No answer to the check-in within ${this.cfg.checkInTimeout.toFixed(0)} s`,
        confidence: 0.9,
        evidence: [c.reason, 'no response to the on-screen and spoken check-in'],
      });
    }
  }

  /** Advance timers when no sonar frames arrive (body mode, paused sonar). */
  tick(t: number): void {
    this.flushStale(t);
    this.evaluateIncidents(t);
    this.updateCheckIn(t);
  }

  private checkHealth(f: SonarFrame): void {
    if (f.linkSnrDb > 0 && f.linkSnrDb < this.cfg.weakLinkDb && f.t - this.lastSensorAlertT > 60) {
      this.lastSensorAlertT = f.t;
      this.raise({
        t: f.t,
        kind: 'sensor',
        severity: 'notice',
        title: 'Weak sonar signal',
        detail: 'Turn the volume up, take the phone out of its case, or move it away from soft furnishings',
        confidence: 0.8,
        evidence: [`speaker-to-mic link ${f.linkSnrDb.toFixed(0)} dB`],
      });
    }
  }

  dismissCheckIn(): void {
    this.checkIn = null;
  }

  snapshot(t: number): FusionState {
    const f = this.latest;
    const breathing = f && f.breathing.valid ? { rateBpm: f.breathing.rateBpm, quality: f.breathing.quality, range: f.breathing.range } : null;
    const target = f && f.primary ? { range: f.primary.range, velocity: f.primary.velocity, snrDb: f.primary.snrDb } : null;
    let sonarHealth: FusionState['sonarHealth'] = 'ok';
    if (this.sonarPaused) sonarHealth = 'paused';
    else if (!f || !f.locked) sonarHealth = 'lost';
    else if (f.linkSnrDb < this.cfg.weakLinkDb) sonarHealth = 'weak';
    const inZone = !!target && target.range <= this.cfg.zoneRadius;
    const pending = this.checkIn && this.checkIn.state === 'pending' ? this.checkIn : null;
    const resolved = this.checkIn?.state === 'ok';
    const recentCritical = !resolved && this.alerts.some((a) => a.severity === 'critical' && t - a.t < 60);
    const recentWarn = this.alerts.some((a) => (a.severity === 'warning' || a.severity === 'notice') && t - a.t < 10);

    let status: FusionState['status'] = 'ok';
    if (this.calibrating || (f && f.phase !== 'running')) status = 'calibrating';
    else if (pending || (this.checkIn && this.checkIn.state === 'escalated') || recentCritical) status = 'alert';
    else if (sonarHealth !== 'ok' && this.cfg.mode === 'room') status = 'degraded';
    else if (recentWarn) status = 'attention';

    let headline = 'Room clear';
    let subline = 'Listening for motion, breathing and sound';
    if (this.cfg.mode === 'body') {
      headline = 'Wearer mode';
      subline = 'Carry the phone: falls are detected from motion';
    } else if (status === 'calibrating') {
      headline = 'Calibrating';
      subline = f && f.phase === 'acquiring' ? 'Finding the speaker-to-mic path' : 'Learning the room. Keep still for a moment';
    } else if (sonarHealth === 'paused') {
      headline = 'Phone moving';
      subline = 'Set the phone down: sensing resumes automatically';
    } else if (this.presence === 'moving') {
      headline = target ? `Someone ${target.range.toFixed(1)} m away` : 'Movement nearby';
      subline =
        target && target.velocity < -0.2
          ? `Approaching at ${Math.abs(target.velocity).toFixed(1)} m/s`
          : target && target.velocity > 0.2
            ? `Moving away at ${target.velocity.toFixed(1)} m/s`
            : 'Moving';
    } else if (this.presence === 'still') {
      headline = breathing ? `Breathing ${breathing.rateBpm.toFixed(0)}/min` : 'Someone is here, still';
      subline = breathing ? `Still, ${breathing.range.toFixed(1)} m away` : 'No movement for a few seconds';
    }
    if (pending) {
      headline = 'Checking in';
      subline = pending.reason;
    } else if (this.checkIn?.state === 'escalated') {
      headline = 'Contacts alerted';
      subline = 'No response to the check-in';
    }
    return {
      t,
      mode: this.cfg.mode,
      presence: this.presence,
      presenceConfidence: this.latestPresenceConf,
      presenceFor: t - this.presenceSince,
      target,
      breathing,
      activity: this.activity,
      inZone,
      status,
      headline,
      subline,
      sonarHealth,
      checkIn: this.checkIn,
    };
  }
}
