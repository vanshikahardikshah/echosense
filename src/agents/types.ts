/**
 * Witness: the agent layer on top of EchoSense.
 *
 * Every phone is an agent that turns its own sensor stream into an evidence
 * report. Three role agents with competing goals argue over those reports on a
 * shared board. Nobody owns the decision: the outcome is a fixed public rule
 * over the posted positions, so every participant (and the console) can check
 * it.
 */

/** One telemetry sample as the hub receives it from a phone (times in ms). */
export interface StreamSample {
  t: number;
  presence: string;
  range: number | null;
  confirmed: boolean;
  snrDb: number;
  fastMotionDb: number;
  motionDb: number;
  staticChangeDb: number;
  linkSnrDb: number;
  breathing: { rateBpm: number; quality: number; range: number } | null;
  /** False when the phone could not run its sonar (paused, calibrating, lost). */
  sonarOk: boolean;
  /** Share of the last seconds that sounded like TV or music (sound model), 0..1. */
  media?: number;
}

export interface SoundObs {
  t: number;
  cls: 'impact' | 'glass' | 'scream' | 'voice' | 'knock' | 'sustained' | 'other';
  confidence: number;
  aboveFloorDb: number;
  repetitive: boolean;
  /** Sound recognition (YAMNet) label group and score, when the phone runs the model. */
  ai?: { group: string; score: number; words?: string; top?: { name: string; score: number }[] };
  benign?: boolean;
  lateMs?: number;
}

export interface AlertObs {
  t: number;
  kind: string;
  severity: 'info' | 'notice' | 'warning' | 'critical';
  title: string;
}

export interface ImuObs {
  t: number;
  type: 'moved' | 'drop';
}

export type TriggerKind = 'impact' | 'burst' | 'fall_alert' | 'scream' | 'help_pressed' | 'phone_drop';

/** What one phone agent saw around an incident. Every number is from its own sensors. */
export interface EvidenceReport {
  id: string;
  incidentId: string;
  nodeId: string;
  name: string;
  /** Hub time the report was posted (ms). */
  postedAt: number;
  /** Telemetry samples the phone streamed inside the evidence window. */
  samples: number;
  /** Milliseconds since this phone last streamed anything when the incident opened. */
  silenceMs: number;
  /** How old this phone's newest reading was when it reported (live phones: under a second). */
  ageMs?: number;
  sound: {
    /** Loudest impact near the incident time, dB above this phone's ambient floor (null: none heard). */
    impactDb: number | null;
    impactRepetitive: boolean;
    screamDb: number | null;
    /** Voice, music or other sustained sound events in the 12 s before the incident. */
    mediaEventsBefore: number;
    /** Any voice heard after the incident (someone talking). */
    voiceAfter: boolean;
    /** What the sound model recognised in the loudest impact (null: model not running or no impact). */
    impactAi: { group: string; score: number; label: string } | null;
    /** Share of the 12 s before the incident that sounded like TV or music (null: no model). */
    media: number | null;
    /** The sound model heard someone in distress (scream, groan, crying) around the incident. */
    distress: boolean;
  };
  sonar: {
    /** The phone's sonar was running and its speaker to mic link was healthy. */
    online: boolean;
    medianLinkDb: number;
    sawPersonBefore: boolean;
    rangeBefore: number | null;
    rangeAfter: number | null;
    /** Strongest fast body motion around the incident, dB. */
    burstDb: number;
    /** Fraction of the post incident window with no body motion. */
    stillAfter: number;
    /** Normal movement came back after the incident (walking, getting up). */
    motionResumed: boolean;
    presentAfter: boolean;
    /** Seconds before the incident this phone last saw someone (null: not in the last 40 s). */
    lastSeenAgo: number | null;
    /** Seconds after the incident of the first body movement (shifting, fidgeting); null if none at all. */
    firstMoveAfter: number | null;
    breathingAfter: number | null;
    /** How much the static room echo changed: large values mean the phone itself moved. */
    roomChangeDb: number;
  };
  imu: { moved: boolean; dropped: boolean };
  /** The phone's own on-device verdict (what a single phone system would do). */
  localVerdict: 'fall' | 'possible_fall' | 'none';
  /** Set by the simulator only, never read by any agent. */
  _compromised?: boolean;
}

