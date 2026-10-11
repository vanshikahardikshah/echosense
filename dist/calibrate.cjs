"use strict";

// tools/calibrate.ts
var import_node_fs = require("node:fs");

// src/agents/phoneAgent.ts
var WINDOW = {
  before: [-4500, -400],
  around: [-2e3, 1500],
  after: [1500, 11500],
  sound: [-2500, 2500],
  media: [-12e3, -500]
};
var GATHER_MS = WINDOW.after[1] + 300;
var seq = 0;
function uid(prefix) {
  seq = (seq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}

// src/agents/cartographer.ts
var PLACE_KINDS = [
  { kind: "tv", label: "TV", rest: false, source: true },
  { kind: "speaker", label: "Speaker or radio", rest: false, source: true },
  { kind: "sofa", label: "Sofa", rest: true, source: false },
  { kind: "chair", label: "Chair", rest: true, source: false },
  { kind: "bed", label: "Bed", rest: true, source: false },
  { kind: "desk", label: "Desk", rest: true, source: false },
  { kind: "kitchen", label: "Kitchen", rest: false, source: false },
  { kind: "bathroom", label: "Bathroom", rest: false, source: false },
  { kind: "door", label: "Door", rest: false, source: false },
  { kind: "stairs", label: "Stairs", rest: false, source: false },
  { kind: "other", label: "Other", rest: false, source: false }
];
var BIN = 0.1;
var BINS = 40;
function isUsualRest(map, phone, range) {
  const h = map.resting[phone];
  if (!h) return 0;
  const b = Math.round(range / BIN);
  let n = 0;
  for (let k = b - 2; k <= b + 2; k++) if (k >= 0 && k < BINS) n += h[k];
  return n;
}
function fit(levels, dist, name, kind) {
  const pts = levels.filter((l) => dist[l.id] !== void 0).map((l) => ({ db: l.db, att: 20 * Math.log10(Math.max(dist[l.id], 0.25)) }));
  if (pts.length < 3) return null;
  const l0 = pts.reduce((a, p) => a + p.db + p.att, 0) / pts.length;
  const err = Math.sqrt(pts.reduce((a, p) => a + (p.db + p.att - l0) ** 2, 0) / pts.length);
  return { name, kind, errDb: err, phones: pts.length };
}
function cartograph(map, reports) {
  const notes = [];
  const heard = reports.filter((r) => r.sound.impactDb !== null);
  const levels = reports.filter((r) => r.samples >= 10).map((r) => ({ id: r.nodeId, db: r.sound.impactDb ?? 4 }));
  const fits = [];
  for (const p of map.places) {
    const f = fit(levels, p.ranges, p.name, p.kind);
    if (f) fits.push(f);
  }
  const person = {};
  for (const r of reports) {
    const d = r.sonar.rangeAfter ?? r.sonar.rangeBefore;
    if (d !== null && r.sonar.online) person[r.nodeId] = d;
  }
  const personFit = fit(levels, person, "where the person is", "person");
  if (personFit) fits.push(personFit);
  for (const r of heard) {
    const others = levels.filter((l) => l.id !== r.nodeId);
    if (!others.length) continue;
    const margin = (r.sound.impactDb ?? 0) - Math.max(...others.map((o) => o.db));
    if (margin >= 12) fits.push({ name: `right at ${r.name}`, kind: "phone", errDb: Math.max(0, 6 - margin / 4), phones: levels.length });
  }
  const loudestPhone = [...heard].sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  if (loudestPhone && !fits.some((f) => f.kind !== "phone")) {
    const others = levels.filter((l) => l.id !== loudestPhone.nodeId);
    const margin = (loudestPhone.sound.impactDb ?? 0) - Math.max(-99, ...others.map((o) => o.db));
    const nearest = map.places.map((p) => ({ p, d: p.ranges[loudestPhone.nodeId] })).filter((x) => x.d !== void 0 && x.d <= 1.5).sort((a, b) => a.d - b.d)[0];
    const personHere = person[loudestPhone.nodeId];
    if (nearest && margin >= 4 && (personHere === void 0 || personHere > nearest.d + 0.8)) {
      fits.push({ name: nearest.p.name, kind: nearest.p.kind, errDb: 1, phones: levels.length });
      notes.push(`the bang was loudest on ${loudestPhone.name}, ${nearest.d.toFixed(1)} m from the ${nearest.p.name}${personHere !== void 0 ? ` and ${personHere.toFixed(1)} m from the person` : ""}`);
    }
  }
  fits.sort((a, b) => a.errDb - b.errDb);
  const source = heard.length && fits.length ? fits[0] : null;
  if (source && personFit && source !== personFit) {
    notes.push(`the loudness pattern fits ${source.name} (off by ${source.errDb.toFixed(1)} dB) better than where the person is (off by ${personFit.errDb.toFixed(1)} dB)`);
  } else if (source && source === personFit) {
    notes.push(`the loudness pattern fits where the person is (off by ${source.errDb.toFixed(1)} dB)`);
  }
  let loudestNear = null;
  const loudest = heard.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  const lab = loudest ? map.phones[loudest.nodeId] : void 0;
  if (loudest && lab?.near && (lab.near === "tv" || lab.near === "speaker")) {
    loudestNear = { phone: loudest.name, near: lab.near, label: lab.label };
    if (!notes.some((n) => n.startsWith(`the bang was loudest on ${loudest.name}`))) notes.push(`the bang was loudest on ${loudest.name}, which sits ${lab.label || `by the ${lab.near}`}`);
  }
  let endedAt = null;
  for (const p of map.places) {
    const common = Object.keys(person).filter((id) => p.ranges[id] !== void 0);
    if (!common.length) continue;
    const off = Math.max(...common.map((id) => Math.abs(person[id] - p.ranges[id])));
    if (off <= 0.4 && (!endedAt || off < endedAt.offBy || common.length > endedAt.phones)) endedAt = { place: p, offBy: off, phones: common.length };
  }
  if (endedAt) notes.push(`they ended up at the ${endedAt.place.name} (within ${(endedAt.offBy * 100).toFixed(0)} cm on ${endedAt.phones} phone${endedAt.phones > 1 ? "s" : ""})`);
  else if (Object.keys(person).length && map.places.length) notes.push("they ended up away from every marked place");
  const usualRest = Object.entries(person).some(([id, d]) => isUsualRest(map, id, d) >= 5);
  if (usualRest && !endedAt) notes.push("they stopped at a spot where someone often rests");
  if (!notes.length) notes.push(map.places.length ? "nothing in the room map bears on this" : "no room map yet: mark the TV and the sofa on the console");
  return { notes, source, personFit, endedAt, usualRest, loudestNear };
}
function kindInfo(k) {
  return PLACE_KINDS.find((p) => p.kind === k) ?? PLACE_KINDS[PLACE_KINDS.length - 1];
}

// src/agents/memory.ts
function learnedTrust(mem, nodeId) {
  const p = mem?.phones[nodeId];
  if (!p || p.falseAlarms < 3) return null;
  const ratio = p.falseAlarms / Math.max(1, p.falseAlarms + p.confirmed);
  if (ratio < 0.75) return null;
  return { factor: 0.8, reason: `${p.falseAlarms} of its last ${p.falseAlarms + p.confirmed} alarms turned out to be nothing` };
}
function knownHarmless(mem, reports, t0) {
  if (!mem) return [];
  const heard = reports.filter((r) => r.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0));
  const loud = heard[0];
  if (!loud) return [];
  const hour = new Date(t0).getHours();
  const label = loud.sound.impactAi?.label ?? null;
  return mem.incidents.filter(
    (r) => !r.simulated && r.human === "ok" && r.loudest === loud.nodeId && Math.min(Math.abs(r.hour - hour), 24 - Math.abs(r.hour - hour)) <= 1 && (label === null || r.sound === label)
  );
}
function summarize(mem, names, reports, t0) {
  if (!mem || !mem.incidents.some((r) => !r.simulated)) return { note: "No history yet in this home." };
  const real = mem.incidents.filter((r) => !r.simulated);
  const recent = real.slice(-8).map((r) => ({
    when: new Date(r.t).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" }),
    trigger: r.trigger,
    sound: r.sound,
    decided: r.outcome,
    person_said: r.human ?? "nobody was asked",
    place: r.place
  }));
  const phones = Object.fromEntries(Object.entries(mem.phones).map(([id, p]) => [names[id] ?? id, p]));
  const similar = knownHarmless(mem, reports, t0);
  return {
    incidents_remembered: real.length,
    recent,
    phone_alarm_record: phones,
    similar_past_incidents_that_were_fine: similar.length,
    pattern: similar.length >= 2 ? `${similar.length} earlier incidents like this (same sound, same phone, same time of day) were fine` : null
  };
}

