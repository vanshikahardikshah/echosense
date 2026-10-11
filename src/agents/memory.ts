import type { EvidenceReport, Incident, Outcome } from './types';

/**
 * The home's memory: every incident, what the agents decided, and what a human
 * said afterwards. A human answer is the ground truth the agents never get to
 * see at decision time, so it is what they learn from:
 *   - phones whose alarms keep turning out false lose some trust,
 *   - sounds that keep turning out harmless at the same time of day and on the
 *     same phone become a known pattern ("the 8 pm bangs are the TV"),
 *   - and every agent can read the history before it argues.
 */

export interface Remembered {
  id: string;
  t: number;
  hour: number;
  trigger: string;
  outcome: Outcome['kind'];
  /** What a person said afterwards (the label), if anyone did. */
  human: 'ok' | 'help' | 'no_answer' | null;
  source: string;
  /** The sound the model recognised, and on which phone it was loudest. */
  sound: string | null;
  loudest: string | null;
  /** Phones whose own on-device rule raised a fall. */
  alarmed: string[];
  place: string | null;
  simulated: boolean;
}

export interface PhoneRecord {
  alarms: number;
  /** Alarms a person later said were nothing. */
  falseAlarms: number;
  /** Alarms that turned out real (help needed or no answer). */
  confirmed: number;
}

export interface HomeMemory {
  incidents: Remembered[];
  phones: Record<string, PhoneRecord>;
}

export function emptyMemory(): HomeMemory {
  return { incidents: [], phones: {} };
}

export function remember(mem: HomeMemory, incident: Incident, reports: EvidenceReport[], outcome: Outcome, place: string | null): Remembered {
  const heard = reports.filter((r) => r.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0));
  const loud = heard[0];
  const rec: Remembered = {
    id: incident.id,
    t: incident.t0,
    hour: new Date(incident.t0).getHours(),
    trigger: incident.trigger.kind,
    outcome: outcome.kind,
    human: null,
    source: '',
    sound: loud?.sound.impactAi ? loud.sound.impactAi.label : null,
    loudest: loud ? loud.nodeId : null,
    alarmed: reports.filter((r) => r.localVerdict !== 'none').map((r) => r.nodeId),
    place,
    simulated: incident.simulated,
  };
  mem.incidents.push(rec);
  if (mem.incidents.length > 300) mem.incidents.splice(0, mem.incidents.length - 300);
  for (const id of rec.alarmed) (mem.phones[id] ??= { alarms: 0, falseAlarms: 0, confirmed: 0 }).alarms++;
  return rec;
}

/** A person answered: this is the label the system learns from. */
export function learn(mem: HomeMemory, incidentId: string, answer: 'ok' | 'help' | 'no_answer', source: string): void {
  const rec = mem.incidents.find((r) => r.id === incidentId);
  if (!rec || rec.human) return;
  rec.human = answer;
  rec.source = source;
  for (const id of rec.alarmed) {
    const p = (mem.phones[id] ??= { alarms: 0, falseAlarms: 0, confirmed: 0 });
    if (answer === 'ok') p.falseAlarms++;
    else p.confirmed++;
  }
}

/** Trust multiplier for a phone, learned from how its past alarms turned out. */
export function learnedTrust(mem: HomeMemory | undefined, nodeId: string): { factor: number; reason: string } | null {
  const p = mem?.phones[nodeId];
  if (!p || p.falseAlarms < 3) return null;
  const ratio = p.falseAlarms / Math.max(1, p.falseAlarms + p.confirmed);
  if (ratio < 0.75) return null;
  return { factor: 0.8, reason: `${p.falseAlarms} of its last ${p.falseAlarms + p.confirmed} alarms turned out to be nothing` };
}

/** Past incidents like this one (same sound on the same phone around the same hour) that a person called fine. */
export function knownHarmless(mem: HomeMemory | undefined, reports: EvidenceReport[], t0: number): Remembered[] {
  if (!mem) return [];
  const heard = reports.filter((r) => r.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0));
  const loud = heard[0];
  if (!loud) return [];
  const hour = new Date(t0).getHours();
  const label = loud.sound.impactAi?.label ?? null;
  return mem.incidents.filter(
    (r) =>
      !r.simulated &&
      r.human === 'ok' &&
      r.loudest === loud.nodeId &&
      Math.min(Math.abs(r.hour - hour), 24 - Math.abs(r.hour - hour)) <= 1 &&
      (label === null || r.sound === label),
  );
}

/** A short summary an agent can read. */
export function summarize(mem: HomeMemory | undefined, names: Record<string, string>, reports: EvidenceReport[], t0: number): Record<string, unknown> {
  if (!mem || !mem.incidents.some((r) => !r.simulated)) return { note: 'No history yet in this home.' };
  const real = mem.incidents.filter((r) => !r.simulated);
  const recent = real.slice(-8).map((r) => ({
    when: new Date(r.t).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }),
    trigger: r.trigger,
    sound: r.sound,
    decided: r.outcome,
    person_said: r.human ?? 'nobody was asked',
    place: r.place,
  }));
  const phones = Object.fromEntries(Object.entries(mem.phones).map(([id, p]) => [names[id] ?? id, p]));
  const similar = knownHarmless(mem, reports, t0);
  return {
    incidents_remembered: real.length,
    recent,
    phone_alarm_record: phones,
    similar_past_incidents_that_were_fine: similar.length,
    pattern: similar.length >= 2 ? `${similar.length} earlier incidents like this (same sound, same phone, same time of day) were fine` : null,
  };
}