export type RoleName = 'responder' | 'skeptic' | 'auditor';
/** The three local role agents, plus the Investigator (Claude) that is only called in when they cannot agree. */
export type AgentName = RoleName | 'investigator';
export type Stance = 'escalate' | 'stand_down' | 'uncertain';

export interface TrustEntry {
  score: number;
  reasons: string[];
}

export interface Position {
  id: string;
  incidentId: string;
  agent: AgentName;
  /** 1 and 2: the role agents; 3: the Investigator. */
  round: 1 | 2 | 3;
  stance: Stance;
  confidence: number;
  /** One or two sentences in the agent's own voice. */
  argument: string;
  /** The specific evidence the agent cites. */
  points: string[];
  /** Auditor only: how much each phone's report can be trusted. */
  trust?: Record<string, TrustEntry>;
  /** Auditor only: phones contradict each other and no other phone can break the tie. */
  conflict?: string;
  /** True when the argument was written by a language model. */
  llm: boolean;
  /** Tools the agent chose to call before deciding (Claude agent mode). */
  tools?: string[];
  /** What those tools came back with, shared with the other agents for round 2. */
  findings?: string[];
  /** Set when a safety rule overrode what the model wanted. */
  floor?: string;
  postedAt: number;
}

/** One step of an agent's reasoning, posted live so the console can show what it looked at. */
export interface AgentTrace {
  incidentId: string;
  agent: AgentName;
  /** 1, 2: role agent rounds; 3 and up: negotiation rounds (or the Investigator). */
  round: number;
  step: number;
  kind: 'thought' | 'tool' | 'fallback' | 'floor';
  tool?: string;
  input?: Record<string, unknown>;
  /** Short plain words: what it asked and what came back. */
  summary: string;
  t: number;
}

export type OutcomeKind = 'escalate' | 'stand_down' | 'ask_human';

export interface Outcome {
  incidentId: string;
  kind: OutcomeKind;
  /** Every agent agreed on the direction. */
  unanimous: boolean;
  headline: string;
  summary: string;
  /** Agents that disagreed with the outcome, kept on the record. */
  dissent: { agent: AgentName; stance: Stance; argument: string }[];
  quarantined: string[];
  decidedAt: number;
  /** What the agents agreed to do (or the compromise), when they negotiated. */
  plan?: import('./negotiation').Plan;
  negotiation?: { rounds: number; agreed: boolean };
}

export type IncidentStatus =
  | 'gathering'
  | 'deliberating'
  | 'asking'
  /** Agents want help called: the phones say so out loud and count down; "I'm OK" cancels. */
  | 'urgent'
  | 'escalated'
  | 'stood_down'
  | 'resolved_ok'
  | 'resolved_help';

export interface Incident {
  id: string;
  t0: number;
  trigger: { nodeId: string; name: string; kind: TriggerKind; detail: string };
  status: IncidentStatus;
  /** Phones expected to report. */
  expected: string[];
  simulated: boolean;
  scenario?: string;
}

export interface ActionRecord {
  incidentId: string;
  action: 'call' | 'sms' | 'webhook' | 'webex' | 'ask_phone' | 'quarantine';
  ok: boolean;
  detail: string;
  t: number;
}

export interface ContextNote {
  incidentId: string;
  notes: string[];
  source: { name: string; kind: string; errDb: number } | null;
  endedAt: { name: string; kind: string } | null;
  postedAt: number;
}

export type BoardMsg =
  | { type: 'incident'; incident: Incident }
  | { type: 'context'; context: ContextNote }
  | { type: 'report'; report: EvidenceReport }
  | { type: 'position'; position: Position }
  | { type: 'trace'; trace: AgentTrace }
  | { type: 'move'; move: import('./negotiation').Move }
  | { type: 'outcome'; outcome: Outcome }
  | { type: 'action'; action: ActionRecord }
  | { type: 'human'; incidentId: string; answer: 'ok' | 'help' | 'no_answer'; source: string; t: number; transcript?: string; injury?: string | null };