// src/agents/roles.ts
var BURST = 20;
function phoneMovedItself(r) {
  return r.imu.moved || r.imu.dropped || r.sonar.roomChangeDb >= 15;
}
function heardImpact(r, min = 10) {
  return r.sound.impactDb !== null && r.sound.impactDb >= min && !r.sound.impactRepetitive;
}
var HARMLESS = ["tap", "speech", "media", "footsteps"];
function harmlessSound(r) {
  const a = r.sound.impactAi;
  const bodyMoved = r.sonar.online && r.sonar.burstDb >= 16 && !phoneMovedItself(r);
  return !!a && a.score >= 0.3 && (HARMLESS.includes(a.group) || a.group === "object") && !bodyMoved;
}
function thudSound(r) {
  return !!r.sound.impactAi && r.sound.impactAi.group === "thud" && r.sound.impactAi.score >= 0.3;
}
function dangerImpact(r, min = 10) {
  return heardImpact(r, min) && !harmlessSound(r);
}
function claimsBody(r) {
  return sonarBurst(r) || r.localVerdict !== "none";
}
function aiWords(r) {
  const a = r.sound.impactAi;
  return a ? `${a.label} ${Math.round(a.score * 100)}%` : "";
}
function watched(r) {
  return r.sonar.online && r.sonar.sawPersonBefore && !phoneMovedItself(r);
}
function sonarBurst(r) {
  return r.sonar.online && r.sonar.burstDb >= BURST && !phoneMovedItself(r);
}
function rangeShift(r) {
  return r.sonar.rangeBefore !== null && r.sonar.rangeAfter !== null ? Math.abs(r.sonar.rangeAfter - r.sonar.rangeBefore) : null;
}
function fullSignature(r) {
  return watched(r) && sonarBurst(r) && dangerImpact(r) && r.sonar.stillAfter >= 0.8 && !r.sonar.motionResumed;
}
function colocated(rs) {
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const watchers = rs.filter(watched);
  if (heard.length < 2 || !watchers.length) return true;
  const loudest = heard.reduce((m, r) => r.sound.impactDb > m.sound.impactDb ? r : m);
  if (watchers.includes(loudest)) return true;
  return !watchers.every((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb - 6);
}
function cap(x) {
  return x ? x[0].toUpperCase() + x.slice(1) : x;
}
function db(x) {
  return x === null ? "nothing" : `${x.toFixed(0)} dB`;
}
function trustOf(ctx) {
  return ctx.prior.find((p) => p.agent === "auditor")?.trust ?? null;
}
function w(trust, r) {
  return trust?.[r.nodeId]?.score ?? 1;
}
function fingerprint(r) {
  const s = r.sonar;
  return [r.nodeId, r.sound.impactDb?.toFixed(2), s.burstDb.toFixed(2), s.stillAfter.toFixed(3), s.rangeBefore?.toFixed(3), s.rangeAfter?.toFixed(3), r.samples].join("|");
}
function position(ctx, agent, stance, confidence, argument, points, trust) {
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
    postedAt: ctx.now
  };
}
function auditor(ctx) {
  const rs = ctx.reports;
  const trust = {};
  const quarantine = [];
  const healthy = (r) => r.samples >= 10 && r.silenceMs <= 3e3;
  const acoustic = /* @__PURE__ */ new Map();
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
    const reasons = [];
    const others = rs.filter((o) => o !== r && healthy(o));
    if (!healthy(r)) {
      score *= 0.5;
      reasons.push(r.samples < 10 ? `streamed only ${r.samples} samples around the incident` : `was silent for ${(r.silenceMs / 1e3).toFixed(0)} s before it`);
    }
    if (ctx.seenFingerprints.has(fingerprint(r))) {
      score *= 0.1;
      reasons.push("sent a report identical to an earlier incident (replayed)");
    }
    const moved = phoneMovedItself(r);
    if (moved) {
      reasons.push(
        r.imu.dropped || r.imu.moved ? "its own motion sensor says the phone moved, so its sonar describes the phone, not the room" : `its room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB at once, so the phone itself moved`
      );
    }
    const loud = r.sound.impactDb !== null && r.sound.impactDb >= 20;
    const othersHeard = others.filter((o) => heardImpact(o, 5));
    if (loud && others.length >= 1 && othersHeard.length === 0 && !moved && !claimsBody(r)) {
      reasons.push(`heard a ${db(r.sound.impactDb)} sound right next to it that the others did not: something near this phone, not a fall`);
    } else if (loud && others.length >= 2 && othersHeard.length === 0 && !moved) {
      score *= 0.25;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact and a fall that ${others.map((o) => o.name).join(" and ")} did not hear at all`);
    } else if (loud && others.length === 1 && othersHeard.length === 0 && !moved) {
      score *= 0.6;
      reasons.push(`claims a ${db(r.sound.impactDb)} impact nobody else confirms`);
    }
    const loudOthers = others.filter((o) => heardImpact(o, 15));
    if (r.sound.impactDb === null && healthy(r) && loudOthers.length >= 2) {
      const claimsFine = watched(r) && (r.sonar.motionResumed || r.sonar.presentAfter && r.sonar.burstDb < 16);
      if (claimsFine) {
        score *= 0.25;
        reasons.push(`heard nothing and claims the person carried on normally, while ${loudOthers.map((o) => `${o.name} (${db(o.sound.impactDb)})`).join(" and ")} heard an impact`);
      } else {
        score *= 0.65;
        reasons.push(`did not hear the impact ${loudOthers.map((o) => o.name).join(" and ")} heard: low observability for this event (distance, obstruction or orientation), not evidence either way`);
      }
    } else if (r.sound.impactDb === null && healthy(r) && loudOthers.length === 1 && others.length === 1) {
      score *= 0.7;
      reasons.push(`heard nothing while ${loudOthers[0].name} heard ${db(loudOthers[0].sound.impactDb)}`);
    }
    if (sonarBurst(r)) {
      const calm = others.filter(
        (o) => (acoustic.get(o.nodeId) ?? 1) >= 0.5 && watched(o) && o.sonar.burstDb < 16 && (o.sonar.motionResumed || o.sonar.presentAfter)
      );
      if (calm.length) {
        score *= 0.5;
        reasons.push(`its burst is contradicted by ${calm.map((o) => o.name).join(" and ")}, which watched the person move normally`);
      }
    }
    if (r.localVerdict === "fall" && !(sonarBurst(r) || moved) && !heardImpact(r)) {
      score *= 0.3;
      reasons.push("its fall verdict does not follow from its own measurements");
    }
    const learned = learnedTrust(ctx.memory, r.nodeId);
    if (learned && r.localVerdict !== "none") {
      score *= learned.factor;
      reasons.push(`learned from earlier answers: ${learned.reason}`);
    }
    if (!reasons.length) reasons.push("consistent with the other phones");
    trust[r.nodeId] = { score: Math.max(0.02, score), reasons };
    if (score < 0.3 && !moved) quarantine.push(r.name);
  }
  let conflict;
  const healthyRs = rs.filter(healthy);
  for (const a of healthyRs) {
    for (const b of healthyRs) {
      if (a === b) continue;
      const deafB = (a.sound.impactDb ?? 0) >= 20 && b.sound.impactDb === null && !phoneMovedItself(a) && !harmlessSound(a);
      const calmB = sonarBurst(a) && watched(b) && b.sonar.burstDb < 16 && (b.sonar.motionResumed || b.sonar.presentAfter);
      if (!deafB && !calmB) continue;
      const third = healthyRs.filter((c) => c !== a && c !== b);
      const tieBreak = third.some((c) => deafB && c.sound.impactDb !== null !== (b.sound.impactDb !== null) || calmB && watched(c));
      const sideWithB = third.some((c) => deafB && c.sound.impactDb === null);
      if (!tieBreak && !sideWithB && (claimsBody(a) || claimsBody(b))) {
        conflict = `${a.name} and ${b.name} tell opposite stories (${deafB ? `${a.name} heard ${db(a.sound.impactDb)}, ${b.name} heard nothing` : `${a.name} saw a sudden movement, ${b.name} saw them moving normally`}) and no other phone can break the tie`;
      }
    }
  }
  const good = rs.filter((r) => trust[r.nodeId].score >= 0.5);
  const bad = rs.filter((r) => trust[r.nodeId].score < 0.5);
  const mapSays = ctx.context?.source;
  const together = colocated(good) && !(mapSays && mapSays.kind !== "person" && ctx.context?.personFit && ctx.context.personFit.errDb - mapSays.errDb >= 3);
  const sonarCh = good.filter(
    (r) => watched(r) && sonarBurst(r) && r.sonar.stillAfter >= 0.8 && !r.sonar.motionResumed && (heardImpact(r, 10) && together || (rangeShift(r) ?? 0) >= 0.35)
  );
  const restSpot = ctx.context?.endedAt && kindInfo(ctx.context.endedAt.place.kind).rest && (ctx.context.endedAt.phones >= 2 || ctx.context.endedAt.offBy <= 0.2);
  const motionless = !(restSpot && !good.some((r) => dangerImpact(r, 12))) && good.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.presentAfter && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  const audioCh = together ? good.filter((r) => dangerImpact(r, 12)) : [];
  const scream = good.some((r) => r.sound.screamDb !== null || r.sound.distress);
  const vanished = good.some((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10) && !good.some((r) => r.sonar.presentAfter || r.sonar.motionResumed) && good.some((r) => dangerImpact(r, 15));
  const danger = (r) => r.localVerdict !== "none" || sonarBurst(r) || dangerImpact(r, 20) || r.sound.distress;
  const points = [];
  for (const r of rs) {
    const t = trust[r.nodeId];
    points.push(`${r.name}: trust ${(t.score * 100).toFixed(0)}%, ${t.reasons.join("; ")}`);
  }
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "auditor", "escalate", 0.95, "The person asked for help on the phone. That is first hand and needs no corroboration.", points, trust);
  }
  if (conflict) {
    const p = position(ctx, "auditor", "uncertain", 0.6, `${conflict[0].toUpperCase()}${conflict.slice(1)}. One of them is wrong, and only the person can settle it.`, points, trust);
    p.conflict = conflict;
    return p;
  }
  if (bad.some(danger) && !good.some(danger)) {
    const names = bad.filter(danger).map((r) => r.name).join(" and ");
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.85,
      `The alarm rests on ${names} alone, and ${names} contradicts the other phones. I would not act on it${quarantine.length ? `, and I am flagging ${quarantine.join(", ")} as untrustworthy` : ""}.`,
      points,
      trust
    );
  }
  if (!together) points.push("the impact was loudest far from the person, so the sound and the movement are separate events");
  if (restSpot) points.push(`the room map puts them at the ${ctx.context.endedAt.place.name}`);
  const harmless = rs.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  if (harmless.length) points.push(`sound model on ${harmless.map((r) => `${r.name}: ${aiWords(r)}`).join(", ")}`);
  const channels = (sonarCh.length ? 1 : motionless ? 1 : 0) + (sonarCh.length >= 2 ? 1 : 0) + (audioCh.length ? 1 : 0) + (scream ? 1 : 0) + (vanished ? 1 : 0);
  const thudHeard = audioCh.some(thudSound);
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished && thudHeard) {
    return position(ctx, "auditor", "uncertain", 0.5, `Only sound so far, but the sound model calls it ${aiWords(audioCh.find(thudSound))}. Worth asking.`, points, trust);
  }
  if (channels === 1 && audioCh.length && !sonarCh.length && !motionless && !scream && !vanished) {
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.55,
      "A sound on its own, with no sign of anyone moving or falling, is not enough to bother anyone.",
      points,
      trust
    );
  }
  if (channels === 0 && (good.some(danger) || !together)) {
    return position(
      ctx,
      "auditor",
      "stand_down",
      0.65,
      together ? "The measurements are real, but none of them is a fall pattern: no impact where the person is, no move to the floor, and they moved again afterwards." : "The phones are honest, but the bang came from where nobody is, and the movement near the person ended where it started.",
      points,
      trust
    );
  }
  if (channels >= 2 && !sonarCh.length && !scream && !vanished) {
    return position(ctx, "auditor", "uncertain", 0.5, "Two weak signs line up (a bang and stillness at the same spot), but nothing shows a fall for certain. Ask them.", points, trust);
  }
  if (channels >= 2) {
    const parts = [
      sonarCh.length ? `sonar on ${sonarCh.map((r) => r.name).join(" and ")}` : "",
      audioCh.length ? `the impact heard by ${audioCh.length} phone${audioCh.length > 1 ? "s" : ""}` : "",
      scream ? "someone in distress" : "",
      vanished ? (() => {
        const seer = good.filter((r) => r.sonar.lastSeenAgo !== null).sort((a, b) => a.sonar.lastSeenAgo - b.sonar.lastSeenAgo)[0];
        const blind = good.filter((r) => !r.sonar.online).map((r) => r.name);
        return `${seer.name} last saw the person ${seer.sonar.lastSeenAgo.toFixed(0)} s before the bang and nobody since${blind.length ? ` (${blind.join(" and ")} had no working sonar)` : ""}`;
      })() : ""
    ].filter(Boolean);
    return position(ctx, "auditor", "escalate", 0.7, `The evidence checks out: ${parts.join(" and ")} line up in time, from phones that agree with each other.`, points, trust);
  }
  if (!good.some(danger)) {
    return position(ctx, "auditor", "stand_down", 0.6, "No trusted phone measured anything dangerous.", points, trust);
  }
  return position(ctx, "auditor", "uncertain", 0.5, "The reports are honest but thin: only one kind of evidence, so I cannot confirm it either way.", points, trust);
}
function responder(ctx) {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const ignored = ctx.reports.filter((r) => w(trust, r) < 0.5);
  const points = [];
  let s = 0;
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "responder", "escalate", 0.97, "They pressed Get help. Call now.", ["help requested on the phone"]);
  }
  const full = rs.filter(fullSignature);
  if (full.length) {
    const r = full[0];
    s += 0.6;
    points.push(
      `${r.name} watched the person: ${r.sonar.burstDb.toFixed(0)} dB burst, impact ${db(r.sound.impactDb)}, then ${(r.sonar.stillAfter * 100).toFixed(0)}% still afterwards`
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
        points.push(`${r.name} saw the body move from ${r.sonar.rangeBefore.toFixed(1)} m to ${r.sonar.rangeAfter.toFixed(1)} m and stay there`);
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
    points.push(`the sound model called it ${harmless.map(aiWords).join(", ")}`);
  }
  if (heard.length && !full.length) {
    s += 0.15;
    points.push(`impact heard by ${heard.map((r) => `${r.name} (${db(r.sound.impactDb)})`).join(", ")}`);
  }
  if (heard.length >= 2 && rs.some((r) => sonarBurst(r) && watched(r))) {
    s += 0.1;
    points.push("the impact and the body motion happened together");
  }
  const scream = rs.filter((r) => r.sound.screamDb !== null);
  if (scream.length) {
    s += 0.25;
    points.push(`scream heard by ${scream.map((r) => r.name).join(", ")}`);
  }
  const anyWatching = rs.some((r) => watched(r) || r.sonar.online && r.sonar.presentAfter);
  const recently = rs.filter((r) => r.sonar.lastSeenAgo !== null && r.sonar.lastSeenAgo <= 10).sort((a, b) => a.sonar.lastSeenAgo - b.sonar.lastSeenAgo)[0];
  if (!anyWatching && recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15)) {
    s += 0.3;
    points.push(`${recently.name} saw them moving ${recently.sonar.lastSeenAgo.toFixed(0)} s before a heavy bang, and now no phone can see them`);
  }
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    s -= 0.45;
    points.push(`${resumed.map((r) => r.name).join(" and ")} saw normal movement afterwards`);
  }
  if (ignored.length) points.push(`not counting ${ignored.map((r) => r.name).join(", ")} (the Auditor does not trust ${ignored.length > 1 ? "them" : "it"})`);
  if (ctx.round === 2) {
    const sk2 = ctx.prior.find((p) => p.agent === "skeptic");
    const au = ctx.prior.find((p) => p.agent === "auditor");
    if (au?.stance === "stand_down") s -= 0.3;
    if (au?.stance === "escalate") s += 0.1;
    if (sk2?.stance === "stand_down") {
      s -= 0.3 * sk2.confidence;
      if (sk2.confidence >= 0.7) points.push(`the Skeptic's explanation fits the data: ${sk2.points[0] ?? sk2.argument}`);
    }
  }
  const m = ctx.context;
  if (m?.endedAt && !kindInfo(m.endedAt.place.kind).rest && rs.some((r) => watched(r) && r.sonar.burstDb >= 16)) {
    s += 0.1;
    points.push(`they ended up at the ${m.endedAt.place.name}, not somewhere people sit or lie down`);
  }
  if (m?.source?.kind === "person" && heard.length >= 2) {
    s += 0.1;
    points.push("the room map puts the bang right where the person is");
  }
  const awake = rs.filter((r) => watched(r) && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  const talking = rs.some((r) => r.sound.voiceAfter && r.sound.mediaEventsBefore < 3);
  if (s >= 0.55 && (awake.length || talking) && !scream.length) {
    points.push(awake.length ? `${awake[0].name} saw them move ${awake[0].sonar.firstMoveAfter.toFixed(0)} s later, so they are awake` : "someone is talking");
    return position(ctx, "responder", "uncertain", 0.6, `This could be a fall, but they are awake and moving. Ask them first and call if they do not answer.`, points);
  }
  const shifted = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && (rangeShift(r) ?? 0) >= 0.35 && !r.sonar.motionResumed);
  const vanishedNow = !anyWatching && !!recently && heard.some((r) => (r.sound.impactDb ?? 0) >= 15);
  const clear = full.length > 0 || shifted || !!distress || scream.length > 0 || vanishedNow || rs.some((r) => thudSound(r) && sonarBurst(r) && watched(r));
  if (s >= 0.55 && !clear) {
    return position(ctx, "responder", "uncertain", 0.6, `This might be a fall, but nothing is certain yet. ${points[0] ?? ""}. Ask them now, and call if they do not answer.`, points);
  }
  if (s >= 0.55) {
    return position(ctx, "responder", "escalate", s, `This looks like a real fall. ${points[0] ?? ""}. I want someone called now.`, points);
  }
  if (s >= 0.25) {
    return position(ctx, "responder", "uncertain", 0.5, `Something happened and I cannot rule out that they are hurt. ${points[0] ?? ""}. Ask them.`, points);
  }
  const sk = ctx.prior.find((p) => p.agent === "skeptic");
  const convinced = ctx.round === 2 && sk?.stance === "stand_down" && sk.confidence >= 0.7;
  const because = convinced ? `I accept the Skeptic's explanation: ${(sk.points[0] ?? sk.argument).split(":")[0]}.` : resumed.length ? `${resumed.map((r) => r.name).join(" and ")} saw them moving normally afterwards.` : ignored.length && !rs.some((r) => r.localVerdict !== "none" || sonarBurst(r)) ? `The only alarm comes from ${ignored.map((r) => r.name).join(", ")}, and I do not trust it.` : points.length ? "What the phones measured does not add up to someone hurt." : "No sign that anyone is hurt.";
  return position(ctx, "responder", "stand_down", Math.min(0.9, 0.6 - s), `Nothing here needs a caregiver. ${because}`, points);
}
function skeptic(ctx) {
  const trust = trustOf(ctx);
  const rs = ctx.reports.filter((r) => w(trust, r) >= 0.5);
  const hyps = [];
  const heard = rs.filter((r) => r.sound.impactDb !== null);
  const loudest = heard.reduce((m2, r) => !m2 || r.sound.impactDb > m2.sound.impactDb ? r : m2, null);
  const watchers = rs.filter(watched);
  if (loudest && heard.length >= 2 && watchers.length && !watchers.includes(loudest)) {
    const quieter = watchers.filter((r) => (r.sound.impactDb ?? -99) <= loudest.sound.impactDb - 6);
    if (quieter.length === watchers.length) {
      let st = 0.45;
      const why = [`the impact was loudest on ${loudest.name} (${db(loudest.sound.impactDb)}), which could not see the person; ${quieter.map((r) => `${r.name} next to them heard ${db(r.sound.impactDb)}`).join(", ")}`];
      const media = rs.filter((r) => r.sound.mediaEventsBefore >= 3);
      if (media.length) {
        st += 0.15;
        why.push(`continuous voice or music before it (${media[0].sound.mediaEventsBefore} events on ${media[0].name})`);
      }
      const inPlace = watchers.filter((r) => r.sonar.presentAfter && (rangeShift(r) ?? 9) < 0.3);
      if (inPlace.length) {
        st += 0.25;
        why.push(`${inPlace[0].name} shows them at the same distance afterwards (${inPlace[0].sonar.rangeAfter.toFixed(1)} m), not on the floor`);
      }
      if (!watchers.some((r) => r.sonar.burstDb >= 24)) st += 0.1;
      hyps.push({ name: "sound from elsewhere", strength: st, because: why.join("; ") });
    }
  }
  for (const r of ctx.reports) {
    if (!phoneMovedItself(r) || r.sound.impactDb === null) continue;
    const others = ctx.reports.filter((o) => o !== r);
    const otherMax = others.reduce((m2, o) => Math.max(m2, o.sound.impactDb ?? -99), -99);
    if (r.sound.impactDb - otherMax >= 10) {
      let st = 0.7;
      const why = [`${r.name} heard the bang ${otherMax < -50 ? "and nobody else did" : `${(r.sound.impactDb - otherMax).toFixed(0)} dB louder than anyone`}`];
      why.push(r.imu.moved || r.imu.dropped ? `its accelerometer says it moved` : `its whole room echo changed ${r.sonar.roomChangeDb.toFixed(0)} dB`);
      if (rs.some((o) => o !== r && watched(o) && (o.sonar.motionResumed || o.sonar.burstDb < BURST))) {
        st += 0.15;
        why.push("the phones watching the person saw nothing unusual");
      }
      hyps.push({ name: "phone knocked over", strength: st, because: why.join("; ") });
    }
  }
  const benign = ctx.reports.filter((r) => heardImpact(r, 5) && harmlessSound(r));
  const anyThud = ctx.reports.some(thudSound);
  const bodyDown = rs.some((r) => watched(r) && r.sonar.burstDb >= 16 && r.sonar.stillAfter >= 0.8 && r.sonar.firstMoveAfter === null && !r.sonar.motionResumed);
  if (benign.length && !anyThud) {
    const r = benign.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
    hyps.push({
      name: "an everyday sound",
      strength: bodyDown ? 0.3 : 0.75,
      because: `the sound model on ${r.name} heard ${aiWords(r)}, not a body hitting the floor${bodyDown ? ", though that does not explain why they stopped moving" : ""}`
    });
  }
  const loudOne = ctx.reports.filter((r) => (r.sound.impactDb ?? -99) >= 15);
  if (loudOne.length === 1 && ctx.reports.length >= 2 && !ctx.reports.some(claimsBody)) {
    const r = loudOne[0];
    const quiet = ctx.reports.filter((o) => o !== r && o.sound.impactDb === null);
    if (quiet.length === ctx.reports.length - 1) {
      hyps.push({ name: "a sound right next to one phone", strength: 0.7, because: `${r.name} heard ${db(r.sound.impactDb)} and ${quiet.map((o) => o.name).join(" and ")} heard nothing, so it happened right at ${r.name}` });
    }
  }
  const mediaR = rs.filter((r) => (r.sound.media ?? 0) >= 0.4);
  if (mediaR.length && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({
      name: "the TV",
      strength: 0.5 + (rs.some((r) => r.sound.impactAi?.group === "media") ? 0.2 : 0),
      because: `${mediaR[0].name}'s sound model says TV or music has been playing (${Math.round((mediaR[0].sound.media ?? 0) * 100)}% of the last 12 s), and no phone watching the person saw a fall`
    });
  }
  const m = ctx.context;
  const modelRunning = ctx.reports.some((r) => r.sound.media !== null);
  const tvOn = !modelRunning || ctx.reports.some((r) => (r.sound.media ?? 0) >= 0.3 || r.sound.impactAi?.group === "media");
  if (tvOn && m?.source && (m.source.kind === "tv" || m.source.kind === "speaker") && (!m.personFit || m.personFit.errDb - m.source.errDb >= 3)) {
    hyps.push({ name: `the ${m.source.name}`, strength: 0.8, because: `the room map says the bang came from the ${m.source.name}: ${m.notes.find((n) => n.includes("loud")) ?? m.notes[0]}` });
  } else if (tvOn && m?.loudestNear && !watchers.some((r) => r.sonar.burstDb >= 24)) {
    hyps.push({ name: "the TV", strength: 0.65, because: m.notes.find((n) => n.includes("sits")) ?? "the loudest phone sits by the TV" });
  }
  if (m?.source?.kind === "phone" && !ctx.reports.some(claimsBody)) {
    hyps.push({ name: "a sound right next to one phone", strength: 0.7, because: `the loudness pattern puts the sound ${m.source.name}` });
  }
  if (m?.endedAt && kindInfo(m.endedAt.place.kind).rest && !ctx.reports.some(thudSound) && !ctx.reports.some((r) => r.sound.distress)) {
    const awake = watchers.some((r) => r.sonar.firstMoveAfter !== null);
    const sure = m.endedAt.phones >= 2 || m.endedAt.offBy <= 0.2;
    const quiet = !ctx.reports.some((r) => dangerImpact(r, 12));
    hyps.push({
      name: `resting on the ${m.endedAt.place.name}`,
      strength: (awake ? 0.7 : quiet ? 0.62 : 0.4) + (m.usualRest ? 0.1 : 0) - (sure ? 0 : 0.15),
      because: `the room map puts them at the ${m.endedAt.place.name} afterwards, a place people sit or lie down${awake ? ", and they shifted around after" : ""}`
    });
  }
  const resumed = rs.filter((r) => r.sonar.online && !phoneMovedItself(r) && r.sonar.motionResumed);
  if (resumed.length) {
    hyps.push({ name: "moving normally", strength: 0.7, because: `${resumed.map((r) => r.name).join(" and ")} saw them moving normally a few seconds later` });
  }
  const anyImpact = rs.some((r) => heardImpact(r, 10));
  const sat = watchers.filter((r) => r.sonar.burstDb >= 16 && r.sonar.presentAfter && !anyImpact);
  if (sat.length) {
    const r = sat[0];
    const shift = rangeShift(r);
    const shifted = r.sonar.firstMoveAfter !== null;
    hyps.push({
      name: "sat down quickly",
      strength: (shift !== null && shift < 0.35 ? 0.45 : 0.25) + (shifted ? 0.2 : -0.15),
      because: `fast motion with no impact sound, then resting ${shift !== null && shift < 0.35 ? "at the same distance" : "nearby"} on ${r.name}${shifted ? `, and shifting position ${r.sonar.firstMoveAfter.toFixed(0)} s later` : ""}`
    });
  }
  const settled = watchers.filter((r) => r.sonar.presentAfter && r.sonar.firstMoveAfter !== null && !r.sonar.motionResumed);
  if (settled.length && !sat.length) {
    const same = (rangeShift(settled[0]) ?? 9) < 0.25;
    hyps.push({
      name: same ? "fine, still standing where they were" : "conscious and moving",
      strength: same ? 0.62 : 0.5,
      because: `${settled[0].name} saw them shift position ${settled[0].sonar.firstMoveAfter.toFixed(0)} s later, which an unconscious person does not do`
    });
  }
  const measured = watchers.filter((r) => r.sonar.presentAfter && rangeShift(r) !== null);
  if (measured.length && measured.every((r) => rangeShift(r) < 0.25) && !resumed.length) {
    hyps.push({
      name: "still in the same spot",
      strength: measured.length >= 2 ? 0.45 : 0.35,
      because: `${measured.map((r) => `${r.name} shows them at ${r.sonar.rangeAfter.toFixed(1)} m, same as before`).join("; ")}; a fall usually moves the body`
    });
  }
  if (trust) {
    const bad = ctx.reports.filter((r) => w(trust, r) < 0.5 && (r.localVerdict !== "none" || sonarBurst(r) || heardImpact(r, 20)));
    const goodDanger = rs.some((r) => r.localVerdict !== "none" || sonarBurst(r) || heardImpact(r, 20));
    if (bad.length && !goodDanger) {
      hyps.push({ name: "bad data", strength: 0.85, because: `the only alarming report comes from ${bad.map((r) => r.name).join(", ")}, which the Auditor showed contradicts the others` });
    }
  }
  const before = knownHarmless(ctx.memory, ctx.reports, ctx.incident.t0);
  if (before.length >= 2 && !bodyDown && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress)) {
    hyps.push({
      name: "a known everyday sound in this home",
      strength: Math.min(0.66, 0.42 + 0.06 * before.length),
      because: `${before.length} earlier incidents like this (same sound, loudest on the same phone, same time of day) turned out fine when someone answered`
    });
  }
  if (!hyps.length && heard.length && !rs.some(sonarBurst) && !rs.some((r) => r.sound.screamDb !== null || r.sound.distress) && !rs.some(thudSound)) {
    hyps.push({ name: "dropped object", strength: 0.4, because: "a bang with no body motion on any sonar" });
  }
  hyps.sort((a, b) => b.strength - a.strength);
  let best = hyps[0];
  if (ctx.round === 2 && best) {
    const au = ctx.prior.find((p) => p.agent === "auditor");
    if (au?.stance === "escalate" && best.strength < 0.7) best = { ...best, strength: best.strength - 0.15 };
  }
  const points = hyps.map((h) => `${h.name}: ${h.because}`);
  if (ctx.incident.trigger.kind === "help_pressed") {
    return position(ctx, "skeptic", "escalate", 0.9, "A person asking for help is not something I argue with.", points);
  }
  const brief = (h) => h.because.split("; ").slice(0, 2).join(", and ");
  if (best && best.strength >= 0.55) {
    return position(ctx, "skeptic", "stand_down", best.strength, `I think it was ${best.name}. ${cap(brief(best))}.`, points);
  }
  const strong = rs.some(fullSignature) || rs.some((r) => r.sound.screamDb !== null || r.sound.distress);
  const conflict = ctx.prior.find((p) => p.conflict)?.conflict;
  if (conflict && (!best || best.strength < 0.55)) {
    return position(ctx, "skeptic", "uncertain", 0.5, "I cannot explain this, but the phones disagree with each other, so I would not trust either story without asking.", points);
  }
  if (!best && strong) {
    return position(ctx, "skeptic", "escalate", 0.6, "I tried to explain this away and could not. Every phone tells the same story.", ["no harmless explanation fits"]);
  }
  if (best && best.strength >= 0.35) {
    return position(ctx, "skeptic", "uncertain", 0.5, `Maybe ${best.name}, but I am not sure. ${cap(brief(best))}.`, points);
  }
  return position(ctx, "skeptic", strong ? "escalate" : "uncertain", 0.45, strong ? "Nothing harmless fits well enough." : "There is too little here to explain either way.", points);
}
var ROLES = { responder, skeptic, auditor };
var ROLE_INFO = {
  investigator: { title: "Investigator", goal: "Called in only when the others cannot agree. Goes and looks: asks phones to look again, checks the room map and the home history, then casts the deciding vote." },
  responder: { title: "Responder", goal: "Never let a real fall go unanswered. Argues for getting help." },
  skeptic: { title: "Skeptic", goal: "Prevent false alarms. Looks for a harmless explanation that fits every measurement." },
  auditor: { title: "Auditor", goal: "Trust no phone by default. Checks every report against physics and the other phones." }
};

