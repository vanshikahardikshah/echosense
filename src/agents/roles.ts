import { uid } from './phoneAgent';
import { kindInfo, type MapContext } from './cartographer';
import { knownHarmless, learnedTrust, type HomeMemory } from './memory';
import type { AgentName, EvidenceReport, Incident, Position, RoleName, Stance, TrustEntry } from './types';

/**
 * The three role agents. Each has its own goal and reads the same public
 * evidence; none can see the others' internals, only their posted positions.
 *
 *   Responder: the person's advocate. Its job is to never let a real fall go
 *              unanswered, so it builds the strongest case for getting help.
 *   Skeptic:   the household's advocate against false alarms. Its job is to
 *              find a harmless explanation that fits every measurement.
 *   Auditor:   trusts no phone by default. Its job is to check each report
 *              against physics and against the other phones, and to say how
 *              far each one can be believed.
 *
 * The reasoning here is explicit and deterministic (it runs offline and is
 * what the evaluation measures). A language model, when configured, only
 * rewrites the argument in natural language; see llm.ts.
 */

export interface DeliberationContext {
  incident: Incident;
  reports: EvidenceReport[];
  round: 1 | 2 | 3;
  /** Round 1 positions from all agents (round 2 only). */
  prior: Position[];
  /** Report fingerprints from earlier incidents (replay detection). */
  seenFingerprints: Set<string>;
  now: number;
  /** What the Cartographer worked out from the room map, if anything. */
  context?: MapContext;
  /** What this home has learned from people's answers to earlier incidents. */
  memory?: HomeMemory;
}

const BURST = 20;

// ---------------------------------------------------------------- shared facts
export function phoneMovedItself(r: EvidenceReport): boolean {
  return r.imu.moved || r.imu.dropped || r.sonar.roomChangeDb >= 15;
}
function heardImpact(r: EvidenceReport, min = 10): boolean {
  return r.sound.impactDb !== null && r.sound.impactDb >= min && !r.sound.impactRepetitive;
}
const HARMLESS = ['tap', 'speech', 'media', 'footsteps'];
/** The phone's sound model recognised the impact as something harmless (a snap, a tap, talking, TV, a door). */
export function harmlessSound(r: EvidenceReport): boolean {
  const a = r.sound.impactAi;
  // A soft fall can sound like a tap: the label is not believed when this phone's sonar saw a body move at the same time.
  const bodyMoved = r.sonar.online && r.sonar.burstDb >= 16 && !phoneMovedItself(r);
  return !!a && a.score >= 0.3 && (HARMLESS.includes(a.group) || a.group === 'object') && !bodyMoved;
}
function thudSound(r: EvidenceReport): boolean {
  return !!r.sound.impactAi && r.sound.impactAi.group === 'thud' && r.sound.impactAi.score >= 0.3;
}
/** An impact that could be a person falling (heard, and not recognised as harmless). */
function dangerImpact(r: EvidenceReport, min = 10): boolean {
  return heardImpact(r, min) && !harmlessSound(r);
}
function claimsBody(r: EvidenceReport): boolean {
  return sonarBurst(r) || r.localVerdict !== 'none';
}
function aiWords(r: EvidenceReport): string {
  const a = r.sound.impactAi;
  return a ? `${a.label} ${Math.round(a.score * 100)}%` : '';
}
function watched(r: EvidenceReport): boolean {
  return r.sonar.online && r.sonar.sawPersonBefore && !phoneMovedItself(r);
}
function sonarBurst(r: EvidenceReport): boolean {
  return r.sonar.online && r.sonar.burstDb >= BURST && !phoneMovedItself(r);
}
function rangeShift(r: EvidenceReport): number | null {
  return r.sonar.rangeBefore !== null && r.sonar.rangeAfter !== null ? Math.abs(r.sonar.rangeAfter - r.sonar.rangeBefore) : null;
}
function fullSignature(r: EvidenceReport): boolean {
  return watched(r) && sonarBurst(r) && dangerImpact(r) && r.sonar.stillAfter >= 0.8 && !r.sonar.motionResumed;
}
/**
 * True unless the impact was clearly loudest on a phone that could not see the
 * person while every phone watching the person heard it at least 6 dB quieter.
 */
