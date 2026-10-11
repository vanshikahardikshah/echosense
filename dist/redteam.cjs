"use strict";

// tools/redteam/run.ts
var import_node_crypto = require("node:crypto");
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
var SAME_EVENT_MS = 3e3;
var BURST_DB = 20;
var MOVING_DB = 12;
var seq = 0;
function uid(prefix) {
  seq = (seq + 1) % 1e6;
  return `${prefix}-${Date.now().toString(36)}${seq.toString(36)}`;
}
function screamConfirmed(e) {
  if (e.ai) return e.ai.group === "distress" && e.ai.score >= 0.5;
  return e.confidence >= 0.8 && e.aboveFloorDb >= 28;
}
function isDistressSound(e) {
  if (e.ai) return e.ai.group === "distress" && e.ai.score >= 0.5;
  return e.cls === "scream" && screamConfirmed(e);
}
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}
var PhoneAgent = class {
  constructor(nodeId, name, onTrigger = () => {
  }) {
    this.nodeId = nodeId;
    this.name = name;
    this.onTrigger = onTrigger;
    this.samples = [];
    this.sounds = [];
    this.alerts = [];
    this.imu = [];
    this.lastBurstTrigger = -1e12;
    this.lastSeen = 0;
    this.stillCand = null;
  }
  trim(now) {
    const keep = now - 4e4;
    while (this.samples.length && this.samples[0].t < keep) this.samples.shift();
    while (this.sounds.length && this.sounds[0].t < keep) this.sounds.shift();
    while (this.alerts.length && this.alerts[0].t < keep) this.alerts.shift();
    while (this.imu.length && this.imu[0].t < keep) this.imu.shift();
  }
  onSample(s) {
    this.samples.push(s);
    this.lastSeen = s.t;
    this.trim(s.t);
    if (s.sonarOk && s.fastMotionDb >= BURST_DB + 4 && s.t - this.lastBurstTrigger > 1e4) {
      this.lastBurstTrigger = s.t;
      this.stillCand = null;
      this.onTrigger("burst", `sudden body motion, ${s.fastMotionDb.toFixed(0)} dB`, s.t);
      return;
    }
    const present = s.presence === "moving" || s.presence === "still";
    if (s.sonarOk && present && s.fastMotionDb >= 16) {
      this.stillCand = { t: s.t, db: s.fastMotionDb };
    } else if (this.stillCand && s.t - this.stillCand.t >= 6e3) {
      const c = this.stillCand;
      this.stillCand = null;
      const after = this.samples.filter((x) => x.t > c.t + 1500);
      const ok = after.length >= 10 && after.every((x) => x.sonarOk);
      const still = ok && after.filter((x) => x.fastMotionDb < MOVING_DB).length / after.length >= 0.85;
      const stayed = ok && after.filter((x) => x.presence === "moving" || x.presence === "still").length / after.length >= 0.5;
      if (still && stayed && c.t - this.lastBurstTrigger > 2e4) {
        this.lastBurstTrigger = c.t;
        this.onTrigger("burst", `sudden movement (${c.db.toFixed(0)} dB), then no movement`, c.t);
      }
    }
  }
  onSound(e) {
    this.sounds.push(e);
    this.lastSeen = Math.max(this.lastSeen, e.t);
    this.trim(e.t);
    const bodyMoved = this.samples.some((x) => x.sonarOk && Math.abs(x.t - e.t) <= 1500 && x.fastMotionDb >= 16);
    if (e.benign && e.aboveFloorDb < 30 && !bodyMoved) return;
    if (e.cls === "impact" && (e.confidence >= 0.55 && e.aboveFloorDb >= 15 || bodyMoved && e.aboveFloorDb >= 10)) {
      this.onTrigger("impact", `impact ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    } else if (e.cls === "scream" && e.confidence >= 0.6 && screamConfirmed(e)) {
      this.onTrigger("scream", `scream ${e.aboveFloorDb.toFixed(0)} dB above the room (${e.ai?.top?.[0]?.name ?? "loud"})`, e.t);
    } else if (e.cls === "scream" && e.aboveFloorDb >= 30 && e.ai && e.ai.group !== "media" && (e.ai.top ?? []).some((x) => /Shout|Yell|Screaming/.test(x.name) && x.score >= 0.4)) {
      this.onTrigger("scream", `a loud shout, ${e.aboveFloorDb.toFixed(0)} dB above the room`, e.t);
    }
  }
  onAlert(a) {
    this.alerts.push(a);
    this.lastSeen = Math.max(this.lastSeen, a.t);
    if (a.kind === "fall") {
      const recent = [
        ...this.sounds.filter((e) => e.cls === "impact" || e.cls === "knock").map((e) => e.t),
        ...this.samples.filter((x) => x.sonarOk && x.fastMotionDb >= BURST_DB).map((x) => x.t)
      ].filter((t) => t <= a.t && t >= a.t - 9e3);
      this.onTrigger("fall_alert", a.title, recent.length ? Math.min(...recent.filter((t) => t >= Math.max(...recent) - 2500)) : a.t - 6e3);
    } else if (a.kind === "escalation" && /help/i.test(a.title)) this.onTrigger("help_pressed", a.title, a.t);
    else if (a.kind === "phone_drop") {
      this.imu.push({ t: a.t, type: "drop" });
      this.onTrigger("phone_drop", a.title, a.t);
    } else if (a.kind === "phone_moved") this.imu.push({ t: a.t, type: "moved" });
  }
  /** Whether this phone saw someone move (not just breathe) between t and now. */
  movedSince(t) {
    return this.samples.filter((s) => s.t >= t && s.sonarOk && s.fastMotionDb >= 14 && s.motionDb >= 14).length >= 6;
  }
  /** Whether this phone sees someone right now. */
  seesSomeone(now) {
    const xs = this.samples.filter((s) => s.t >= now - 3e3 && s.sonarOk);
    return xs.length > 5 && xs.filter((s) => s.presence === "moving" || s.presence === "still").length / xs.length >= 0.5;
  }
  /**
   * A fresh look, on request from a role agent: what this phone measures right
   * now and since the incident (the report only covers the first 11 seconds).
   */
  lookNow(t0, now) {
    const last = this.samples[this.samples.length - 1];
    if (!last || now - last.t > 5e3) return { streaming: false, note: "this phone is not streaming right now (locked, closed, or a recording that has ended)" };
    const recent = this.samples.filter((s) => s.t >= now - 4e3 && s.sonarOk);
    const since = this.samples.filter((s) => s.t >= t0 + 11500 && s.sonarOk);
    const moving = recent.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length;
    let breathing = null;
    for (const s of recent) if (s.breathing && s.breathing.quality >= 0.3) breathing = Math.round(s.breathing.rateBpm);
    const sounds = this.sounds.filter((e) => e.t >= t0 + 2500 && e.t <= now);
    const heard = [...new Set(sounds.map((e) => e.ai && e.ai.score >= 0.3 ? e.ai.words ?? e.ai.group : e.cls))].slice(0, 6);
    return {
      streaming: true,
      seconds_since_incident: Math.round((now - t0) / 1e3),
      sonar_running: recent.length >= 5,
      sees_someone_now: this.seesSomeone(now),
      moving_now: recent.length ? moving / recent.length >= 0.25 : null,
      distance_now_m: this.recentRange(4e3, now)?.toFixed(2) ?? null,
      breathing_bpm_now: breathing,
      moved_since_report: since.length ? this.movedSince(t0 + 11500) : null,
      sounds_since_incident: heard,
      voice_since_incident: sounds.some((e) => e.cls === "voice" || e.ai?.group === "speech"),
      distress_since_incident: sounds.some(isDistressSound)
    };
  }
  /** Median distance of a confirmed target over the last span ms (null if none seen). */
  recentRange(span, now) {
    const xs = this.samples.filter((s) => s.t >= now - span && s.sonarOk).map((s) => s.range !== null && (s.confirmed || s.snrDb >= 10) ? s.range : s.breathing ? s.breathing.range : null).filter((r) => r !== null);
    if (xs.length < 3) return null;
    return median(xs);
  }
  /** Build this phone's evidence report for an incident at t0 (ms). */
  report(incidentId, t0, now) {
    const inWin = (xs, w2) => xs.filter((x) => x.t >= t0 + w2[0] && x.t <= t0 + w2[1]);
    const all = inWin(this.samples, [WINDOW.before[0], WINDOW.after[1]]);
    const before = inWin(this.samples, WINDOW.before);
    const around = inWin(this.samples, WINDOW.around);
    const after = inWin(this.samples, WINDOW.after);
    const sonarAll = all.filter((s) => s.sonarOk);
    const medianLinkDb = median(sonarAll.map((s) => s.linkSnrDb));
    const online = sonarAll.length >= Math.max(8, 0.6 * all.length) && medianLinkDb >= 10;
    const present = (s) => (s.presence === "moving" || s.presence === "still") && (s.confirmed || s.breathing !== null || s.motionDb >= 14);
    const sawPersonBefore = online && before.length > 3 && before.filter(present).length / before.length >= 0.4;
    const lastRange = (xs) => {
      for (let i = xs.length - 1; i >= 0; i--) if (xs[i].range !== null && xs[i].confirmed) return xs[i].range;
      return null;
    };
    const burstDb = around.filter((s) => s.sonarOk).reduce((m, s) => Math.max(m, s.fastMotionDb), 0);
    const afterOk = after.filter((s) => s.sonarOk);
    const stillAfter = afterOk.length ? afterOk.filter((s) => s.fastMotionDb < MOVING_DB).length / afterOk.length : 0;
    const motionResumed = afterOk.length > 5 && afterOk.filter((s) => s.fastMotionDb >= 14 && s.motionDb >= 14).length / afterOk.length >= 0.25;
    const presentAfter = afterOk.length > 5 && afterOk.filter(present).length / afterOk.length >= 0.5;
    const firstMove = afterOk.find((s) => s.t >= t0 + 2500 && s.fastMotionDb >= 13.5 && present(s));
    let breathingAfter = null;
    for (const s of afterOk) if (s.breathing) breathingAfter = s.breathing.rateBpm;
    const roomChangeDb = around.concat(after).reduce((m, s) => Math.max(m, s.staticChangeDb), 0);
    const snd = inWin(this.sounds, WINDOW.sound);
    const impacts = snd.filter((e) => (e.cls === "impact" || e.cls === "knock") && e.confidence >= 0.45);
    const aiImpact = impacts.filter((e) => e.ai).sort((a, b) => b.aboveFloorDb - a.aboveFloorDb)[0]?.ai ?? null;
    const distress = inWin(this.sounds, [-3e3, 9e3]).some(isDistressSound);
    const mediaSamples = inWin(this.samples, [-12e3, 0]).filter((x) => x.media !== void 0);
    const media = mediaSamples.length ? mediaSamples.reduce((a, x) => a + (x.media ?? 0), 0) / mediaSamples.length : null;
    const seenBefore = this.samples.filter((x) => x.t <= t0 && x.t >= t0 - 4e4 && x.sonarOk && (x.presence === "moving" || x.presence === "still") && (x.confirmed || x.motionDb >= 14));
    const loudest = impacts.reduce((m, e) => !m || e.aboveFloorDb > m.aboveFloorDb ? e : m, null);
    const screams = inWin(this.sounds, [-3e3, 7500]).filter((e) => e.cls === "scream" && screamConfirmed(e));
    const mediaEv = inWin(this.sounds, WINDOW.media).filter((e) => e.cls === "voice" || e.cls === "sustained" || e.repetitive);
    const voiceAfter = inWin(this.sounds, WINDOW.after).some((e) => e.cls === "voice");
    const imu = inWin(this.imu, [-3e3, 3e3]);
    const alerts = inWin(this.alerts, [-1e3, GATHER_MS + 2e3]).filter((a) => a.kind === "fall");
    const localVerdict = alerts.some((a) => a.severity === "critical") ? "fall" : alerts.length ? "possible_fall" : "none";
    const lastBefore = this.samples.filter((s) => s.t <= t0).pop();
    return {
      id: uid("report"),
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
        distress
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
        lastSeenAgo: online && seenBefore.length ? (t0 - seenBefore[seenBefore.length - 1].t) / 1e3 : null,
        firstMoveAfter: online && firstMove ? (firstMove.t - t0) / 1e3 : null,
        breathingAfter: online ? breathingAfter : null,
        roomChangeDb
      },
      imu: { moved: imu.some((e) => e.type === "moved"), dropped: imu.some((e) => e.type === "drop") },
      localVerdict
    };
  }
};

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
function resolve(incident, finals2, reports, t) {
  const esc = finals2.filter((p) => p.stance === "escalate");
  const down = finals2.filter((p) => p.stance === "stand_down");
  let kind;
  const conflict = finals2.find((p) => p.conflict)?.conflict;
  if (incident.trigger?.kind === "help_pressed") kind = "escalate";
  else if (conflict) kind = "ask_human";
  else if (!down.length && esc.length >= 2) kind = "escalate";
  else if (!esc.length && down.length >= 2) kind = "stand_down";
  else kind = "ask_human";
  const unanimous = kind === "escalate" && esc.length === finals2.length || kind === "stand_down" && down.length === finals2.length;
  const dissent = finals2.filter((p) => kind === "escalate" ? p.stance !== "escalate" : kind === "stand_down" ? p.stance !== "stand_down" : true).map((p) => ({ agent: p.agent, stance: p.stance, argument: p.argument }));
  const trust = finals2.find((p) => p.agent === "auditor")?.trust ?? {};
  const quarantined = reports.filter((r) => (trust[r.nodeId]?.score ?? 1) < 0.3 && !trust[r.nodeId]?.reasons.some((x) => x.includes("phone moved") || x.includes("phone itself"))).map((r) => r.name);
  const lead = (role) => finals2.find((p) => p.agent === role);
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
    summary = `${finals2.map((p) => `${cap2(p.agent)} says ${stanceWord(p.stance)}`).join(", ")}. The disagreement is kept and the person is asked directly; no answer means help is called.`;
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

// src/sim/random.ts
var Rng = class {
  constructor(seed = 1) {
    this.spare = null;
    this.s = seed >>> 0 || 1;
  }
  next() {
    this.s = this.s + 1831565813 >>> 0;
    let t = this.s;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  uniform(a, b) {
    return a + (b - a) * this.next();
  }
  gauss() {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u2 = 0;
    let v = 0;
    while (u2 === 0) u2 = this.next();
    v = this.next();
    const r = Math.sqrt(-2 * Math.log(u2));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
};

// src/agents/sim.ts
var ROOM = { w: 5, d: 4 };
var LAYOUT = [
  { nodeId: "sim-1", name: "Phone 1", x: 0.4, y: 0.4, imu: true },
  { nodeId: "sim-2", name: "Phone 2", x: 4.6, y: 0.4, imu: true },
  { nodeId: "sim-3", name: "Phone 3", x: 2.5, y: 3.6, imu: true }
];
var T0 = 1e5;
var START = T0 - 14e3;
var END = T0 + 16e3;
var DT = 125;
var SEE_M = 3;
var lerp = (a, b, u2) => [a[0] + (b[0] - a[0]) * u2, a[1] + (b[1] - a[1]) * u2];
var clampRoom = (p) => [Math.max(0.2, Math.min(ROOM.w - 0.2, p[0])), Math.max(0.2, Math.min(ROOM.d - 0.2, p[1]))];
function generate(spec, seed, layout = LAYOUT) {
  const rng = new Rng(seed * 7919 + spec.key.length * 104729);
  const j = (v, s) => v + rng.uniform(-s, s);
  const phones = layout.map((p, i) => ({
    ...p,
    x: j(p.x, 0.2),
    y: j(p.y, 0.2),
    imu: i === spec.knock ? rng.next() < 0.5 : p.imu,
    occluded: spec.occluded?.includes(i) ?? false,
    compromised: spec.compromised?.phone === i ? spec.compromised.kind : void 0
  }));
  const P = spec.person;
  const from = clampRoom([j(P.from[0], 0.3), j(P.from[1], 0.3)]);
  const to = clampRoom([j(P.to[0], 0.3), j(P.to[1], 0.3)]);
  const at = clampRoom([to[0] + (P.at[0] - P.to[0]) * rng.uniform(0.7, 1.3), to[1] + (P.at[1] - P.to[1]) * rng.uniform(0.7, 1.3)]);
  const eventHappens = rng.next() < (P.eventProb ?? 1);
  const resumes = rng.next() < (P.resumeProb ?? (P.after === "walk" ? 1 : 0));
  const resumeAt = T0 + rng.uniform(2500, 4500);
  const walkDir = [rng.uniform(-1, 1), rng.uniform(-1, 1)];
  const media = spec.media ? [j(spec.media[0], 0.2), j(spec.media[1], 0.2)] : null;
  const aiOn = rng.next() < 0.85;
  const hidden = (p) => !!spec.outOfView && p[0] >= spec.outOfView[0] && p[1] >= spec.outOfView[1] && p[0] <= spec.outOfView[2] && p[1] <= spec.outOfView[3];
  const personAt = (t) => {
    if (t < T0 - 300) {
      if (P.before === "walk") return { pos: lerp(from, to, (t - START) / (T0 - 300 - START)), state: "walk" };
      return { pos: to, state: P.before };
    }
    if (t < T0 + 1200) {
      const ev = eventHappens ? P.event : "none";
      if (ev === "none" || ev === "flinch" && t > T0 + 500) {
        const st = P.before;
        return { pos: st === "walk" ? lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6e3) : to, state: st };
      }
      return { pos: lerp(to, at, Math.max(0, Math.min(1, (t - T0 + 300) / 1300))), state: "event" };
    }
    const settled = eventHappens ? P.after : P.before;
    if (resumes && t >= resumeAt) {
      const base = P.event === "none" && P.before === "walk" ? to : at;
      return { pos: lerp(base, clampRoom([base[0] + walkDir[0] * 2, base[1] + walkDir[1] * 2]), (t - resumeAt) / 8e3), state: "walk" };
    }
    if (P.event === "none" && P.before === "walk") {
      return { pos: lerp(to, clampRoom([to[0] + walkDir[0], to[1] + walkDir[1]]), (t - T0 + 300) / 6e3), state: "walk" };
    }
    return { pos: eventHappens ? at : to, state: settled };
  };
  const fidgets = [];
  for (let t = START + rng.uniform(0, 6e3); t < END; t += rng.uniform(4e3, 13e3)) fidgets.push([t, t + rng.uniform(400, 800)]);
  const fidgeting = (t) => fidgets.some(([a, b]) => t >= a && t <= b);
  const height = (s) => s === "floor" ? 0.25 : s === "sit" ? 1 : s === "event" ? 0.7 : 1.25;
  const streams = phones.map((ph, idx) => {
    const samples = [];
    const sonarMiss = rng.next() < 0.08;
    const breathes = rng.next() < 0.6;
    let stillSince = -1;
    const knocked = spec.knock === idx;
    const link = rng.uniform(18, 28);
    for (let t = START; t <= END; t += DT) {
      const { pos, state } = personAt(t);
      const d = Math.hypot(pos[0] - ph.x, pos[1] - ph.y);
      const sees = !ph.occluded && !sonarMiss && d <= SEE_M && !hidden(pos);
      let fast;
      let motion;
      let presence = "empty";
      let range = null;
      let confirmed = false;
      let breathing = null;
      let sonarOk = true;
      let staticChangeDb = rng.uniform(0, 4);
      let linkSnrDb = link + rng.uniform(-1.5, 1.5);
      if (sees) {
        const ev = eventHappens ? P.event : "none";
        if (state === "walk") [fast, motion, presence] = [rng.uniform(13, 19), rng.uniform(18, 26), "moving"];
        else if (state === "event") {
          const burst = ev === "fall" ? [24, 32] : ev === "collapse" ? [16, 22] : ev === "flinch" ? [19, 24] : ev === "sit" ? [20, 25] : [17, 22];
          [fast, motion, presence] = [rng.uniform(burst[0], burst[1]), rng.uniform(20, 30), "moving"];
        } else if (state !== "floor" && fidgeting(t)) [fast, motion, presence] = [rng.uniform(14, 18), rng.uniform(15, 20), "moving"];
        else [fast, motion, presence] = [rng.uniform(1, state === "floor" ? 6 : 9), rng.uniform(8, 13), "still"];
        range = Math.hypot(d, height(state) - 0.75) + rng.gauss() * 0.04;
        confirmed = rng.next() < (state === "walk" || state === "event" ? 0.95 : state === "floor" ? 0.65 : 0.8);
        if (state === "still" || state === "sit" || state === "floor") {
          if (stillSince < 0) stillSince = t;
          if (breathes && t - stillSince > 1e4 && rng.next() < 0.9) breathing = { rateBpm: 14 + rng.gauss(), quality: rng.uniform(0.5, 0.8), range };
        } else stillSince = -1;
      } else {
        [fast, motion] = [rng.uniform(0, 4), rng.uniform(2, 7)];
        stillSince = -1;
      }
      if (knocked && t >= T0) {
        if (ph.imu) {
          sonarOk = false;
          presence = "unknown";
          range = null;
          confirmed = false;
          fast = 0;
          breathing = null;
        } else {
          fast = t < T0 + 500 ? rng.uniform(32, 38) : rng.uniform(0, 5);
          staticChangeDb = rng.uniform(18, 26);
          linkSnrDb = rng.uniform(12, 20);
          presence = t < T0 + 500 ? "moving" : "empty";
          range = null;
          confirmed = false;
          breathing = null;
        }
      }
      const mediaShare = aiOn ? media ? rng.uniform(0.45, 0.95) : rng.uniform(0, 0.1) : void 0;
      samples.push({ t, presence, range, confirmed, snrDb: confirmed ? rng.uniform(16, 26) : 0, fastMotionDb: fast, motionDb: motion, staticChangeDb, linkSnrDb, breathing, sonarOk, media: mediaShare });
    }
    const sounds = [];
    const hear = (sx, sy, level, at2, cls, repetitive = false, ai) => {
      const d = Math.hypot(sx - ph.x, sy - ph.y);
      const lvl = level + rng.gauss() * 2 - 20 * Math.log10(Math.max(d, 0.3));
      if (lvl < 6) return;
      let c = cls;
      if (cls === "impact" && rng.next() < 0.12) c = "knock";
      const ev = { t: at2 + rng.uniform(150, 600), cls: c, confidence: rng.uniform(0.55, 0.9), aboveFloorDb: lvl, repetitive };
      if (aiOn && ai) {
        const right = rng.next() < ai.p;
        const wrong = ["thud", "object", "tap"].filter((g) => g !== ai.group);
        const group = right ? ai.group : wrong[Math.floor(rng.next() * wrong.length)];
        const score = right ? rng.uniform(0.35, 0.85) : rng.uniform(0.15, 0.4);
        ev.ai = { group, score, top: [{ name: group, score }] };
        ev.benign = c !== "scream" && score >= 0.35 && lvl < 30 && ["tap", "speech", "media", "footsteps", "object"].includes(group);
      }
      sounds.push(ev);
    };
    if (media) {
      for (let t = START; t < END; t += rng.uniform(800, 1400)) hear(media[0], media[1], 26, t, rng.next() < 0.6 ? "voice" : "sustained", rng.next() < 0.2, { group: "media", p: 0.8 });
    }
    for (const s of spec.sounds) {
      if (s.prob !== void 0 && rng.next() >= s.prob) continue;
      let src;
      if (s.from === "person") src = personAt(T0 + s.at).pos;
      else if (s.from === "media") src = media ?? [0, 0];
      else if (Array.isArray(s.from)) src = s.from;
      else src = [phones[s.from.phone].x, phones[s.from.phone].y + 0.15];
      hear(src[0], src[1], s.level + rng.uniform(-3, 3), T0 + s.at, s.cls, s.repetitive, s.ai);
    }
    if (spec.screamProb && eventHappens && seededChance(seed, spec.screamProb)) {
      const p = personAt(T0 + 400).pos;
      hear(p[0], p[1], 40, T0 + 400, "scream", false, { group: "distress", p: 0.85 });
    }
    sounds.sort((a, b) => a.t - b.t);
    const alerts = [];
    if (knocked && ph.imu) alerts.push({ t: T0 + 250, kind: "phone_drop", severity: "warning", title: "Phone dropped" });
    return { phone: ph, samples, sounds, alerts };
  });
  for (const s of streams) {
    if (s.phone.compromised === "fake_fall") fabricateFall(s, rng);
    else if (s.phone.compromised === "hide") fabricateCalm(s, rng);
  }
  for (const s of streams) s.alerts.push(...localVerdicts(s), ...[]);
  for (const s of streams) s.alerts.sort((a, b) => a.t - b.t);
  return { spec, phones, streams };
}
function seededChance(seed, p) {
  return new Rng(seed * 31 + 7).next() < p;
}
function fabricateFall(s, rng, t0 = T0) {
  const r0 = rng.uniform(1.2, 1.8);
  for (const x of s.samples) {
    const t = x.t;
    x.sonarOk = true;
    x.staticChangeDb = rng.uniform(0, 4);
    if (t < t0 - 300) Object.assign(x, { presence: "moving", range: r0 + rng.gauss() * 0.05, confirmed: true, fastMotionDb: rng.uniform(13, 18), motionDb: rng.uniform(18, 24), breathing: null });
    else if (t < t0 + 1200) Object.assign(x, { presence: "moving", range: r0 + 0.4, confirmed: true, fastMotionDb: rng.uniform(26, 31), motionDb: 28 });
    else Object.assign(x, { presence: "still", range: r0 + 0.6, confirmed: true, fastMotionDb: rng.uniform(1, 5), motionDb: rng.uniform(8, 12) });
  }
  s.sounds = s.sounds.filter((e) => e.t < t0 - 3e3 || e.t > t0 + 3e3);
  s.sounds.push({ t: t0 + 300, cls: "impact", confidence: 0.85, aboveFloorDb: rng.uniform(28, 34), repetitive: false });
  s.sounds.sort((a, b) => a.t - b.t);
}
function fabricateCalm(s, rng) {
  const r0 = rng.uniform(1.5, 2.2);
  for (const x of s.samples) {
    Object.assign(x, { sonarOk: true, presence: "moving", range: r0 + rng.gauss() * 0.1, confirmed: true, fastMotionDb: rng.uniform(13, 17), motionDb: rng.uniform(18, 24), breathing: null });
  }
  s.sounds = [];
  s.alerts = [];
}
function localVerdicts(s) {
  const out = [];
  const impacts = s.sounds.filter((e) => e.cls === "impact" && !e.repetitive && !e.benign && e.confidence >= 0.55);
  let lastFall = -1e12;
  let lastSeen = -1e12;
  const seen = s.samples.filter((x) => x.sonarOk && (x.confirmed && x.snrDb >= 15 || x.motionDb >= 16 || x.breathing));
  const bursts = s.samples.filter((x) => x.sonarOk && x.fastMotionDb >= 20).map((x) => x.t);
  const anchors = [...impacts.map((e) => e.t), ...bursts].sort((a, b) => a - b);
  let lastAnchor = -1e12;
  for (const t0 of anchors) {
    if (t0 - lastAnchor < 3e3) continue;
    lastAnchor = t0;
    const sound = impacts.find((e) => Math.abs(e.t - t0) <= 2e3);
    const around = s.samples.filter((x) => x.t >= t0 - 2e3 && x.t <= t0 + 1500 && x.sonarOk);
    const after = s.samples.filter((x) => x.t > t0 + 1500 && x.t <= t0 + 6e3 && x.sonarOk);
    const sonarOk = around.length > 10;
    const burst = around.reduce((m, x) => Math.max(m, x.fastMotionDb), 0);
    const still = sonarOk && after.length > 10 && after.filter((x) => x.fastMotionDb < 12).length / after.length >= 0.85;
    const presentBefore = around.filter((x) => x.t < t0 - 200 && (x.confirmed && x.snrDb >= 15 || x.motionDb >= 16)).length > 5;
    for (const x of seen) if (x.t < t0) lastSeen = Math.max(lastSeen, x.t);
    const decideAt = t0 + 6e3;
    if (decideAt - lastFall < 3e4) continue;
    if (sonarOk && burst >= 20 && sound && still) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: "fall", severity: "critical", title: "Possible fall" });
    } else if (sound && still && sound.confidence >= 0.7 && !(sonarOk && presentBefore) && t0 - lastSeen < 9e4 && (sound.ai ? sound.ai.group === "thud" || sound.ai.group === "distress" : sound.confidence >= 0.85 && sound.aboveFloorDb >= 28)) {
      lastFall = decideAt;
      out.push({ t: decideAt, kind: "fall", severity: "warning", title: "Loud impact, then no movement" });
    }
  }
  return out;
}

// src/agents/eval.ts
async function runAgents(trial, seen = /* @__PURE__ */ new Set(), map, brain) {
  const triggers = [];
  const agents = trial.streams.map((s) => new PhoneAgent(s.phone.nodeId, s.phone.name, (kind, detail, t) => triggers.push({ t, nodeId: s.phone.nodeId, name: s.phone.name, kind, detail })));
  const evs = [];
  trial.streams.forEach((s, i) => {
    for (const x of s.samples) evs.push({ t: x.t, i, run: () => agents[i].onSample(x) });
    for (const x of s.sounds) evs.push({ t: x.t, i, run: () => agents[i].onSound(x) });
    for (const x of s.alerts) evs.push({ t: x.t, i, run: () => agents[i].onAlert(x) });
  });
  evs.sort((a, b) => a.t - b.t || a.i - b.i);
  for (const e of evs) e.run();
  triggers.sort((a, b) => a.t - b.t);
  const runs = [];
  const opened = [];
  let n = 0;
  for (const tr of triggers) {
    if (opened.some((t) => Math.abs(tr.t - t) <= SAME_EVENT_MS)) continue;
    opened.push(tr.t);
    const incident = {
      id: `${trial.spec.key}-${++n}`,
      t0: tr.t,
      trigger: { nodeId: tr.nodeId, name: tr.name, kind: tr.kind, detail: tr.detail },
      status: "deliberating",
      expected: agents.map((a) => a.nodeId),
      simulated: true,
      scenario: trial.spec.key
    };
    const at = tr.t + GATHER_MS;
    const reports = agents.map((a) => a.report(incident.id, tr.t, at));
    const { positions, outcome } = await deliberate(incident, reports, { now: () => at, seenFingerprints: seen, map, brain });
    for (const r of reports) seen.add(fingerprint(r));
    runs.push({ incident, reports, positions, outcome });
  }
  return runs;
}
function agentDecision(runs, trial) {
  if (runs.some((r) => r.outcome.kind === "escalate")) return "alarm";
  if (runs.some((r) => r.outcome.kind === "ask_human")) return "ask";
  const watched2 = runs.some((r) => r.outcome.kind === "stand_down" && r.reports.some((x) => x.sonar.sawPersonBefore && x.sonar.burstDb >= 16 && x.sonar.firstMoveAfter === null && !x.sonar.motionResumed));
  if (watched2 && trial && trial.spec.person.after === "floor" && trial.spec.person.event !== "none") return "ask";
  return "none";
}

// src/agents/intent.ts
var STRONG_HELP = /\bhelp me\b|\bi('?m| am) (hurt|bleeding|stuck|on the floor|in pain|not ok|not okay|not alright|not all right|not fine|not good|not well)\b|\bi (fell|fall|have fallen|'ve fallen)\b|\bi can'?t (get up|stand|breathe|move|walk)\b|\bi cannot (get up|stand|breathe|move|walk)\b|\bcall (an? )?ambulance\b|\b911\b|\bnine one one\b|\bhelp help\b/;
var WEAK_HELP = [
  /\bhelp\b/,
  /\bhurts?\b|\bhurting\b|\bpain\b|\bpainful\b|\bache\b|\binjur/,
  /\bbleed|\bblood\b/,
  /\bfell\b|\bfallen\b/,
  /\bcan'?t (get up|stand|move|breathe|walk)\b|\bcannot (get up|stand|move|breathe|walk)\b/,
  /\bambulance\b|\bemergency\b|\bdoctor\b|\bhospital\b/,
  /\bcall (someone|somebody|my)\b/,
  /\bbroke(n)?\b|\bdizzy\b|\bchest\b|\bfaint/,
  /\bnot (ok|okay|fine|alright|all right|good|well)\b/
];
var STRONG_OK = /\bi('?m| am) (ok|okay|fine|alright|all right|good|great|doing (ok|okay|fine|good|alright))\b|\ball good\b|\beverything('?s| is) (ok|okay|fine|alright|all right)\b|\bfalse alarm\b|\bi('?m| am) (totally |perfectly |completely )?(ok|okay|fine|alright)\b/;
var SHORT_OK = /^(yes|yeah|yep|yup|ok|okay|fine|good|alright|all right)( (yes|yeah|i'?m|i am|fine|ok|okay|good|thanks|thank you))*$/;
var BARE_NO = /^(no+|nope|nah)( (no+|nope))*$/;
var PROMPT_ECHO = [
  /\bsay (i'?m|i am) (ok|okay),? or say help\b/g,
  /\b(ok|okay|k),? or say help\b/g,
  /\bor say help\b/g,
  /\bsay help\b/g,
  /\bare you (ok|okay)\b/g,
  /\bit looks like you may have fallen\b/g,
  /\botherwise i will call (for help|your family)\b/g,
  /\bi will call (for help|your family)\b/g,
  /\bi'?m about to call for help\b/g,
  /\bsay (i'?m|i am) (ok|okay) if you are (ok|okay)\b/g,
  /\bif you are (ok|okay),? say (i'?m|i am) (ok|okay)\b/g,
  /\bplease answer\b/g,
  /\bif i don'?t hear from you\b/g,
  /\bsorry,? i didn'?t catch that\b/g
];
function stripPromptEcho(raw) {
  let t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  let cut = -1;
  for (const re of PROMPT_ECHO) {
    re.lastIndex = 0;
    let m;
    while (m = re.exec(t)) cut = Math.max(cut, m.index + m[0].length);
  }
  if (cut >= 0) t = t.slice(cut).trim();
  return t;
}
function ruleIntent(raw) {
  raw = stripPromptEcho(raw);
  const t = raw.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9' ]+/g, " ").replace(/\s+/g, " ").trim();
  const words = t ? t.split(" ").length : 0;
  const m = /\b(my|the) (\w+ )?(hip|head|leg|arm|back|wrist|knee|ankle|shoulder|neck|chest|hand|foot)\b/.exec(t);
  const injury = m ? m[0] : null;
  if (!words) return { answer: "unclear", injury: null, by: "rules" };
  if (STRONG_HELP.test(t)) return { answer: "help", injury, by: "rules" };
  if (BARE_NO.test(t)) return { answer: "unclear", injury, by: "rules" };
  const direct = words <= 12;
  if (words <= 7 && WEAK_HELP.some((r) => r.test(t))) return { answer: "help", injury, by: "rules" };
  if (direct && (STRONG_OK.test(t) || SHORT_OK.test(t))) return { answer: "ok", injury: null, by: "rules" };
  return { answer: "unclear", injury, by: "rules" };
}

// tools/redteam/families.ts
var u = (r, a, b) => r.uniform(a, b);
var pick = (r, xs) => xs[Math.floor(r.next() * xs.length)];
var pt = (r, x0, x1, y0, y1) => [u(r, x0, x1), u(r, y0, y1)];
var near = (p, r, d) => [Math.min(4.8, Math.max(0.2, p[0] + u(r, -d, d))), Math.min(3.8, Math.max(0.2, p[1] + u(r, -d, d)))];
var TV = [4.7, 0.9];
var FAMILIES = [
  // ---------- Emergencies ----------
  {
    id: "E01_fall_any_loudness",
    emergency: true,
    why: "Plain fall, but impact loudness swept from carpet-quiet to tile-loud.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Fall, varied loudness", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.6), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 22, 42), cls: "impact", ai: { group: "thud", p: u(r, 0.5, 0.8) } }], screamProb: 0.15 };
    }
  },
  {
    id: "E02_slide_from_chair",
    emergency: true,
    why: "Seated person slides to the floor: small burst, little or no sound, no walking before.",
    gen: (r) => {
      const to = pt(r, 1, 3.8, 1.2, 3);
      return { title: "Slides out of a chair", description: "", emergency: true, person: { from: to, to, at: near(to, r, 0.4), before: "sit", after: "floor", event: "collapse" }, sounds: [{ at: 600, from: "person", level: u(r, 10, 22), cls: "impact", ai: { group: "thud", p: 0.5 }, prob: 0.5 }] };
    }
  },
  {
    id: "E03_silent_lowering",
    emergency: true,
    why: "Slow lowering to the floor, no sound at all: sonar only.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Silent lowering", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "collapse" }, sounds: [] };
    }
  },
  {
    id: "E04_fall_one_viewer",
    emergency: true,
    why: "Only one phone has line of sight; the other two are occluded.",
    gen: (r) => {
      const seer = Math.floor(r.next() * 3);
      const anchors = [[1, 1], [4, 1], [2.5, 3]];
      const to = near(anchors[seer], r, 0.3);
      return { title: "Fall, one phone sees", description: "", emergency: true, person: { from: near(to, r, 0.8), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 28, 40), cls: "impact", ai: { group: "thud", p: 0.7 } }], occluded: [0, 1, 2].filter((i) => i !== seer) };
    }
  },
  {
    id: "E05_fall_tv_masking",
    emergency: true,
    why: "Real fall while the TV is loud: the media prior argues it was the movie.",
    gen: (r) => {
      const to = pt(r, 1.3, 2.6, 1.6, 2.8);
      return { title: "Fall during TV", description: "", emergency: true, person: { from: near(to, r, 0.6), to, at: near(to, r, 0.6), before: pick(r, ["sit", "walk"]), after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 28, 40), cls: "impact", ai: { group: "thud", p: u(r, 0.5, 0.75) } }, { at: u(r, -800, 800), from: "media", level: u(r, 34, 42), cls: "impact", ai: { group: "media", p: 0.6 }, prob: 0.5 }], media: TV };
    }
  },
  {
    id: "E06_fall_while_talking",
    emergency: true,
    why: 'Talking (or on speakerphone) right before the fall: lots of voice, a loud "scream" that is really speech.',
    gen: (r) => {
      const to = pt(r, 1.4, 3.4, 1.2, 2.6);
      return { title: "Fall while talking", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: -3e3, from: "person", level: 28, cls: "voice", ai: { group: "speech", p: 0.9 } }, { at: -1200, from: "person", level: u(r, 28, 36), cls: "scream", ai: { group: "speech", p: 0.85 }, prob: 0.6 }, { at: 250, from: "person", level: u(r, 26, 38), cls: "impact", ai: { group: "thud", p: 0.65 } }] };
    }
  },
  {
    id: "E07_fall_two_phones",
    emergency: true,
    why: "Only two phones live (third off or charging).",
    gen: (r) => {
      const to = pt(r, 1.2, 3.8, 0.8, 2.6);
      return { title: "Fall, two phones", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: pick(r, ["fall", "collapse"]) }, sounds: [{ at: 250, from: "person", level: u(r, 18, 40), cls: "impact", ai: { group: "thud", p: 0.65 }, prob: 0.8 }], phones: 2 };
    }
  },
  {
    id: "E08_fall_single_phone",
    emergency: true,
    why: "Only one phone running at all. No corroboration is possible.",
    gen: (r) => {
      const to = pt(r, 0.8, 2.6, 0.8, 2.2);
      return { title: "Fall, one phone", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 24, 40), cls: "impact", ai: { group: "thud", p: 0.7 } }], phones: 1 };
    }
  },
  {
    id: "E09_hidden_by_hacked_phone",
    emergency: true,
    why: "A compromised phone insists all is well during a real fall.",
    gen: (r) => {
      const to = pt(r, 1, 3.6, 1, 2.6);
      const bad = Math.floor(r.next() * 3);
      return { title: "Hacked phone hides fall", description: "", emergency: true, person: { from: near(to, r, 0.8), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 28, 40), cls: "impact", ai: { group: "thud", p: 0.7 } }], compromised: { phone: bad, kind: "hide" }, occluded: r.next() < 0.4 ? [(bad + 1) % 3] : void 0 };
    }
  },
  {
    id: "E10_fall_out_of_view",
    emergency: true,
    why: "Falls where no sonar can see (hallway, bathroom doorway); sound only.",
    gen: (r) => ({ title: "Fall out of view", description: "", emergency: true, person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 22, 40), cls: "impact", ai: { group: "thud", p: u(r, 0.5, 0.8) } }], outOfView: [4.1, 3.1, 5, 4] })
  },
  {
    id: "E11_collapse_with_cry",
    emergency: true,
    why: "Soft collapse with a cry/groan but almost no impact.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Collapse with cry", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "collapse" }, sounds: [{ at: 600, from: "person", level: u(r, 10, 18), cls: "impact", ai: { group: "thud", p: 0.5 }, prob: 0.4 }], screamProb: 1 };
    }
  },
  {
    id: "E12_fall_resumes_then_down",
    emergency: true,
    why: 'Falls, briefly struggles (a second burst), then stays down: "movement came back" is a trap.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Fall then struggle", description: "", emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: "walk", after: "floor", event: "fall" }, sounds: [{ at: 250, from: "person", level: u(r, 28, 38), cls: "impact", ai: { group: "thud", p: 0.7 } }, { at: 3e3, from: "person", level: u(r, 14, 22), cls: "impact", ai: { group: "object", p: 0.6 }, prob: 0.6 }] };
    }
  },
  // ---------- Not emergencies ----------
  {
    id: "N01_tv_crash",
    emergency: false,
    why: "Loud crash from the TV, person seated (sometimes flinches).",
    gen: (r) => ({ title: "TV crash", description: "", emergency: false, person: { from: [1.3, 2.6], to: [u(r, 1, 2), u(r, 2.2, 3)], at: [1.3, 2.6], before: "sit", after: "sit", event: "flinch", eventProb: u(r, 0.3, 0.9) }, sounds: [{ at: 0, from: "media", level: u(r, 36, 44), cls: "impact", ai: { group: pick(r, ["media", "thud"]), p: 0.6 } }], media: near(TV, r, 0.2) })
  },
  {
    id: "N02_tv_scream",
    emergency: false,
    why: "Screaming from the TV. The sound model sometimes says distress, not media.",
    gen: (r) => ({ title: "TV scream", description: "", emergency: false, person: { from: [1.3, 2.6], to: [u(r, 1, 2), u(r, 2.2, 3)], at: [1.3, 2.6], before: "sit", after: "sit", event: "flinch", eventProb: 0.4 }, sounds: [{ at: 0, from: "media", level: u(r, 36, 44), cls: "scream", ai: { group: pick(r, ["media", "distress"]), p: u(r, 0.5, 0.8) } }], media: near(TV, r, 0.2) })
  },
  {
    id: "N03_drop_while_still",
    emergency: false,
    why: "Drops a heavy object while standing still (no bend, no walk-away).",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Drop while still", description: "", emergency: false, person: { from: to, to, at: to, before: "still", after: "still", event: "none" }, sounds: [{ at: 0, from: "person", level: u(r, 28, 40), cls: "impact", ai: { group: pick(r, ["object", "thud"]), p: 0.65 } }] };
    }
  },
  {
    id: "N04_hard_sit",
    emergency: false,
    why: "Drops hard onto a couch or chair with a thump: burst + thud, then stillness.",
    gen: (r) => {
      const to = pt(r, 1, 2, 2, 3);
      return { title: "Hard sit", description: "", emergency: false, person: { from: near(to, r, 1.2), to, at: near(to, r, 0.2), before: "walk", after: "sit", event: "sit" }, sounds: [{ at: 300, from: "person", level: u(r, 18, 30), cls: "impact", ai: { group: pick(r, ["thud", "object"]), p: 0.6 }, prob: 0.7 }] };
    }
  },
  {
    id: "N05_door_slam",
    emergency: false,
    why: "Door slams out of view while the person moves around or sits.",
    gen: (r) => ({ title: "Door slam", description: "", emergency: false, person: { from: pt(r, 0.8, 2, 0.8, 2), to: pt(r, 1.5, 3, 1.2, 2.5), at: [2.4, 2.2], before: pick(r, ["walk", "sit"]), after: "walk", event: "none" }, sounds: [{ at: 0, from: [u(r, 4.6, 5), u(r, 3.5, 4)], level: u(r, 34, 44), cls: "impact", ai: { group: pick(r, ["object", "thud"]), p: 0.7 } }] })
  },
  {
    id: "N06_phone_knocked",
    emergency: false,
    why: "A phone itself falls to the floor (its own IMU and sonar go wild).",
    gen: (r) => {
      const k = Math.floor(r.next() * 3);
      const anchors = [[0.8, 0.9], [4.2, 0.9], [2.5, 3.2]];
      return { title: "Phone knocked", description: "", emergency: false, person: { from: near(anchors[k], r, 0.8), to: anchors[k], at: anchors[k], before: "walk", after: "walk", event: "none" }, sounds: [{ at: 120, from: { phone: k }, level: u(r, 28, 36), cls: "impact", ai: { group: "object", p: 0.6 } }], knock: k };
    }
  },
  {
    id: "N07_fake_fall",
    emergency: false,
    why: "A compromised phone fabricates a consistent fall while the person is fine.",
    gen: (r) => ({ title: "Fake fall", description: "", emergency: false, person: { from: pt(r, 0.8, 2, 0.8, 2), to: pt(r, 1.5, 3.5, 1.2, 2.8), at: [2.4, 2.3], before: pick(r, ["walk", "sit"]), after: "walk", event: "none" }, sounds: [], compromised: { phone: Math.floor(r.next() * 3), kind: "fake_fall" }, media: r.next() < 0.3 ? TV : void 0 })
  },
  {
    id: "N08_bend_pick_up",
    emergency: false,
    why: "Bends to pick something up; sometimes stays crouched a while.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Bend", description: "", emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.1), before: "walk", after: "still", event: "bend", resumeProb: u(r, 0.3, 0.9) }, sounds: [{ at: 0, from: "person", level: u(r, 20, 36), cls: "impact", ai: { group: "object", p: 0.7 }, prob: 0.6 }] };
    }
  },
  {
    id: "N09_tap_near_phone",
    emergency: false,
    why: "Taps/snaps/sets a cup down right next to a phone (loud to that phone only).",
    gen: (r) => {
      const k = Math.floor(r.next() * 3);
      return { title: "Tap near phone", description: "", emergency: false, person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "none" }, sounds: [{ at: 0, from: { phone: k }, level: u(r, 14, 28), cls: "impact", ai: { group: pick(r, ["tap", "object"]), p: 0.8 } }] };
    }
  },
  {
    id: "N10_animated_call",
    emergency: false,
    why: 'Loud, high-pitched talking on a call: the loudness detector says "scream".',
    gen: (r) => ({ title: "Animated call", description: "", emergency: false, person: { from: [1.3, 2.6], to: pt(r, 1, 3, 1.5, 3), at: [1.3, 2.6], before: pick(r, ["sit", "still", "walk"]), after: "sit", event: "none" }, sounds: [{ at: 0, from: "person", level: u(r, 30, 40), cls: "scream", ai: { group: "speech", p: u(r, 0.6, 0.9) } }, { at: 1500, from: "person", level: u(r, 26, 34), cls: "voice", ai: { group: "speech", p: 0.9 } }] })
  },
  {
    id: "N11_kneel_on_purpose",
    emergency: false,
    why: "Gets down on the floor on purpose (cleaning, cat under the bed), usually gets up.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Kneel", description: "", emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.2), before: "walk", after: "floor", event: "bend", resumeProb: u(r, 0.5, 0.95) }, sounds: [] };
    }
  },
  {
    id: "N12_lie_down_exercise",
    emergency: false,
    why: "Lies down on the floor for stretching: indistinguishable from a collapse by design. Asking is the right answer; calling is not.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Floor exercise", description: "", emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.4), before: "walk", after: "floor", event: "sit", resumeProb: 0.2 }, sounds: [] };
    }
  },
  {
    id: "N13_object_falls_unseen",
    emergency: false,
    why: "Something falls off a shelf while the person sits out of every view.",
    gen: (r) => ({ title: "Shelf item falls, person unseen", description: "", emergency: false, person: { from: [4.6, 3.6], to: [4.6, 3.6], at: [4.6, 3.6], before: "sit", after: "sit", event: "none" }, sounds: [{ at: 0, from: pt(r, 1, 4, 1, 3), level: u(r, 30, 40), cls: "impact", ai: { group: pick(r, ["object", "thud"]), p: 0.65 } }], outOfView: [4.1, 3.1, 5, 4] })
  },
  {
    id: "N14_hammering",
    emergency: false,
    why: "Repetitive knocking/hammering while working at a table.",
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1, 2.8);
      return { title: "Hammering", description: "", emergency: false, person: { from: to, to, at: to, before: "still", after: "still", event: "none" }, sounds: [0, 700, 1400, 2100].map((at) => ({ at, from: "person", level: u(r, 28, 38), cls: "impact", repetitive: true, ai: { group: "object", p: 0.7 } })) };
    }
  }
];

// tools/redteam/holdout.ts
var HOLDOUT = [
  {
    key: "ho_slide_off_bed",
    title: "Slides off the edge of the bed",
    description: "Sitting on the bed edge near Phone 3, slides down to the floor; soft thud sometimes; Phone 1 cannot see.",
    emergency: true,
    person: { from: [2.6, 3], to: [2.6, 3], at: [2.8, 2.6], before: "sit", after: "floor", event: "collapse" },
    sounds: [{ at: 500, from: "person", level: 22, cls: "impact", ai: { group: "thud", p: 0.55 }, prob: 0.6 }],
    occluded: [0]
  },
  {
    key: "ho_pet_knocks_chair",
    title: "Pet knocks over a chair",
    description: "Seated and still on the couch; a chair falls over across the room.",
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "none" },
    sounds: [{ at: 0, from: [3.6, 1], level: 37, cls: "impact", ai: { group: "object", p: 0.65 } }]
  },
  {
    key: "ho_fall_mid_call",
    title: "Falls in the middle of a loud phone call",
    description: "Talking loudly on a call while walking, trips and falls.",
    emergency: true,
    person: { from: [1.2, 1], to: [2.3, 1.8], at: [2.7, 2.3], before: "walk", after: "floor", event: "fall" },
    sounds: [
      { at: -3e3, from: "person", level: 30, cls: "voice", ai: { group: "speech", p: 0.9 } },
      { at: -1500, from: "person", level: 32, cls: "scream", ai: { group: "speech", p: 0.85 } },
      { at: 250, from: "person", level: 36, cls: "impact", ai: { group: "thud", p: 0.7 } }
    ]
  },
  {
    key: "ho_kneels_to_clean",
    title: "Kneels down to clean under the couch",
    description: "Walks over, gets down on the floor on purpose, usually gets up again.",
    emergency: false,
    person: { from: [2.6, 1.2], to: [1.8, 2.2], at: [1.8, 2.4], before: "walk", after: "floor", event: "bend", resumeProb: 0.75 },
    sounds: []
  },
  {
    key: "ho_fall_two_phones",
    title: "Fall with only two phones running",
    description: "Phone 3 is off (charging elsewhere); a real fall in the middle of the room.",
    emergency: true,
    person: { from: [1.6, 1.2], to: [2.4, 1.9], at: [2.7, 2.4], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 36, cls: "impact", ai: { group: "thud", p: 0.7 } }],
    phones: 2
  },
  {
    key: "ho_tv_scream_nap",
    title: "Horror movie scream while napping",
    description: "Dozing still on the couch; the TV screams loudly.",
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "none" },
    sounds: [{ at: 0, from: "media", level: 42, cls: "scream", ai: { group: "media", p: 0.7 } }],
    media: [4.7, 0.9]
  },
  {
    key: "ho_fake_fall_tv",
    title: "Hacked phone fakes a fall during a movie",
    description: "Seated watching TV; compromised Phone 3 reports a fall.",
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: "sit", after: "sit", event: "none" },
    sounds: [],
    media: [4.7, 0.9],
    compromised: { phone: 2, kind: "fake_fall" }
  },
  {
    key: "ho_quiet_fall_hall",
    title: "Quiet fall in the hallway",
    description: "Falls out of every sonar view onto carpet; only a muffled sound.",
    emergency: true,
    person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: "walk", after: "floor", event: "fall" },
    sounds: [{ at: 250, from: "person", level: 25, cls: "impact", ai: { group: "thud", p: 0.6 } }],
    outOfView: [4.1, 3.1, 5, 4]
  }
];

// tools/redteam/run.ts
var fmt = (n) => n === null || n === void 0 ? "-" : Math.round(n).toString();
function evidenceOf(runs) {
  const r = runs[0];
  if (!r) return "no incident";
  return r.reports.map((x) => `${x.name.replace("Phone ", "P")}[imp ${fmt(x.sound.impactDb)}${x.sound.impactAi ? " " + x.sound.impactAi.group : ""} burst ${fmt(x.sonar.burstDb)} saw ${x.sonar.sawPersonBefore ? "Y" : "n"} moved ${x.sonar.motionResumed ? "Y" : "n"} ${x.sonar.online ? "" : "OFF "}${x.sound.distress ? "DISTRESS " : ""}${x.sound.media ? `tv${Math.round(x.sound.media * 100)}` : ""}]`).join(" ");
}
function finals(r) {
  const last = /* @__PURE__ */ new Map();
  for (const p of r.positions) last.set(p.agent, p);
  return [...last.values()];
}
function classify(spec, runs, decision) {
  if (spec.emergency) {
    if (decision === "alarm") return { verdict: "ok", category: "", note: "" };
    if (decision === "ask") return { verdict: "caught_by_question", category: "", note: "asked first; a missing answer calls in 40 s" };
    if (!runs.length) return { verdict: "MISSED", category: "sensing", note: "no phone triggered at all" };
    const reps2 = runs.flatMap((r) => r.reports);
    const strong = reps2.some((x) => x.sonar.burstDb >= 16 && x.sonar.sawPersonBefore) || reps2.some((x) => (x.sound.impactDb ?? 0) >= 20);
    const resumed = reps2.some((x) => x.sonar.motionResumed);
    if (!strong) return { verdict: "MISSED", category: "sensing", note: "evidence too weak to see a fall" };
    if (resumed) return { verdict: "MISSED", category: "sensing", note: "a phone reported movement afterwards (sim noise or fidget read as getting up)" };
    const args = runs.flatMap((r) => finals(r).map((p) => p.argument)).join(" ");
    if (/tv|media|movie/i.test(args)) return { verdict: "MISSED", category: "evidence semantics", note: "TV/media explanation won" };
    if (/tap|object|harmless/i.test(args)) return { verdict: "MISSED", category: "evidence semantics", note: "sound label (tap/object) explained it away" };
    return { verdict: "MISSED", category: "agent reasoning", note: "strong evidence, agents stood down" };
  }
  if (decision === "none") return { verdict: "ok", category: "", note: "" };
  if (decision === "ask") return { verdict: "nuisance_question", category: "escalation policy", note: 'asked "Are you OK?"; they answer and it closes' };
  const reps = runs.flatMap((r) => r.reports);
  const cat = spec.compromised ? "consensus / trust" : spec.media ? "evidence semantics" : reps.some((x) => (x.sound.impactDb ?? 0) >= 15 && x.sonar.burstDb >= 16) ? "sensing" : "agent reasoning";
  return { verdict: "nuisance_countdown", category: cat, note: 'countdown "you may have fallen"; a call only if they cannot answer within 25 s' };
}
async function runSpec(spec, family, variant, seed) {
  const layout = LAYOUT.slice(0, spec.phones ?? 3);
  const trial = generate(spec, seed, layout);
  const runs = await runAgents(trial);
  const decision = agentDecision(runs, trial);
  const negotiates = runs.some((r) => r.outcome.kind === "ask_human" && finals(r).length === 3 && r.incident.trigger.kind !== "help_pressed" && r.incident.trigger.kind !== "scream");
  const screamAsk = runs.some((r) => r.incident.trigger.kind === "scream");
  const effective = decision === "none" && screamAsk ? "ask" : decision;
  const c = classify(spec, runs, effective);
  return {
    family,
    variant,
    seed,
    emergency: spec.emergency,
    phones: layout.length,
    triggers: runs.map((r) => `${r.incident.trigger.name.replace("Phone ", "P")}:${r.incident.trigger.kind}`).join(",") || "-",
    evidence: evidenceOf(runs),
    positions: runs.map((r) => finals(r).map((p) => `${p.agent[0].toUpperCase()}=${p.stance}`).join(" ")).join(" | ") || "-",
    outcome: runs.map((r) => r.outcome.kind).join(",") || "none",
    negotiates,
    screamAsk,
    decision: effective,
    live: effective === "alarm" ? `countdown 25 s -> call unless "I'm OK"` : effective === "ask" ? "ask -> call after 40 s silence" : "nothing",
    ...c
  };
}
var SPEECH = [
  ["I'm okay", "ok"],
  ["i am ok", "ok"],
  ["I'm fine thanks", "ok"],
  ["yeah I am okay", "ok"],
  ["yes", "ok"],
  ["ok", "ok"],
  ["no I'm fine", "ok"],
  ["no no I'm okay don't call", "ok"],
  ["I'm alright", "ok"],
  ["um I'm fine", "ok"],
  ["false alarm", "ok"],
  ["I'm fine I'm fine", "ok"],
  ["I'm good", "ok"],
  ["all good", "ok"],
  ["No, I'm hurt", "help"],
  ["help", "help"],
  ["help me", "help"],
  ["I can't get up", "help"],
  ["I fell", "help"],
  ["I've fallen", "help"],
  ["my hip hurts", "help"],
  ["I'm not okay", "help"],
  ["not okay", "help"],
  ["call an ambulance", "help"],
  ["ow ow it hurts", "help"],
  ["I'm bleeding", "help"],
  ["I'm on the floor", "help"],
  ["please help", "help"],
  ["call my daughter", "help"],
  ["I'm okay but my hip hurts", "help|unclear"],
  ["yeah I'm hurt", "help"],
  ["I can't move my leg", "help"],
  ["no", "unclear"],
  ["nope", "unclear"],
  ["no no no", "unclear"],
  ["", "unclear"],
  ["what", "unclear"],
  ["and then she said the doctor is fine okay so I'll call you later", "unclear"],
  ["the TV is so loud okay whatever let's watch the news", "unclear"],
  // Prompt leakage at the start of the clip (the bug class seen in real runs).
  ["or say help I am okay", "ok"],
  ["say I'm okay or say help I'm fine", "ok"],
  ["are you ok yes", "ok"],
  ["it looks like you may have fallen if you are ok say i am ok", "unclear"],
  ["otherwise i will call for help", "unclear"],
  ["i heard someone cry out are you ok do you need help", "unclear"],
  ["do you need help i'm okay", "ok"],
  ["do you need help no", "unclear"],
  ["are you ok do you need help yes", "unclear"],
  ["do you need help yes", "unclear"],
  // Mis-hearings by the speech model.
  ["I'm o k", "ok|unclear"],
  ["I am fined", "ok|unclear"],
  ["hell me", "help|unclear"],
  ["I can't get op", "help|unclear"]
];
async function main() {
  const holdout = process.argv.includes("--holdout");
  const variants = Number(process.env.RT_VARIANTS ?? 10);
  const rows = [];
  if (!holdout) {
    for (const f of FAMILIES) {
      for (let v = 0; v < variants; v++) {
        const r = new Rng(1e3 + v * 97 + f.id.length * 13 + f.id.charCodeAt(1));
        const spec = { key: `${f.id}#${v}`, family: f.id, ...f.gen(r) };
        spec.emergency = f.emergency;
        rows.push(await runSpec(spec, f.id, v, 11 + v));
      }
    }
  } else {
    for (const h of HOLDOUT) for (let s = 1; s <= 10; s++) rows.push(await runSpec(h, h.key, s, 500 + s));
  }
  (0, import_node_fs.mkdirSync)("redteam-out", { recursive: true });
  const name = holdout ? "holdout" : "families";
  (0, import_node_fs.writeFileSync)(`redteam-out/${name}.json`, JSON.stringify(rows, null, 1));
  const speech = SPEECH.map(([t, want]) => {
    const got = ruleIntent(t).answer;
    return { t, want, got, pass: want.split("|").includes(got) };
  });
  if (!holdout) (0, import_node_fs.writeFileSync)("redteam-out/speech.json", JSON.stringify(speech, null, 1));
  const by = (k) => rows.reduce((a, r) => (a[k(r)] = (a[k(r)] ?? 0) + 1, a), {});
  console.log(`${rows.length} runs (${name})`);
  console.log("verdicts", by((r) => `${r.emergency ? "EMERG" : "normal"} ${r.verdict}`));
  console.log("negotiation would run in", rows.filter((r) => r.negotiates).length, "runs");
  const fam = {};
  for (const r of rows) (fam[r.family] ??= {})[r.verdict] = (fam[r.family]?.[r.verdict] ?? 0) + 1;
  for (const [f, v] of Object.entries(fam)) console.log(f.padEnd(28), JSON.stringify(v), "neg", rows.filter((r) => r.family === f && r.negotiates).length);
  const bad = rows.filter((r) => r.verdict === "MISSED" || r.verdict === "nuisance_countdown");
  console.log("\nfailure categories", by((r) => r.category && (r.verdict === "MISSED" || r.verdict === "nuisance_countdown") ? `${r.verdict}: ${r.category}` : "n/a"));
  for (const r of bad) console.log(`
${r.family}#${r.variant} ${r.verdict} [${r.category}] ${r.note}
  trig ${r.triggers}
  ${r.evidence}
  ${r.positions} -> ${r.outcome}`);
  if (!holdout) {
    console.log("\nspeech", speech.filter((s) => s.pass).length, "/", speech.length);
    for (const s of speech.filter((x) => !x.pass)) console.log(`  FAIL "${s.t}" want ${s.want} got ${s.got}`);
  }
  console.log("\nholdout sha256", (0, import_node_crypto.createHash)("sha256").update((0, import_node_fs.readFileSync)("tools/redteam/holdout.ts")).digest("hex"));
}
main();