// src/agents/llm.ts
function compactReport(r, trust) {
  const s = r.sonar;
  const ai = r.sound.impactAi;
  return {
    phone: r.name,
    trust: trust === void 0 ? void 0 : Math.round(trust * 100) / 100,
    streamed_samples: r.samples,
    silent_before_s: r.silenceMs > 1e8 ? "never streamed" : +(r.silenceMs / 1e3).toFixed(1),
    heard_impact_db: r.sound.impactDb === null ? null : Math.round(r.sound.impactDb),
    impact_repeating: r.sound.impactRepetitive || void 0,
    sound_model_says: ai ? `${ai.label} (${ai.group}, ${Math.round(ai.score * 100)}%)` : r.sound.impactDb === null ? void 0 : "not recognised",
    tv_or_music_share_before: r.sound.media === null ? void 0 : +r.sound.media.toFixed(2),
    voice_or_music_events_before: r.sound.mediaEventsBefore,
    scream: r.sound.screamDb !== null,
    distress_sound: r.sound.distress,
    voice_after: r.sound.voiceAfter,
    sonar_online: s.online,
    // Sonar that was not running knows nothing: every sonar reading is "unknown", never "nobody".
    ...s.online ? {
      was_watching_person: s.sawPersonBefore,
      last_saw_person_s_before: s.lastSeenAgo === null ? null : +s.lastSeenAgo.toFixed(1),
      range_before_m: s.rangeBefore === null ? null : +s.rangeBefore.toFixed(2),
      range_after_m: s.rangeAfter === null ? null : +s.rangeAfter.toFixed(2),
      body_burst_db: Math.round(s.burstDb),
      still_after_fraction: +s.stillAfter.toFixed(2),
      first_movement_after_s: s.firstMoveAfter === null ? null : +s.firstMoveAfter.toFixed(1),
      moved_normally_after: s.motionResumed,
      person_present_after: s.presentAfter,
      breathing_after_bpm: s.breathingAfter
    } : { sonar_readings: "unknown: this phone had no working sonar for this event" },
    phone_itself_moved: r.imu.moved || r.imu.dropped || s.roomChangeDb >= 15,
    phone_own_verdict: r.localVerdict
  };
}