export function colocated(rs: EvidenceReport[]): boolean {
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const watchers = rs.filter(watched);
  if (heard.length < 2 || !watchers.length) return true;
  const loudest = heard.reduce((m, r) => (r.sound.impactDb! > m.sound.impactDb! ? r : m));
  if (watchers.includes(loudest)) return true;
  return !watchers.every((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb! - 6);
}
function cap(x: string): string {
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}
function db(x: number | null): string {
  return x === null ? 'nothing' : `${x.toFixed(0)} dB`;
}
function trustOf(ctx: DeliberationContext): Record<string, TrustEntry> | null {
  return ctx.prior.find((p) => p.agent === 'auditor')?.trust ?? null;
}
function w(trust: Record<string, TrustEntry> | null, r: EvidenceReport): number {
  return trust?.[r.nodeId]?.score ?? 1;
}
export function fingerprint(r: EvidenceReport): string {
  const s = r.sonar;
  return [r.nodeId, r.sound.impactDb?.toFixed(2), s.burstDb.toFixed(2), s.stillAfter.toFixed(3), s.rangeBefore?.toFixed(3), s.rangeAfter?.toFixed(3), r.samples].join('|');
}

function position(
  ctx: DeliberationContext,
  agent: RoleName,
  stance: Stance,
  confidence: number,
  argument: string,
  points: string[],
  trust?: Record<string, TrustEntry>,
): Position {
  return {
    id: uid(agent),
    incidentId: ctx.incident.id,
    agent,
    round: ctx.round,
    stance,
    confidence: Math.max(0.05, Math.min(0.97, confidence)),
    argument,
    points,
    trust,
    llm: false,
    postedAt: ctx.now,
  };
}

// ---------------------------------------------------------------- auditor
export function auditor(ctx: DeliberationContext): Position {
  const rs = ctx.reports;
  const trust: Record<string, TrustEntry> = {};
  const quarantine: string[] = [];
  const healthy = (r: EvidenceReport) => r.samples >= 10 && r.silenceMs <= 3000;

  // Pass 1: acoustics only, so that pass 2 can rely on the phones that passed it.
  const acoustic = new Map<string, number>();
  for (const r of rs) {
    const others = rs.filter((o) => o !== r && healthy(o));
    let a = 1;
    const loud = r.sound.impactDb !== null && r.sound.impactDb >= 20;
    if (loud && others.length >= 2 && !others.some((o) => heardImpact(o, 5)) && !phoneMovedItself(r) && claimsBody(r)) a = 0.25;
    if (r.sound.impactDb === null && healthy(r) && others.filter((o) => heardImpact(o, 15)).length >= 2) a = 0.25;
    acoustic.set(r.nodeId, a);
  }

  for (const r of rs) {
    let score = 1;
    const reasons: string[] = [];
    const others = rs.filter((o) => o !== r && healthy(o));
    if (!healthy(r)) {
      score *= 0.5;
      reasons.push(r.samples < 10 ? `streamed only ${r.samples} samples around the incident` : `was silent for ${(r.silenceMs / 1000).toFixed(0)} s before it`);
    }
    if (ctx.seenFingerprints.has(fingerprint(r))) {
      score *= 0.1;
      reasons.push('sent a report identical to an earlier incident (replayed)');
    }
    const moved = phoneMovedItself(r);
    if (moved) {
      reasons.push(
        r.imu.dropped || r.imu.moved
          ? 'its own motion sensor says the phone moved, so its sonar describes the phone, not the room'
          : `its room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB at once, so the phone itself moved`,
      );
    }
    // Acoustics: a bang loud enough to matter reaches every phone in the home.
    const loud = r.sound.impactDb !== null && r.sound.impactDb >= 20;
    const othersHeard = others.filter((o) => heardImpact(o, 5));
    if (loud && others.length >= 1 && othersHeard.length === 0 && !moved && !claimsBody(r)) {
      // Honest and harmless: a tap or a knock right next to this phone.
      reasons.push(`heard a ${db(r.sound.impactDb)} sound right next to it that the others did not: something near this phone, not a fall`);
    } else if (loud && others.length >= 2 && othersHeard.length === 0 && !moved) {
      score *= 0.25;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact and a fall that ${others.map((o) => o.name).join(' and ')} did not hear at all`);
    } else if (loud && others.length === 1 && othersHeard.length === 0 && !moved) {
      score *= 0.6;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact nobody else confirms`);
    }
    const loudOthers = others.filter((o) => heardImpact(o, 15));
    if (r.sound.impactDb === null && healthy(r) && loudOthers.length >= 2) {
      // Not hearing something is not lying: the phone may be far away, covered or facing away.
      // Only a phone that also claims to have watched the person carry on normally contradicts the others.
      const claimsFine = watched(r) && (r.sonar.motionResumed || (r.sonar.presentAfter && r.sonar.burstDb < 16));
      if (claimsFine) {
        score *= 0.25;
        reasons.push(`heard nothing and claims the person carried on normally, while ${loudOthers.map((o) => `${o.name} (${db(o.sound.impactDb)})`).join(' and ')} heard an impact`);
      } else {
        score *= 0.65;
        reasons.push(`did not hear the impact ${loudOthers.map((o) => o.name).join(' and ')} heard: low observability for this event (distance, obstruction or orientation), not evidence either way`);
      }
    } else if (r.sound.impactDb === null && healthy(r) && loudOthers.length === 1 && others.length === 1) {
      score *= 0.7;
      reasons.push(`heard nothing while ${loudOthers[0].name} heard ${db(loudOthers[0].sound.impactDb)}`);
    }
    // Sonar: one person at home. If a phone was watching them and saw ordinary
    // movement, another phone's burst claim contradicts it.
    if (sonarBurst(r)) {
      const calm = others.filter(
        (o) => (acoustic.get(o.nodeId) ?? 1) >= 0.5 && watched(o) && o.sonar.burstDb < 16 && (o.sonar.motionResumed || o.sonar.presentAfter),
      );
      if (calm.length) {
        score *= 0.5;
        reasons.push(`its burst is contradicted by ${calm.map((o) => o.name).join(' and ')}, which watched the person move normally`);
      }
    }
    // Self consistency: does its own verdict follow from its own numbers?
    if (r.localVerdict === 'fall' && !(sonarBurst(r) || moved) && !heardImpact(r)) {
      score *= 0.3;
      reasons.push("its fall verdict does not follow from its own measurements");
    }
    // Learned: this phone's past alarms keep turning out to be nothing.
    const learned = learnedTrust(ctx.memory, r.nodeId);
    if (learned && r.localVerdict !== 'none') {
      score *= learned.factor;
      reasons.push(`learned from earlier answers: ${learned.reason}`);
    }
    if (!reasons.length) reasons.push('consistent with the other phones');
    trust[r.nodeId] = { score: Math.max(0.02, score), reasons };
    if (score < 0.3 && !moved) quarantine.push(r.name);
  }

  // Two phones telling opposite stories with no third phone to break the tie.
  let conflict: string | undefined;
  const healthyRs = rs.filter(healthy);
  for (const a of healthyRs) {
    for (const b of healthyRs) {
      if (a === b) continue;
      const deafB = (a.sound.impactDb ?? 0) >= 20 && b.sound.impactDb === null && !phoneMovedItself(a) && !harmlessSound(a);
      const calmB = sonarBurst(a) && watched(b) && b.sonar.burstDb < 16 && (b.sonar.motionResumed || b.sonar.presentAfter);
      if (!deafB && !calmB) continue;
      const third = healthyRs.filter((c) => c !== a && c !== b);
      const tieBreak = third.some((c) => (deafB && (c.sound.impactDb !== null) !== (b.sound.impactDb !== null)) || (calmB && watched(c)));
      const sideWithB = third.some((c) => deafB && c.sound.impactDb === null);
      if (!tieBreak && !sideWithB && (claimsBody(a) || claimsBody(b))) {
        conflict = `${a.name} and ${b.name} tell opposite stories (${deafB ? `${a.name} heard ${db(a.sound.impactDb)}, ${b.name} heard nothing` : `${a.name} saw a sudden movement, ${b.name} saw them moving normally`}) and no other phone can break the tie`;
      }
    }
  }

  // Is the danger evidence corroborated by independent channels from trusted phones?
  const good = rs.filter((r) => trust[r.nodeId].score >= 0.5);
  const bad = rs.filter((r) => trust[r.nodeId].score < 0.5);
  // Did the bang come from where the person is? The phones watching the person
  // should hear it about as loud as anyone does.
  const mapSays = ctx.context?.source;
  const together = colocated(good) && !(mapSays && mapSays.kind !== 'person' && ctx.context?.personFit && ctx.context.personFit.errDb - mapSays.errDb >= 3);
  const sonarCh = good.filter(
    (r) =>
      watched(r) &&
      sonarBurst(r) &&
      r.sonar.stillAfter >= 0.8 &&
      !r.sonar.motionResumed &&
      ((heardImpact(r, 10) && together) || (rangeShift(r) ?? 0) >= 0.35),
  );
  // Lying motionless after a sudden movement is one weak channel, however many phones see it,
  // unless the room map puts them on a sofa, chair or bed with no bang (sitting down).
  const restSpot = ctx.context?.endedAt && kindInfo(ctx.context.endedAt.place.kind).rest && (ctx.context.endedAt.phones >= 2 || ctx.context.endedAt.offBy <= 0.2);
  const motionless =
    !(restSpot && !good.some((r) => dangerImpact(r, 12))) &&
    good.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.presentAfter && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  const audioCh = together ? good.filter((r) => dangerImpact(r, 12)) : [];
  const scream = good.some((r) => r.sound.screamDb !== null || r.sound.distress);
  // Someone was moving moments ago, then a bang, and now no phone can find them.
  // Presence counts as "just before" only if it was seen within 10 s; older sightings say nothing about the moment of the bang.
  const vanished =
    good.some((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10) &&
    !good.some((r) => r.sonar.presentAfter || r.sonar.motionResumed) &&
    good.some((r) => dangerImpact(r, 15));
  const danger = (r: EvidenceReport) => r.localVerdict !== 'none' || sonarBurst(r) || dangerImpact(r, 20) || r.sound.distress;
  const points: string[] = [];
  for (const r of rs) {
    const t = trust[r.nodeId];
    points.push(`${r.name}: trust ${(t.score * 100).toFixed(0)}%, ${t.reasons.join('; ')}`);
  }
  if (ctx.incident.trigger.kind === 'help_pressed') {
    return position(ctx, 'auditor', 'escalate', 0.95, 'The person asked for help on the phone. That is first hand and needs no corroboration.', points, trust);
  }
  if (conflict) {
    const p = position(ctx, 'auditor', 'uncertain', 0.6, `${conflict[0].toUpperCase()}${conflict.slice(1)}. One of them is wrong, and only the person can settle it.`, points, trust);
    p.conflict = conflict;
    return p;
  }
  if (bad.some(danger) && !good.some(danger)) {
    const names = bad.filter(danger).map((r) => r.name).join(' and ');
    return position(
      ctx,
      'auditor',
      'stand_down',
      0.85,
      `The alarm rests on ${names} alone, and ${names} contradicts the other phones. I would not act on it${quarantine.length ? `, and I am flagging ${quarantine.join(', ')} as untrustworthy` : ''}.`,
      points,
      trust,
    );
  }
  if (!together) points.push('the impact was loudest far from the person, so the sound and the movement are separate events');
  if (restSpot) points.push(`the room map puts them at the ${ctx.context!.endedAt!.place.name}`);
  const harmless = rs.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  if (harmless.length) points.push(`sound model on ${harmless.map((r) => `${r.name}: ${aiWords(r)}`).join(', ')}`);
  const channels =
    (sonarCh.length ? 1 : motionless ? 1 : 0) + (sonarCh.length >= 2 ? 1 : 0) + (audioCh.length ? 1 : 0) + (scream ? 1 : 0) + (vanished ? 1 : 0);
  const thudHeard = audioCh.some(thudSound);
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished && thudHeard) {
    return position(ctx, 'auditor', 'uncertain', 0.5, `Only sound so far, but the sound model calls it ${aiWords(audioCh.find(thudSound)!)}. Worth asking.`, points, trust);
  }
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished) {
    return position(
      ctx,
      'auditor',
      'stand_down',
      0.55,
      'A sound on its own, with no sign of anyone moving or falling, is not enough to bother anyone.',
      points,
      trust,
    );
  }
  if (channels === 0 && (good.some(danger) || !together)) {
    return position(
      ctx,
      'auditor',
      'stand_down',
      0.65,
      together
        ? 'The measurements are real, but none of them is a fall pattern: no impact where the person is, no move to the floor, and they moved again afterwards.'
        : 'The phones are honest, but the bang came from where nobody is, and the movement near the person ended where it started.',
      points,
      trust,
    );
  }
  // Without a fall pattern on the sonar, a scream or a vanished person, it stays ambiguous: ask.
  if (channels >= 2 && !sonarCh.length && !scream && !vanished) {
    return position(ctx, 'auditor', 'uncertain', 0.5, 'Two weak signs line up (a bang and stillness at the same spot), but nothing shows a fall for certain. Ask them.', points, trust);
  }
  if (channels >= 2) {
    const parts = [
      sonarCh.length ? `sonar on ${sonarCh.map((r) => r.name).join(' and ')}` : '',
      audioCh.length ? `the impact heard by ${audioCh.length} phone${audioCh.length > 1 ? 's' : ''}` : '',
      scream ? 'someone in distress' : '',
      vanished
        ? (() => {
            const seer = good.filter((r) => r.sonar.lastSeenAgo !== null).sort((a, b) => a.sonar.lastSeenAgo! - b.sonar.lastSeenAgo!)[0];
            const blind = good.filter((r) => !r.sonar.online).map((r) => r.name);
            return `${seer.name} last saw the person ${seer.sonar.lastSeenAgo!.toFixed(0)} s before the bang and nobody since${blind.length ? ` (${blind.join(' and ')} had no working sonar)` : ''}`;
          })()
        : '',
    ].filter(Boolean);
    return position(ctx, 'auditor', 'escalate', 0.7, `The evidence checks out: ${parts.join(' and ')} line up in time, from phones that agree with each other.`, points, trust);
  }
  if (!good.some(danger)) {
    return position(ctx, 'auditor', 'stand_down', 0.6, 'No trusted phone measured anything dangerous.', points, trust);
  }
  return position(ctx, 'auditor', 'uncertain', 0.5, 'The reports are honest but thin: only one kind of evidence, so I cannot confirm it either way.', points, trust);
}