// src/agents/brain.ts
var INVESTIGATOR_SYSTEM = [
  "You are the Investigator in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance and body movement) and on-phone sound recognition.",
  "Three local agents (Responder: never miss a fall; Skeptic: avoid false alarms; Auditor: check every phone against physics) already argued and could not agree. You are called in only now, to break the tie, and you are the only part of the system that costs money, so be quick.",
  "Go and look: ask_all_phones broadcasts one request to every phone to look again right now (add a few seconds of wait if someone may be down), ask_phone asks one phone directly, ask_cartographer reads the room map, home_history reads what this home learned, physics_check checks the phones against each other. Call the tools you need in one turn; they run in parallel. Two turns of looking is usually enough.",
  'Then post_position. "stand_down" only if what you found explains the event and shows the person is fine (moving normally, sitting where they usually sit, the bang came from the TV). "escalate" if what you found points to a fall: the phones then say "It looks like you may have fallen" and call the family in 25 s unless the person says they are OK. "uncertain" keeps the gentle "Are you OK?" question.',
  "Readings: impact dB is above that phone's quiet level (20+ is a real bang). sound_model_says is the on-phone sound recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted.",
  "Argument: one or two plain sentences citing what you found, phones by name, numbers. No jargon, no dashes."
].join("\n");
async function call(cfg, req, timeoutMs, deadline = Date.now() + timeoutMs) {
  for (let attempt = 0; ; attempt++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), Math.max(1e3, Math.min(timeoutMs, deadline - Date.now())));
    try {
      const res = await fetch(`${cfg.baseUrl ?? "https://api.anthropic.com"}/v1/messages`, {
        method: "POST",
        signal: ctl.signal,
        headers: { "content-type": "application/json", "x-api-key": cfg.apiKey, "anthropic-version": "2023-06-01", ...cfg.workspaceId ? { "anthropic-workspace-id": cfg.workspaceId } : {} },
        body: JSON.stringify({ model: cfg.model, ...req })
      });
      if (res.ok) return await res.json();
      const text = (await res.text()).slice(0, 400);
      const retryable = res.status === 429 || res.status === 529 || res.status >= 500;
      const wait = Math.min(8e3, (Number(res.headers.get("retry-after")) || 0) * 1e3 || 1200 * (attempt + 1));
      if (!retryable || attempt >= 3 || Date.now() + wait > deadline - 4e3) throw new Error(`Anthropic API ${res.status}: ${text}`);
      await new Promise((r) => setTimeout(r, wait));
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Claude took too long");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}
function lookWords(r) {
  if (r.streaming === false) return String(r.note ?? "not streaming");
  if (r.error) return String(r.error);
  const sounds = r.sounds_since_incident;
  return `${r.sees_someone_now ? `sees someone${r.distance_now_m ? ` at ${r.distance_now_m} m` : ""}` : "sees nobody"}${r.moving_now ? ", moving" : r.moving_now === false ? ", not moving" : ""}${r.breathing_bpm_now ? `, breathing ${r.breathing_bpm_now}/min` : ""}${r.moved_since_report ? ", moved since the report" : ""}${sounds?.length ? `, heard ${sounds.join(", ")}` : ""}`;
}

// src/agents/negotiation.ts
var LADDER = ["none", "watch", "ask", "urgent", "call"];
var ACTION_WORDS = {
  none: "do nothing",
  watch: "keep watching",
  ask: 'ask "Are you OK?"',
  urgent: 'say "you may have fallen" and count down',
  call: "call the family now"
};
function describePlan(p) {
  return `${ACTION_WORDS[p.action]}${p.callIfNoMovementS && p.action !== "call" ? `, and call at once if nobody moves within ${p.callIfNoMovementS} s` : ""}`;
}
function rank(a) {
  return LADDER.indexOf(a);
}
function openingPlan(p) {
  const s = p.stance;
  if (s === "escalate") return { action: p.agent === "responder" ? "call" : "urgent" };
  if (s === "uncertain") return { action: "ask" };
  return { action: p.agent === "skeptic" ? "none" : "watch" };
}
function samePlan(a, b) {
  return a.action === b.action;
}
function agreed(plans) {
  if (plans.length < 3 || !plans.every((p) => p.action === plans[0].action)) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action: plans[0].action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function nearAgreement(plans) {
  const ranks = plans.map((p) => rank(p.action));
  if (plans.length < 3 || Math.min(...ranks) < rank("ask") || Math.max(...ranks) > rank("urgent")) return null;
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action: Math.max(...ranks) === rank("urgent") ? "urgent" : "ask", callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function noDeal(plans) {
  const top = Math.max(...plans.map((p) => rank(p.action)));
  const action = top >= rank("urgent") ? "urgent" : top >= rank("ask") ? "ask" : "watch";
  const conds = plans.map((p) => p.callIfNoMovementS).filter((x) => !!x);
  return { action, callIfNoMovementS: conds.length ? Math.min(...conds) : null };
}
function normalisePlan(x, fallback) {
  const o = x ?? {};
  const action = LADDER.includes(o.action ?? "") ? o.action : fallback.action;
  const raw = o.call_if_no_movement_s ?? o.callIfNoMovementS ?? null;
  const cond = typeof raw === "number" && raw > 0 && action !== "call" ? Math.round(Math.min(120, Math.max(10, raw))) : null;
  return { action, callIfNoMovementS: cond };
}
var TITLES = { responder: "Responder", skeptic: "Skeptic", auditor: "Auditor" };
var ROLES3 = ["auditor", "responder", "skeptic"];
function negotiatedOutcome(rule, transcript, plan, deal, rounds) {
  const last = (r) => [...transcript].reverse().find((m) => m.agent === r);
  const stanceOf = (p) => p.action === "call" || p.action === "urgent" ? "escalate" : p.action === "ask" ? "uncertain" : "stand_down";
  return {
    ...rule,
    kind: plan.action === "call" || plan.action === "urgent" ? "escalate" : plan.action === "ask" ? "ask_human" : "stand_down",
    unanimous: deal,
    headline: deal ? `Agents negotiated a plan: ${describePlan(plan)}` : `No agreement after ${rounds} rounds: the disagreement is kept and the person is asked`,
    summary: ROLES3.map((r) => `${TITLES[r]}: ${last(r).argument}`).join(" "),
    dissent: deal ? [] : ROLES3.filter((r) => !samePlan(last(r).plan, plan)).map((r) => ({ agent: r, stance: stanceOf(last(r).plan), argument: last(r).argument })),
    plan,
    negotiation: { rounds, agreed: deal },
    decidedAt: Date.now()
  };
}

// src/agents/negotiator.ts
var GOALS = {
  responder: "You speak for the person. Your goal is that a real fall is never left unanswered. Push for the strongest response the evidence supports, but you lose credibility if you ignore evidence that they are fine.",
  skeptic: "You speak for the household against false alarms: every needless call scares the family and makes them switch the system off. Push for the lightest response the evidence allows, but never argue someone is fine when the evidence says they may be on the floor.",
  auditor: "You trust no phone by default. Your goal is that the decision rests only on evidence that checks out across phones. Side with whoever the trustworthy evidence supports, call out claims built on a phone that was moved, replayed, or contradicted, and propose conditions that test the disputed fact."
};
var TOOLS = [
  {
    name: "ask_all_phones",
    description: "Broadcast one request on the channel: every phone looks again right now (optionally after waiting up to 10 s) and replies with whether it sees someone, movement, distance, breathing, sounds since. Use it to settle a disputed fact.",
    input_schema: { type: "object", properties: { wait_seconds: { type: "number" } }, additionalProperties: false }
  },
  {
    name: "ask_cartographer",
    description: "Ask the Cartographer what the room map says: where the bang came from, where the person ended up, whether that is a usual resting spot.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "physics_check",
    description: "Check each phone's report against physics and the other phones (moved, replayed, contradicted). Returns trust per phone.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "home_history",
    description: "What this home learned from people's answers before: phones that cry wolf, harmless sounds at this time of day.",
    input_schema: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "make_move",
    description: "Make your one move for this round. Call it exactly once.",
    input_schema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["offer", "challenge", "concede", "counter", "accept"], description: "offer: first proposal. challenge: dispute a specific claim of another agent with evidence. concede: admit another agent is right about a claim. counter: propose a different plan, usually meeting them part way. accept: agree to another agent's current plan exactly." },
        to: { type: "string", enum: ["responder", "skeptic", "auditor"], description: "Whose claim or plan this answers (not for offer)." },
        claim: { type: "string", description: "The claim you challenge or concede, in a few words." },
        action: { type: "string", enum: [...LADDER], description: "The plan you now stand behind: none, watch, ask, urgent, call." },
        call_if_no_movement_s: { type: "number", description: "Optional condition: call at once if no phone sees movement within this many seconds (10 to 120)." },
        argument: { type: "string", description: "One or two plain sentences to the other agents, citing phones by name and numbers." }
      },
      required: ["kind", "action", "argument"],
      additionalProperties: false
    }
  }
];
var SYSTEM = (role) => [
  `You are the ${ROLE_INFO[role].title} agent in Witness, the safety system in an older person's home. Phones sense the room with sonar (distance, body movement) and on-phone sound recognition.`,
  `Your goal: ${GOALS[role]}`,
  "The three agents (Responder, Skeptic, Auditor) disagree about this incident, so you are negotiating what to do. Nobody can overrule the others: you must reach one plan all three accept. If there is no deal after the last round, nobody wins: the disagreement is kept on the record and the person is asked out loud (no answer calls for help). It is fine not to agree when the evidence really is not enough; do not give in just to reach a deal.",
  'The actions, lightest to strongest: none (nothing; they are still asked if nobody moves for a minute), watch (keep watching, ask if nobody moves), ask (gentle "Are you OK?", call if no answer in 40 s), urgent ("It looks like you may have fallen", call in 25 s unless they say they are OK), call (call the family now). A plan may add: call at once if no phone sees movement within N seconds.',
  "Negotiate like a sharp, fair colleague: challenge the specific claim you think is wrong and say why with evidence; concede a point when the evidence is against you; move toward the others when they are right; accept a plan you can live with. Do not repeat yourself. If a fact is disputed, check it with a tool instead of arguing (in one turn; tools run in parallel), but only if it would change a mind.",
  "Readings: impact dB is above that phone's quiet level (20+ is a real bang). sound_model_says is the on-phone recognition. body_burst_db 20+ is a sudden body movement. still_after_fraction near 1 means nobody moved; first_movement_after_s is when they first shifted. phone_itself_moved means its sonar described the phone, not the room.",
  'Say only what the readings show: someone "disappeared" only if a phone has last_saw_person_s_before set and nobody is present after; if nobody was seen before either, say "no phone can see anyone". The countdown is 25 s and the gentle question waits 40 s: use those numbers, do not invent others.',
  "Evidence rules: never infer missing evidence (no working sonar means unknown, not nobody there); a phone that did not hear or see something is not lying unless it could clearly have observed it; name the phone behind every claim.",
  "Speak in one or two plain sentences, phones by name, numbers. No jargon, no dashes."
].join("\n");
async function negotiateThink(cfg, ctx, role, round, lastRound, transcript, tools, opts) {
  const deadline = Date.now() + opts.budgetMs;
  let step = 0;
  const trace = (kind, summary, tool) => opts.onTrace?.({ incidentId: ctx.incident.id, agent: role, round: round + 2, step: ++step, kind, tool, summary: summary.slice(0, 400), t: Date.now() });
  const mine = [...transcript].reverse().find((m) => m.agent === role);
  const fallbackPlan = mine?.plan ?? { action: "ask" };
  const findings = [];
  const brief = {
    round,
    last_round: lastRound,
    what_happened: { trigger: ctx.incident.trigger.kind, phone: ctx.incident.trigger.name, detail: ctx.incident.trigger.detail },
    evidence: ctx.reports.map((r) => compactReport(r)),
    room_map: ctx.context?.notes ?? null,
    said_so_far: transcript.map((m) => ({ round: m.round, agent: m.agent, move: m.kind, to: m.to ?? void 0, claim: m.claim ?? void 0, plan: describePlan(m.plan), argument: m.argument, checked: m.findings?.length ? m.findings : void 0 })),
    your_current_plan: mine ? describePlan(mine.plan) : null,
    task: lastRound ? "Last round: accept a plan you can live with, or state your final plan." : "Make your move."
  };
  const messages = [{ role: "user", content: JSON.stringify(brief) }];
  const run = async (name, input) => {
    if (name === "ask_all_phones") {
      if (!tools.lookNow) return { result: { note: "not available in this replay" }, summary: "not available in this replay" };
      const waitS = Math.max(0, Math.min(10, Number(input.wait_seconds ?? 0) || 0, (deadline - Date.now() - 6e3) / 1e3));
      const r = await tools.lookNow(ctx.incident.id, "all", waitS);
      const parts = (r.replies ?? []).map((x) => `${x.phone}: ${lookWords(x.look)}`);
      if (r.no_reply?.length) parts.push(`no reply from ${r.no_reply.join(", ")}`);
      return { result: r, summary: `broadcast to every phone${waitS >= 1 ? ` (after ${Math.round(waitS)} s)` : ""}: ${parts.join("; ") || "no replies"}` };
    }
    if (name === "ask_cartographer") {
      const c = ctx.context;
      return c ? { result: { notes: c.notes, ended_at: c.endedAt?.place.name ?? null, bang_from: c.source?.name ?? null }, summary: c.notes.slice(0, 2).join("; ") } : { result: { note: "no room map yet" }, summary: "no room map yet" };
    }
    if (name === "physics_check") {
      const a = auditor({ ...ctx, round: 1, prior: [], seenFingerprints: /* @__PURE__ */ new Set() });
      const low = ctx.reports.filter((r) => (a.trust?.[r.nodeId]?.score ?? 1) < 0.5);
      return {
        result: { trust: Object.fromEntries(ctx.reports.map((r) => [r.name, { trust: +(a.trust?.[r.nodeId]?.score ?? 1).toFixed(2), reasons: a.trust?.[r.nodeId]?.reasons ?? [] }])), conflict: a.conflict ?? null },
        summary: a.conflict ? `conflict: ${a.conflict}` : low.length ? `low trust: ${low.map((r) => r.name).join(", ")}` : "every phone checks out"
      };
    }
    if (name === "home_history") {
      const h = summarize(ctx.memory ?? tools.memory?.(), tools.names?.() ?? {}, ctx.reports, ctx.incident.t0);
      return { result: h, summary: h.note ? String(h.note) : `${h.incidents_remembered} past incidents${h.pattern ? `; ${h.pattern}` : ""}` };
    }
    return { result: { error: "unknown tool" }, summary: "unknown tool" };
  };
  try {
    for (let turn = 0; turn < 3; turn++) {
      const left = deadline - Date.now();
      if (left < 2500) throw new Error("out of time");
      if (opts.canSpend && !opts.canSpend()) throw new Error("today's Claude budget is used up");
      const final = turn === 2 || left < 8e3;
      const body = await call(cfg, { system: SYSTEM(role), messages, tools: TOOLS, tool_choice: final ? { type: "tool", name: "make_move" } : { type: "auto" }, max_tokens: 350 }, Math.min(left - 500, cfg.timeoutMs), deadline);
      opts.onUsage?.(body.usage);
      messages.push({ role: "assistant", content: body.content });
      const text = body.content.filter((b) => b.type === "text" && b.text?.trim()).map((b) => b.text.trim()).join(" ");
      if (text) trace("thought", text);
      const calls = body.content.filter((b) => b.type === "tool_use");
      const move = calls.find((c) => c.name === "make_move");
      if (move) return toMove(move.input ?? {});
      if (!calls.length) {
        messages.push({ role: "user", content: "Make your move now with make_move." });
        continue;
      }
      const results = await Promise.all(
        calls.map(async (c) => {
          const { result, summary } = await run(c.name, c.input ?? {});
          findings.push(`${c.name}: ${summary}`.slice(0, 240));
          trace("tool", summary, c.name);
          return { type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result).slice(0, 2500) };
        })
      );
      messages.push({ role: "user", content: results });
    }
    throw new Error("no move");
  } catch (e) {
    opts.onError?.(e);
    trace("fallback", `could not make a move (${e.message.slice(0, 100)}); keeps its plan`);
    return null;
  }
  function toMove(o) {
    const kind = ["offer", "challenge", "concede", "counter", "accept"].includes(String(o.kind)) ? o.kind : "counter";
    let plan = normalisePlan({ action: o.action, call_if_no_movement_s: o.call_if_no_movement_s }, fallbackPlan);
    const to = ["responder", "skeptic", "auditor"].includes(String(o.to)) && o.to !== role ? o.to : null;
    if (kind === "accept" && to) {
      const theirs = [...transcript].reverse().find((m) => m.agent === to);
      if (theirs) plan = { ...theirs.plan };
    }
    return {
      id: uid("move"),
      incidentId: ctx.incident.id,
      agent: role,
      round,
      kind,
      to,
      claim: typeof o.claim === "string" ? o.claim.slice(0, 160) : null,
      plan,
      argument: (typeof o.argument === "string" && o.argument.trim() ? o.argument.trim() : describePlan(plan)).replace(/\s*[—–]\s*/g, ", ").slice(0, 500),
      findings,
      llm: true,
      postedAt: Date.now()
    };
  }
}