// ---------------------------------------------------------------- responder
export function responder(ctx: DeliberationContext): Position {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const ignored = ctx.reports.filter((r) => w(trust, r) < 0.5);
  const points: string[] = [];
  let s = 0;
  if (ctx.incident.trigger.kind === 'help_pressed') {
    return position(ctx, 'responder', 'escalate', 0.97, 'They pressed Get help. Call now.', ['help requested on the phone']);
  }
  const full = rs.filter(fullSignature);
  if (full.length) {
    const r = full[0];
    s += 0.6;
    points.push(
      `${r.name} watched the person: ${r.sonar.burstDb.toFixed(0)} dB burst, impact ${db(r.sound.impactDb)}, then ${(r.sonar.stillAfter * 100).toFixed(0)}% still afterwards`,
    );
  } else {
    const soft = rs.filter((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.stillAfter >= 0.85 && !r.sonar.motionResumed);
    if (soft.length) {
      const r = soft[0];
      const shift = rangeShift(r);
      s += sonarBurst(r) ? 0.35 : 0.2;
      points.push(`${r.name}: sudden motion (${r.sonar.burstDb.toFixed(0)} dB) and then no movement`);
      if (r.sonar.presentAfter && r.sonar.firstMoveAfter === null) {
        s += 0.25;
        points.push(`${r.name} has seen no movement at all for 10 s since; people sitting down shift around, this person has not`);
      }
      if (shift !== null && shift >= 0.35) {
        s += 0.2;
        points.push(`${r.name} saw the body move from ${r.sonar.rangeBefore!.toFixed(1)} m to ${r.sonar.rangeAfter!.toFixed(1)} m and stay there`);
      }
    }
  }
  const heard = rs.filter((r) => dangerImpact(r, 12));
  const thud = rs.find(thudSound);
  if (thud) {
    s += 0.15;
    points.push(`the sound model on ${thud.name} heard ${aiWords(thud)}, like a body hitting the floor`);
  }
  const distress = rs.find((r) => r.sound.distress);
  if (distress) {
    s += 0.3;
    points.push(`${distress.name} heard someone in distress`);
  }
  const harmless = rs.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  if (harmless.length && !heard.length) {
    s -= 0.3;
    points.push(`the sound model called it ${harmless.map(aiWords).join(', ')}`);
  }
  if (heard.length && !full.length) {
    s += 0.15;
    points.push(`impact heard by ${heard.map((r) => `${r.name} (${db(r.sound.impactDb)})`).join(', ')}`);
  }
  if (heard.length >= 2 && rs.some((r) => sonarBurst(r) && watched(r))) {
    s += 0.1;
    points.push('the impact and the body motion happened together');
  }
  const scream = rs.filter((r) => r.sound.screamDb !== null);
  if (scream.length) {
    s += 0.25;
    points.push(`scream heard by ${scream.map((r) => r.name).join(', ')}`);
  }
  const anyWatching = rs.some((r) => watched(r) || (r.sonar.online && r.sonar.presentAfter));
  const recently = rs.filter((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10).sort((a, b) => a.sonar.lastSeenAgo! - b.sonar.lastSeenAgo!)[0];
  if (!anyWatching && recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15)) {
    s += 0.3;
    points.push(`${recently.name} saw them moving ${recently.sonar.lastSeenAgo!.toFixed(0)} s before a heavy bang, and now no phone can see them`);
  }
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    s -= 0.45;
    points.push(`${resumed.map((r) => r.name).join(' and ')} saw normal movement afterwards`);
  }
  if (ignored.length) points.push(`not counting ${ignored.map((r) => r.name).join(', ')} (the Auditor does not trust ${ignored.length > 1 ? 'them' : 'it'})`);

  if (ctx.round === 2) {
    const sk = ctx.prior.find((p) => p.agent === 'skeptic');
    const au = ctx.prior.find((p) => p.agent === 'auditor');
    if (au?.stance === 'stand_down') s -= 0.3;
    if (au?.stance === 'escalate') s += 0.1;
    if (sk?.stance === 'stand_down') {
      s -= 0.3 * sk.confidence;
      if (sk.confidence >= 0.7) points.push(`the Skeptic's explanation fits the data: ${sk.points[0] ?? sk.argument}`);
    }
  }
  const m = ctx.context;
  if (m?.endedAt && !kindInfo(m.endedAt.place.kind).rest && rs.some((r) => watched(r) && r.sonar.burstDb >= 16)) {
    s += 0.1;
    points.push(`they ended up at the ${m.endedAt.place.name}, not somewhere people sit or lie down`);
  }
  if (m?.source?.kind === 'person' && heard.length >= 2) {
    s += 0.1;
    points.push('the room map puts the bang right where the person is');
  }
  // Signs they are awake: they can answer a check-in, so ask before calling.
  const awake = rs.filter((r) => watched(r) && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  const talking = rs.some((r) => r.sound.voiceAfter && r.sound.mediaEventsBefore < 3);
  if (s >= 0.55 && (awake.length || talking) && !scream.length) {
    points.push(awake.length ? `${awake[0].name} saw them move ${awake[0].sonar.firstMoveAfter!.toFixed(0)} s later, so they are awake` : 'someone is talking');
    return position(ctx, 'responder', 'uncertain', 0.6, `This could be a fall, but they are awake and moving. Ask them first and call if they do not answer.`, points);
  }
  // Calling straight away needs something unambiguous; otherwise ask first.
  const shifted = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && (rangeShift(r) ?? 0) >= 0.35 && !r.sonar.motionResumed);
  const vanishedNow = !anyWatching && !!recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15);
  const clear = full.length > 0 || shifted || !!distress || scream.length > 0 || vanishedNow || rs.some((r) => thudSound(r) && sonarBurst(r) && watched(r));
  if (s >= 0.55 && !clear) {
    return position(ctx, 'responder', 'uncertain', 0.6, `This might be a fall, but nothing is certain yet. ${points[0] ?? ''}. Ask them now, and call if they do not answer.`, points);
  }
  if (s >= 0.55) {
    return position(ctx, 'responder', 'escalate', s, `This looks like a real fall. ${points[0] ?? ''}. I want someone called now.`, points);
  }
  if (s >= 0.25) {
    return position(ctx, 'responder', 'uncertain', 0.5, `Something happened and I cannot rule out that they are hurt. ${points[0] ?? ''}. Ask them.`, points);
  }
  const sk = ctx.prior.find((p) => p.agent === 'skeptic');
  const convinced = ctx.round === 2 && sk?.stance === 'stand_down' && sk.confidence >= 0.7;
  const because = convinced
    ? `I accept the Skeptic's explanation: ${(sk!.points[0] ?? sk!.argument).split(':')[0]}.`
    : resumed.length
      ? `${resumed.map((r) => r.name).join(' and ')} saw them moving normally afterwards.`
      : ignored.length && !rs.some((r) => r.localVerdict !== 'none' || sonarBurst(r))
        ? `The only alarm comes from ${ignored.map((r) => r.name).join(', ')}, and I do not trust it.`
        : points.length
          ? 'What the phones measured does not add up to someone hurt.'
          : 'No sign that anyone is hurt.';
  return position(ctx, 'responder', 'stand_down', Math.min(0.9, 0.6 - s), `Nothing here needs a caregiver. ${because}`, points);
}

// ---------------------------------------------------------------- skeptic
interface Hypothesis {
  name: string;
  strength: number;
  because: string;
}

export function skeptic(ctx: DeliberationContext): Position {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const hyps: Hypothesis[] = [];
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const loudest = heard.reduce<EvidenceReport | null>((m, r) => (!m || r.sound.impactDb! > m.sound.impactDb! ? r : m), null);
  const watchers = rs.filter(watched);

  // 1. The bang came from somewhere other than the person (TV, music, next room).
  if (loudest && heard.length >= 2 && watchers.length && !watchers.includes(loudest)) {
    const quieter = watchers.filter((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb! - 6);
    if (quieter.length === watchers.length) {
      let st = 0.45;
      const why = [`the impact was loudest on ${loudest.name} (${db(loudest.sound.impactDb)}), which could not see the person; ${quieter.map((r) => `${r.name} next to them heard ${db(r.sound.impactDb)}`).join(', ')}`];
      const media = rs.filter((r) => r.sound.mediaEventsBefore >= 3);
      if (media.length) {
        st += 0.15;
        why.push(`continuous voice or music before it (${media[0].sound.mediaEventsBefore} events on ${media[0].name})`);
      }
      const inPlace = watchers.filter((r) => r.sonar.presentAfter && (rangeShift(r) ?? 9) < 0.3);
      if (inPlace.length) {
        st += 0.25;
        why.push(`${inPlace[0].name} shows them at the same distance afterwards (${inPlace[0].sonar.rangeAfter!.toFixed(1)} m), not on the floor`);
      }
      if (!watchers.some((r) => r.sonar.burstDb >= 24)) st += 0.1;
      hyps.push({ name: 'sound from elsewhere', strength: st, because: why.join('; ') });
    }
  }
  // 2. A phone got knocked over: the bang is the phone itself.
  for (const r of ctx.reports) {
    if (!phoneMovedItself(r) || r.sound.impactDb === null) continue;
    const others = ctx.reports.filter((o) => o !== r);
    const otherMax = others.reduce((m, o) => Math.max(m, o.sound.impactDb ?? -99), -99);
    if (r.sound.impactDb - otherMax >= 10) {
      let st = 0.7;
      const why = [`${r.name} heard the bang ${otherMax < -50 ? 'and nobody else did' : `${(r.sound.impactDb - otherMax).toFixed(0)} dB louder than anyone`}`];
      why.push(r.imu.moved || r.imu.dropped ? `its accelerometer says it moved` : `its whole room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB`);
      if (rs.some((o) => o !== r && watched(o) && (o.sonar.motionResumed || o.sonar.burstDb < BURST))) {
        st += 0.15;
        why.push('the phones watching the person saw nothing unusual');
      }
      hyps.push({ name: 'phone knocked over', strength: st, because: why.join('; ') });
    }
  }
  // 2b. The phone's sound model recognised it as something harmless.
  const benign = ctx.reports.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  const anyThud = ctx.reports.some(thudSound);
  // A harmless sound only explains everything if no phone saw a body drop and stay down.
  const bodyDown = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.stillAfter >= 0.8 && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  if (benign.length && !anyThud) {
    const r = benign.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
    hyps.push({
      name: 'an everyday sound',
      strength: bodyDown ? 0.3 : 0.75,
      because: `the sound model on ${r.name} heard ${aiWords(r)}, not a body hitting the floor${bodyDown ? ', though that does not explain why they stopped moving' : ''}`,
    });
  }
  // 2c. A tap or knock right next to one phone: loud there, silent everywhere else, nobody falling.
  const loudOne = ctx.reports.filter((r) => (r.sound.impactDb ?? -99) >= 15);
  if (loudOne.length === 1 && ctx.reports.length >= 2 && !ctx.reports.some(claimsBody)) {
    const r = loudOne[0];
    const quiet = ctx.reports.filter((o) => o !== r && o.sound.impactDb === null);
    if (quiet.length === ctx.reports.length - 1) {
      hyps.push({ name: 'a sound right next to one phone', strength: 0.7, because: `${r.name} heard ${db(r.sound.impactDb)} and ${quiet.map((o) => o.name).join(' and ')} heard nothing, so it happened right at ${r.name}` });
    }
  }
  // 2d. TV or music was playing.
  const mediaR = rs.filter((r) => (r.sound.media ?? 0) >= 0.4);
  if (mediaR.length && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({
      name: 'the TV',
      strength: 0.5 + (rs.some((r) => r.sound.impactAi?.group === 'media') ? 0.2 : 0),
      because: `${mediaR[0].name}'s sound model says TV or music has been playing (${Math.round((mediaR[0].sound.media ?? 0) * 100)}% of the last 12 s), and no phone watching the person saw a fall`,
    });
  }
  // 2e. The room map: the loudness pattern points at the TV, or they ended up on the sofa.
  const m = ctx.context;
  // A TV can only make a bang if it is on: the sound model must have heard TV or music
  // (or not be running at all, in which case we cannot tell).
  const modelRunning = ctx.reports.some((r) => r.sound.media !== null);
  const tvOn = !modelRunning || ctx.reports.some((r) => (r.sound.media ?? 0) >= 0.3 || r.sound.impactAi?.group === 'media');
  if (tvOn && m?.source && (m.source.kind === 'tv' || m.source.kind === 'speaker') && (!m.personFit || m.personFit.errDb - m.source.errDb >= 3)) {
    hyps.push({ name: `the ${m.source.name}`, strength: 0.8, because: `the room map says the bang came from the ${m.source.name}: ${m.notes.find((n) => n.includes('loud')) ?? m.notes[0]}` });
  } else if (tvOn && m?.loudestNear && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({ name: 'the TV', strength: 0.65, because: m.notes.find((n) => n.includes('sits')) ?? 'the loudest phone sits by the TV' });
  }
  if (m?.source?.kind === 'phone' && !ctx.reports.some(claimsBody)) {
    hyps.push({ name: 'a sound right next to one phone', strength: 0.7, because: `the loudness pattern puts the sound ${m.source.name}` });
  }
  if (m?.endedAt && kindInfo(m.endedAt.place.kind).rest && !ctx.reports.some(thudSound) && !ctx.reports.some((r) => r.sound.distress)) {
    // Being at the sofa only explains the stillness if they also look awake (shifting around).
    const awake = watchers.some((r) => r.sonar.firstMoveAfter !== null);
    const sure = m.endedAt.phones >= 2 || m.endedAt.offBy <= 0.2;
    const quiet = !ctx.reports.some((r) => dangerImpact(r, 12));
    hyps.push({
      name: `resting on the ${m.endedAt.place.name}`,
      strength: (awake ? 0.7 : quiet ? 0.62 : 0.4) + (m.usualRest ? 0.1 : 0) - (sure ? 0 : 0.15),
      because: `the room map puts them at the ${m.endedAt.place.name} afterwards, a place people sit or lie down${awake ? ', and they shifted around after' : ''}`,
    });
  }
  // 3. They moved normally afterwards.
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    hyps.push({ name: 'moving normally', strength: 0.7, because: `${resumed.map((r) => r.name).join(' and ')} saw them moving normally a few seconds later` });
  }
  // 4. Sat or lay down quickly: fast motion, no bang, resting at about the same spot.
  const anyImpact = rs.some((r) => heardImpact(r, 10));
  const sat = watchers.filter((r) => r.sonar.burstDb >= 16 && r.sonar.presentAfter && !anyImpact);
  if (sat.length) {
    const r = sat[0];
    const shift = rangeShift(r);
    const shifted = r.sonar.firstMoveAfter !== null;
    hyps.push({
      name: 'sat down quickly',
      strength: (shift !== null && shift < 0.35 ? 0.45 : 0.25) + (shifted ? 0.2 : -0.15),
      because: `fast motion with no impact sound, then resting ${shift !== null && shift < 0.35 ? 'at the same distance' : 'nearby'} on ${r.name}${shifted ? `, and shifting position ${r.sonar.firstMoveAfter!.toFixed(0)} s later` : ''}`,
    });
  }
  // 4b. Conscious and settling: small movements after the event, no walking yet.
  const settled = watchers.filter((r) => r.sonar.presentAfter && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  if (settled.length && !sat.length) {
    const same = (rangeShift(settled[0]) ?? 9) < 0.25;
    hyps.push({
      name: same ? 'fine, still standing where they were' : 'conscious and moving',
      strength: same ? 0.62 : 0.5,
      because: `${settled[0].name} saw them shift position ${settled[0].sonar.firstMoveAfter!.toFixed(0)} s later, which an unconscious person does not do`,
    });
  }
  // 5. Still standing or sitting where they were: a fall moves the body.
  const measured = watchers.filter((r) => r.sonar.presentAfter && rangeShift(r) !== null);
  if (measured.length && measured.every((r) => rangeShift(r)! < 0.25) && !resumed.length) {
    hyps.push({
      name: 'still in the same spot',
      strength: measured.length >= 2 ? 0.45 : 0.35,
      because: `${measured.map((r) => `${r.name} shows them at ${r.sonar.rangeAfter!.toFixed(1)} m, same as before`).join('; ')}; a fall usually moves the body`,
    });
  }
  // 6. Only untrusted phones are raising the alarm (round 2, after the Auditor spoke).
  if (trust) {
    const bad = ctx.reports.filter((r) => w(trust, r) < 0.5 && (r.localVerdict !== 'none' || sonarBurst(r) || heardImpact(r, 20)));
    const goodDanger = rs.some((r) => r.localVerdict !== 'none' || sonarBurst(r) || heardImpact(r, 20));
    if (bad.length && !goodDanger) {
      hyps.push({ name: 'bad data', strength: 0.85, because: `the only alarming report comes from ${bad.map((r) => r.name).join(', ')}, which the Auditor showed contradicts the others` });
    }
  }
  // 7. Learned: the same sound on the same phone around this time of day was fine before.
  const before = knownHarmless(ctx.memory, ctx.reports, ctx.incident.t0);
  if (before.length >= 2 && !bodyDown && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress)) {
    hyps.push({
      name: 'a known everyday sound in this home',
      strength: Math.min(0.66, 0.42 + 0.06 * before.length),
      because: `${before.length} earlier incidents like this (same sound, loudest on the same phone, same time of day) turned out fine when someone answered`,
    });
  }
  // 6. A single sharp sound with nothing else at all.
  if (!hyps.length && heard.length && !rs.some(sonarBurst) && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress) && !rs.some(thudSound)) {
    hyps.push({ name: 'dropped object', strength: 0.4, because: 'a bang with no body motion on any sonar' });
  }

  hyps.sort((a, b) => b.strength - a.strength);
  let best = hyps[0];
  if (ctx.round === 2 && best) {
    const au = ctx.prior.find((p) => p.agent === 'auditor');
    if (au?.stance === 'escalate' && best.strength < 0.7) best = { ...best, strength: best.strength - 0.15 };
  }
  const points = hyps.map((h) => `${h.name}: ${h.because}`);
  if (ctx.incident.trigger.kind === 'help_pressed') {
    return position(ctx, 'skeptic', 'escalate', 0.9, 'A person asking for help is not something I argue with.', points);
  }
  const brief = (h: Hypothesis) => h.because.split('; ').slice(0, 2).join(', and ');
  if (best && best.strength >= 0.55) {
    return position(ctx, 'skeptic', 'stand_down', best.strength, `I think it was ${best.name}. ${cap(brief(best))}.`, points);
  }
  const strong = rs.some(fullSignature) || rs.some((r) => r.sound.screamDb !== null || r.sound.distress);
  const conflict = ctx.prior.find((p) => p.conflict)?.conflict;
  if (conflict && (!best || best.strength < 0.55)) {
    return position(ctx, 'skeptic', 'uncertain', 0.5, 'I cannot explain this, but the phones disagree with each other, so I would not trust either story without asking.', points);
  }
  if (!best && strong) {
    return position(ctx, 'skeptic', 'escalate', 0.6, 'I tried to explain this away and could not. Every phone tells the same story.', ['no harmless explanation fits']);
  }
  if (best && best.strength >= 0.35) {
    return position(ctx, 'skeptic', 'uncertain', 0.5, `Maybe ${best.name}, but I am not sure. ${cap(brief(best))}.`, points);
  }
  return position(ctx, 'skeptic', strong ? 'escalate' : 'uncertain', 0.45, strong ? 'Nothing harmless fits well enough.' : 'There is too little here to explain either way.', points);
}

export const ROLES: Record<RoleName, (ctx: DeliberationContext) => Position> = { responder, skeptic, auditor };

/** Short descriptions used by the console and by the agent directory card. */
export const ROLE_INFO: Record<AgentName, { title: string; goal: string }> = {
  investigator: { title: 'Investigator', goal: 'Called in only when the others cannot agree. Goes and looks: asks phones to look again, checks the room map and the home history, then casts the deciding vote.' },
  responder: { title: 'Responder', goal: 'Never let a real fall go unanswered. Argues for getting help.' },
  skeptic: { title: 'Skeptic', goal: 'Prevent false alarms. Looks for a harmless explanation that fits every measurement.' },
  auditor: { title: 'Auditor', goal: 'Trust no phone by default. Checks every report against physics and the other phones.' },
};