// src/agents/protocol.ts
var ORDER = ["auditor", "responder", "skeptic"];
async function deliberate(incident, reports, opts = {}) {
  const now = opts.now ?? Date.now;
  const seen = opts.seenFingerprints ?? /* @__PURE__ */ new Set();
  const voice = opts.voice;
  const context = opts.map ? cartograph(opts.map, reports) : void 0;
  const base = { incident, reports, seenFingerprints: seen, context };
  const r1Ctx = { ...base, round: 1, prior: [], now: now() };
  const round1 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r1Ctx, now: now() });
      return voice ? await voice(draft, r1Ctx) : draft;
    })
  );
  for (const p of round1) opts.onPosition?.(p);
  if (opts.pause) await opts.pause(1200);
  const r2Ctx = { ...base, round: 2, prior: round1, now: now() };
  const round2 = await Promise.all(
    ORDER.map(async (role) => {
      const draft = ROLES[role]({ ...r2Ctx, now: now() });
      return voice ? await voice(draft, r2Ctx) : draft;
    })
  );
  for (const p of round2) opts.onPosition?.(p);
  const outcome = resolve(incident, round2, reports, now());
  const brain = opts.brain;
  const contested = outcome.kind === "ask_human";
  if (brain && contested && incident.trigger.kind !== "help_pressed") {
    const transcript = round2.map((p) => ({ id: `${p.agent}-0`, incidentId: incident.id, agent: p.agent, round: 0, kind: "offer", plan: openingPlan(p), argument: p.argument, llm: false, postedAt: now() }));
    if (!agreed(transcript.map((m) => m.plan))) {
      const ctx = { ...base, round: 3, prior: round2, now: now() };
      let deal = null;
      let round = 0;
      while (!deal && round < 3) {
        round++;
        const moves = await Promise.all(ORDER.map((role) => negotiateThink(brain.cfg, ctx, role, round, round === 3, transcript, {}, { budgetMs: brain.budgetMs ?? 3e4, onTrace: brain.onTrace })));
        for (const m of moves) if (m) transcript.push(m);
        const now3 = ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r).plan);
        deal = agreed(now3) ?? (round >= 3 ? nearAgreement(now3) : null);
      }
      const plan = deal ?? noDeal(ORDER.map((r) => [...transcript].reverse().find((m) => m.agent === r).plan));
      return { positions: [...round1, ...round2], outcome: negotiatedOutcome(outcome, transcript, plan, !!deal, round), moves: transcript };
    }
  }
  return { positions: [...round1, ...round2], outcome };
}
function resolve(incident, finals, reports, t) {
  const esc = finals.filter((p) => p.stance === "escalate");
  const down = finals.filter((p) => p.stance === "stand_down");
  let kind;
  const conflict = finals.find((p) => p.conflict)?.conflict;
  if (incident.trigger?.kind === "help_pressed") kind = "escalate";
  else if (conflict) kind = "ask_human";
  else if (!down.length && esc.length >= 2) kind = "escalate";
  else if (!esc.length && down.length >= 2) kind = "stand_down";
  else kind = "ask_human";
  const unanimous = kind === "escalate" && esc.length === finals.length || kind === "stand_down" && down.length === finals.length;
  const dissent = finals.filter((p) => kind === "escalate" ? p.stance !== "escalate" : kind === "stand_down" ? p.stance !== "stand_down" : true).map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
  const trust = finals.find((p) => p.agent === "auditor")?.trust ?? {};
  const quarantined = reports.filter((r) => (trust[r.nodeId]?.score ?? 1) < 0.3 && !trust[r.nodeId]?.reasons.some((x) => x.includes("phone moved") || x.includes("phone itself"))).map((r) => r.name);
  const lead = (role) => finals.find((p) => p.agent === role);
  let headline;
  let summary;
  if (kind === "escalate") {
    headline = unanimous ? "All three agents agree: get help" : "Agents agree: get help";
    summary = `Responder: ${lead("responder").argument}`;
  } else if (kind === "stand_down") {
    headline = unanimous ? "All three agents agree: no emergency" : "Agents agree: no emergency";
    const why = lead("skeptic").stance === "stand_down" ? lead("skeptic") : lead("auditor");
    summary = `${why === lead("skeptic") ? "Skeptic" : "Auditor"}: ${why.argument}`;
  } else {
    headline = conflict ? "Phones contradict each other: asking the person" : "Agents disagree: asking the person";
    summary = `${finals.map((p) => `${cap2(p.agent)} says ${stanceWord(p.stance)}`).join(", ")}. The disagreement is kept and the person is asked directly; no answer means help is called.`;
  }
  if (quarantined.length) summary += ` ${quarantined.join(" and ")} flagged as untrustworthy.`;
  return { incidentId: incident.id, kind, unanimous, headline, summary, dissent, quarantined, decidedAt: t };
}
function cap2(s) {
  return s[0].toUpperCase() + s.slice(1);
}
function stanceWord(s) {
  return s === "escalate" ? "get help" : s === "stand_down" ? "stand down" : "not sure";
}

// tools/calibrate.ts
var args = process.argv.slice(2);
var holdout = args.includes("--holdout");
var file = args.find((a) => !a.startsWith("--")) ?? "training.jsonl";
if (!(0, import_node_fs.existsSync)(file)) {
  console.log(`No ${file} yet. Label some incidents on the console first (the calibration label row above the incident).`);
  process.exit(0);
}
var byId = /* @__PURE__ */ new Map();
for (const line of (0, import_node_fs.readFileSync)(file, "utf8").split("\n").filter(Boolean)) {
  const r = JSON.parse(line);
  byId.set(r.incident.id, r);
}
var all = [...byId.values()];
function toRow(r) {
  const online = r.reports.filter((x) => x.sonar.online);
  const seeing = online.filter((x) => x.sonar.sawPersonBefore);
  const loud = [...r.reports].filter((x) => x.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  const moves = seeing.filter((x) => x.sonar.rangeBefore !== null && x.sonar.rangeAfter !== null).map((x) => Math.abs(x.sonar.rangeAfter - x.sonar.rangeBefore));
  const st = r.incident.status;
  const live = r.escalated || st === "escalated" || st === "resolved_help" ? "caregiver_call" : r.outcome?.kind === "escalate" || st === "urgent" ? "countdown" : r.outcome?.kind === "ask_human" || st === "asking" || r.answer ? "asked" : "stood_down";
  return {
    rec: r,
    time: new Date(r.incident.t0).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", second: "2-digit" }),
    fall: r.label === "fall",
    subtype: r.subtype ?? (r.label === "fall" ? "other_fall" : "other"),
    location: r.location ?? "?",
    impact: Math.max(0, ...r.reports.map((x) => x.sound.impactDb ?? 0)),
    burst: Math.max(0, ...seeing.map((x) => x.sonar.burstDb)),
    still: Math.max(0, ...seeing.map((x) => x.sonar.stillAfter)) * 100,
    rangeChange: moves.length ? Math.max(...moves) : 0,
    link: online.length ? Math.min(...online.map((x) => x.sonar.medianLinkDb)) : 0,
    heardBy: r.reports.filter((x) => (x.sound.impactDb ?? 0) >= 15).length,
    sawBy: seeing.length,
    resumed: seeing.some((x) => x.sonar.motionResumed),
    sound: loud?.sound.impactAi ? `${loud.sound.impactAi.label} ${Math.round(loud.sound.impactAi.score * 100)}%` : "-",
    live,
    human: r.answer?.answer === "ok" ? "ok" : r.answer?.answer === "help" ? "hurt" : "none"
  };
}
var pad = (s, n) => String(s).padEnd(n);
var acted = (live) => live !== "stood_down";
function table(rows) {
  console.log(pad("time", 12) + pad("label", 6) + pad("subtype", 15) + pad("where", 13) + pad("impact", 7) + pad("burst", 6) + pad("still", 6) + pad("range", 6) + pad("link", 5) + pad("saw", 4) + pad("moved", 6) + pad("sound", 18) + pad("EchoSense", 15) + "person");
  for (const r of rows)
    console.log(
      pad(r.time, 12) + pad(r.fall ? "FALL" : "not", 6) + pad(r.subtype, 15) + pad(r.location, 13) + pad(r.impact.toFixed(0), 7) + pad(r.burst.toFixed(0), 6) + pad(`${r.still.toFixed(0)}%`, 6) + pad(`${r.rangeChange.toFixed(2)}`, 6) + pad(r.link.toFixed(0), 5) + pad(r.sawBy, 4) + pad(r.resumed ? "yes" : "no", 6) + pad(r.sound.slice(0, 17), 18) + pad(r.live, 15) + r.human
    );
}
function bySubtype(rows) {
  const groups = /* @__PURE__ */ new Map();
  for (const r of rows) groups.set(r.subtype, [...groups.get(r.subtype) ?? [], r]);
  console.log(`
${pad("what happened", 16)}${pad("n", 4)}${pad("stood down", 12)}${pad("asked", 7)}${pad("countdown", 11)}caregiver call`);
  for (const [k, g] of [...groups].sort((a, b) => Number(b[1][0].fall) - Number(a[1][0].fall) || a[0].localeCompare(b[0]))) {
    const c = (x) => g.filter((r) => r.live === x).length;
    const warn = g[0].fall && c("stood_down") ? "  <- missed falls" : !g[0].fall && c("caregiver_call") ? "  <- false calls" : "";
    console.log(`${pad(k, 16)}${pad(g.length, 4)}${pad(c("stood_down"), 12)}${pad(c("asked"), 7)}${pad(c("countdown"), 11)}${c("caregiver_call")}${warn}`);
  }
}
var FEATS = { impact: "impact dB", burst: "body burst dB", still: "still after %", rangeChange: "range change m" };
var COMBOS = [["impact"], ["burst"], ["still"], ["rangeChange"], ["impact", "still"], ["burst", "still"], ["impact", "burst"], ["burst", "rangeChange", "still"]];
function fitAll(rows, feats) {
  const falls = rows.filter((r) => r.fall);
  const nots = rows.filter((r) => !r.fall);
  const cands = feats.map((f) => [0, ...new Set(rows.map((r) => r[f]))].sort((a, b) => a - b));
  let best = { cuts: cands.map((c) => c[0]), caught: -1, left: -1 };
  const walk = (i, cuts) => {
    if (i === feats.length) {
      const hit = (r) => feats.every((f, j) => r[f] >= cuts[j]);
      const caught = falls.filter(hit).length;
      const left = nots.filter((r) => !hit(r)).length;
      if (caught + left > best.caught + best.left || caught + left === best.caught + best.left && caught > best.caught) best = { cuts: [...cuts], caught, left };
      return;
    }
    for (const v of cands[i]) walk(i + 1, [...cuts, v]);
  };
  walk(0, []);
  return best;
}
function combos(rows) {
  const F = rows.filter((r) => r.fall).length;
  const N = rows.length - F;
  console.log(`
Which signals separate falls from everyday events (rule: fall when every listed signal is at or above its cut)`);
  console.log(`${pad("signals", 50)}${pad("best cuts (- = not needed)", 28)}${pad("falls caught", 14)}everyday left alone`);
  for (const c of COMBOS) {
    const b = fitAll(rows, c);
    console.log(`${pad(c.map((f) => FEATS[f]).join(" + "), 50)}${pad(c.map((f, i) => b.cuts[i] === 0 ? "-" : `${b.cuts[i].toFixed(f === "rangeChange" ? 2 : 0)}`).join(" / "), 28)}${pad(`${b.caught}/${F}`, 14)}${b.left}/${N}`);
  }
  console.log("Reference, today's phone triggers: body burst >= 16 dB or impact >= 15 dB, then the agents weigh everything.");
  const stat = (xs) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? `${s[0].toFixed(1)} / ${s[s.length >> 1].toFixed(1)} / ${s[s.length - 1].toFixed(1)}` : "-";
  };
  console.log(`
${pad("min / median / max", 22)}${pad("falls", 24)}everyday`);
  for (const f of Object.keys(FEATS)) console.log(`${pad(FEATS[f], 22)}${pad(stat(rows.filter((r) => r.fall).map((r) => r[f])), 24)}${stat(rows.filter((r) => !r.fall).map((r) => r[f]))}`);
}
async function main() {
  const cal = all.filter((r) => !r.heldOut).map(toRow);
  const held = all.filter((r) => r.heldOut).map(toRow);
  if (!holdout) {
    const F2 = cal.filter((r) => r.fall).length;
    console.log(`Calibration set: ${cal.length} labelled incidents (${F2} falls, ${cal.length - F2} everyday). Held-out set: ${held.length} (not shown; run with --holdout once, after freezing).
`);
    if (!cal.length) return;
    table(cal);
    bySubtype(cal);
    if (F2 && cal.length - F2) combos(cal);
    const weak = cal.filter((r) => r.link < 18).length;
    if (weak) console.log(`
${weak} incident(s) had a phone with a sonar link under 18 dB (our setup target). Compare those rows before trusting a cut.`);
    console.log('\nThis is evidence, not new settings. With a few dozen examples a "best cut" fits these exact runs; move a threshold only when falls and everyday events are clearly apart, then check it on the held-out set.');
    return;
  }
  if (!held.length) {
    console.log('No held-out incidents yet. Tick "held out" on the console when labelling the final ~30%.');
    return;
  }
  const now = [];
  for (const r of held) {
    const { outcome } = await deliberate(r.rec.incident, r.rec.reports, { now: () => r.rec.incident.t0 + GATHER_MS, seenFingerprints: /* @__PURE__ */ new Set() });
    now.push({ ...r, live: outcome.kind === "escalate" ? "countdown" : outcome.kind === "ask_human" ? "asked" : "stood_down" });
  }
  const F = held.filter((r) => r.fall).length;
  console.log(`Held-out set: ${held.length} incidents (${F} falls, ${held.length - F} everyday)
`);
  table(held);
  console.log("\nAs it happened live:");
  bySubtype(held);
  console.log("\nRe-scored with the current rules (no person answering; watchful waiting not counted):");
  bySubtype(now);
  const caught = now.filter((r) => r.fall && acted(r.live)).length;
  const left = now.filter((r) => !r.fall && !acted(r.live)).length;
  console.log(`
Falls acted on: ${caught}/${F}. Everyday events left alone: ${left}/${held.length - F}.`);
}
void main();
