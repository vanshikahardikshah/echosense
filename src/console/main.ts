import { HubClient } from '../app/hub';
import { FONT, fit, inkRamp, palette, rgb } from '../app/ui/draw';
import type { FusionAlert } from '../fusion/fusion';
import { horizontal, PositionTracker, trilaterate } from '../fusion/trilateration';
import type { NodeInfo, Telemetry } from '../net/protocol';
import { initWitness, mapPlaces, onServer, syncPhones } from './witness';

interface NodeView {
  info: NodeInfo;
  tel: Telemetry | null;
  x: number;
  y: number;
  card: HTMLElement | null;
  echo: HTMLCanvasElement;
  echoCtx: CanvasRenderingContext2D;
  lastRangeT: number;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const map = $<HTMLCanvasElement>('map');
const nodesEl = $('nodes');
const feed = $('feed');
const nodes = new Map<string, NodeView>();
const events: { nodeId: string; name: string; alert: FusionAlert; at: number }[] = [];
const tracker = new PositionTracker();
const trail: { x: number; y: number; t: number }[] = [];
let fused: { x: number; y: number; r: number; used: number } | null = null;
let room = { w: 5, d: 4 };
let dragging: NodeView | null = null;

// Persist the floor plan in this browser (convenience only).
function loadLayout(): Record<string, { x: number; y: number }> {
  try {
    const raw = localStorage.getItem('echosense.layout');
    const v = raw ? JSON.parse(raw) : {};
    if (v.room) room = v.room;
    return v.nodes ?? {};
  } catch {
    return {};
  }
}
const layout = loadLayout();
function saveLayout(): void {
  try {
    const out: Record<string, { x: number; y: number }> = {};
    for (const n of nodes.values()) out[n.info.name + '|' + n.info.nodeId] = { x: n.x, y: n.y };
    localStorage.setItem('echosense.layout', JSON.stringify({ room, nodes: { ...layout, ...out } }));
  } catch {
    /* ignore */
  }
}
($('room-w') as HTMLInputElement).value = String(room.w);
($('room-d') as HTMLInputElement).value = String(room.d);
for (const id of ['room-w', 'room-d']) {
  $(id).addEventListener('input', () => {
    room = { w: Number(($('room-w') as HTMLInputElement).value) || 5, d: Number(($('room-d') as HTMLInputElement).value) || 4 };
    saveLayout();
  });
}

function defaultSpot(i: number): { x: number; y: number } {
  const spots = [
    { x: 0.3, y: 0.3 },
    { x: room.w - 0.3, y: 0.3 },
    { x: room.w / 2, y: room.d - 0.3 },
  ];
  return spots[i % spots.length];
}

// ---------------------------------------------------------------- hub
const hub = new HubClient('console', 'Console');
hub.onStatus = (s) => {
  const el = $('hub');
  el.dataset.on = String(s === 'open');
  el.textContent = s === 'open' ? 'Connected to hub' : s === 'connecting' ? 'Connecting' : 'Hub offline';
};
hub.onMessage = (m) => {
  if (onServer(m)) return;
  switch (m.type) {
    case 'nodes':
      syncNodes(m.nodes);
      break;
    case 'telemetry': {
      const n = nodes.get(m.telemetry.nodeId);
      if (n) {
        n.tel = m.telemetry;
        pushEcho(n, m.telemetry.echo);
        if (m.telemetry.range !== null) n.lastRangeT = performance.now();
        renderCard(n);
      }
      break;
    }
    case 'event':
      addEvent(m.nodeId, m.name, m.alert);
      break;
    case 'history':
      for (const e of m.events) addEvent(e.nodeId, e.name, e.alert, false);
      renderFeed();
      break;
  }
};
initWitness(hub);
const url = HubClient.defaultUrl();
if (url) hub.connect(url);

function syncNodes(list: NodeInfo[]): void {
  const ids = new Set(list.map((n) => n.nodeId));
  for (const [id, n] of nodes) {
    if (!ids.has(id)) {
      n.card?.remove();
      nodes.delete(id);
    }
  }
  list.forEach((info, i) => {
    let n = nodes.get(info.nodeId);
    if (!n) {
      const saved = layout[info.name + '|' + info.nodeId];
      const spot = saved ?? defaultSpot(i);
      const echo = document.createElement('canvas');
      echo.width = 300;
      echo.height = 48;
      n = { info, tel: null, x: spot.x, y: spot.y, card: null, echo, echoCtx: echo.getContext('2d')!, lastRangeT: 0 };
      const p = palette();
      n.echoCtx.fillStyle = rgb(p.paper2);
      n.echoCtx.fillRect(0, 0, 300, 48);
      nodes.set(info.nodeId, n);
    }
    n.info = info;
    renderCard(n);
  });
  syncPhones(list.filter((n) => !n.sim));
  updateHeadline();
}

function pushEcho(n: NodeView, row: number[]): void {
  if (!row.length) return;
  const ctx = n.echoCtx;
  ctx.drawImage(n.echo, -1, 0);
  const img = ctx.createImageData(1, 48);
  const ramp = inkRamp();
  for (let c = 0; c < 48; c++) {
    const v = Math.max(0, Math.min(1, ((row[c] ?? 0) - 4) / 28));
    const i = Math.round(v * 255) * 4;
    const o = (47 - c) * 4;
    img.data[o] = ramp[i];
    img.data[o + 1] = ramp[i + 1];
    img.data[o + 2] = ramp[i + 2];
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 299, 0);
}

function renderCard(n: NodeView): void {
  if (!n.card) {
    n.card = document.createElement('article');
    n.card.className = 'node';
    n.card.innerHTML = '<h3></h3><p class="meta"></p><p class="state"></p><canvas></canvas><p class="extra"></p>';
    nodesEl.append(n.card);
  }
  const t = n.tel;
  n.card.dataset.status = t?.status ?? 'ok';
  n.card.dataset.online = String(n.info.online !== false);
  n.card.querySelector('h3')!.textContent = n.info.name;
  const band = t ? `${(t.band[0] / 1000).toFixed(1)} to ${(t.band[1] / 1000).toFixed(1)} kHz` : 'waiting';
  n.card.querySelector('.meta')!.textContent = `${n.info.device}, ${band}${n.info.sim || t?.sim ? ', simulated room' : ''}`;
  n.card.querySelector('.state')!.textContent =
    n.info.online === false ? 'Offline: screen locked or Safari in the background' : t ? t.headline : 'Connecting';
  const extra = t
    ? [
        t.subline,
        t.breathing ? `breathing ${t.breathing.rateBpm.toFixed(0)}/min` : '',
        `link ${t.linkSnrDb.toFixed(0)} dB`,
      ]
        .filter(Boolean)
        .join(', ')
    : '';
  n.card.querySelector('.extra')!.textContent = extra;
  const cv = n.card.querySelector('canvas')!;
  const { w, h, ctx } = fit(cv);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(n.echo, 0, 0, w, h);
}

// ---------------------------------------------------------------- alerts
function addEvent(nodeId: string, name: string, alert: FusionAlert, render = true): void {
  if (events.some((e) => e.alert.id === alert.id)) return;
  events.unshift({ nodeId, name, alert, at: Date.now() });
  if (events.length > 200) events.pop();
  if (render) renderFeed();
}

function renderFeed(): void {
  feed.replaceChildren();
  $('feed-count').textContent = events.length ? String(events.length) : '';
  if (!events.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'No alerts yet.';
    feed.append(li);
  }
  for (const e of events.slice(0, 80)) {
    const li = document.createElement('li');
    li.dataset.sev = e.alert.severity;
    const b = document.createElement('button');
    const time = document.createElement('time');
    time.textContent = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = e.alert.title;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = `${e.name}: ${e.alert.detail}`;
    const ev = document.createElement('ul');
    ev.className = 'evidence';
    ev.hidden = true;
    for (const x of [...e.alert.evidence, `confidence ${(e.alert.confidence * 100).toFixed(0)}%`]) {
      const item = document.createElement('li');
      item.textContent = x;
      ev.append(item);
    }
    b.append(time, title, detail, ev);
    b.addEventListener('click', () => (ev.hidden = !ev.hidden));
    li.append(b);
    feed.append(li);
  }
}

function updateBanner(): void {
  const pending = [...nodes.values()].find((n) => n.tel?.checkIn && (n.tel.checkIn.state === 'pending' || n.tel.checkIn.state === 'escalated'));
  const banner = $('banner');
  if (!pending) {
    banner.hidden = true;
    return;
  }
  banner.hidden = false;
  const c = pending.tel!.checkIn!;
  $('banner-title').textContent = c.state === 'escalated' ? `No response from ${pending.info.name}` : `Checking in: ${pending.info.name}`;
  $('banner-detail').textContent = c.reason;
  $('banner-ok').onclick = () => hub.send({ type: 'respond', nodeId: pending.info.nodeId, answer: 'ok' });
}

function updateHeadline(): void {
  const h = $('c-headline');
  const s = $('c-subline');
  const list = [...nodes.values()];
  if (!list.length) {
    h.textContent = 'Waiting for sensors';
    s.textContent = `Open ${location.origin}/ on each phone. They appear here as they connect.`;
    return;
  }
  const alerting = list.find((n) => n.tel?.status === 'alert');
  if (alerting) {
    h.textContent = alerting.tel!.headline;
    s.textContent = `${alerting.info.name}: ${alerting.tel!.subline}`;
    (h.parentElement as HTMLElement).dataset.status = 'alert';
    return;
  }
  (h.parentElement as HTMLElement).dataset.status = 'ok';
  const present = list.filter((n) => n.tel && n.tel.presence !== 'empty' && n.tel.presence !== 'unknown');
  h.textContent = present.length ? (fused ? 'Someone is in the room' : present[0].tel!.headline) : 'All rooms clear';
  const on = list.filter((n) => n.info.online !== false).length;
  s.textContent = `${on} of ${list.length} sensor${list.length > 1 ? 's' : ''} online${fused ? `, located with ${fused.used} phones` : list.length === 1 ? '. Add a second phone to place people on the map.' : ''}`;
}

// ---------------------------------------------------------------- map
const PAD = 28;
function scale(w: number, h: number): { s: number; ox: number; oy: number } {
  const s = Math.min((w - 2 * PAD) / room.w, (h - 2 * PAD) / room.d);
  return { s, ox: (w - room.w * s) / 2, oy: (h - room.d * s) / 2 };
}

function locate(): void {
  const now = performance.now();
  const ranges = [...nodes.values()]
    .filter((n) => n.info.online !== false && n.tel && n.tel.range !== null && n.tel.confirmed && n.tel.snrDb >= 14 && now - n.lastRangeT < 800)
    .map((n) => ({ id: n.info.nodeId, x: n.x, y: n.y, range: horizontal(n.tel!.range!, 0.35), sigma: 0.15 }));
  if (ranges.length < 2) {
    if (fused && now - (trail[trail.length - 1]?.t ?? 0) > 3000) {
      fused = null;
      tracker.reset();
    }
    return;
  }
  const p = trilaterate(ranges, fused, { minX: 0, maxX: room.w, minY: 0, maxY: room.d });
  if (!p) return;
  const sm = tracker.update(p, now / 1000);
  fused = { x: sm.x, y: sm.y, r: Math.max(0.15, p.residual * Math.min(p.gdop, 4)), used: p.used };
  trail.push({ x: sm.x, y: sm.y, t: now });
  while (trail.length && now - trail[0].t > 8000) trail.shift();
}

function drawMap(): void {
  const { w, h, ctx } = fit(map);
  const p = palette();
  const { s, ox, oy } = scale(w, h);
  const X = (x: number) => ox + x * s;
  const Y = (y: number) => oy + y * s;
  ctx.clearRect(0, 0, w, h);
  // Floor grid every 0.5 m.
  ctx.lineWidth = 1;
  for (let x = 0; x <= room.w + 1e-6; x += 0.5) {
    ctx.strokeStyle = rgb(p.rule, Number.isInteger(x) ? 0.9 : 0.4);
    ctx.beginPath();
    ctx.moveTo(X(x), Y(0));
    ctx.lineTo(X(x), Y(room.d));
    ctx.stroke();
  }
  for (let y = 0; y <= room.d + 1e-6; y += 0.5) {
    ctx.strokeStyle = rgb(p.rule, Number.isInteger(y) ? 0.9 : 0.4);
    ctx.beginPath();
    ctx.moveTo(X(0), Y(y));
    ctx.lineTo(X(room.w), Y(y));
    ctx.stroke();
  }
  ctx.strokeStyle = rgb(p.ink);
  ctx.lineWidth = 2;
  ctx.strokeRect(X(0), Y(0), room.w * s, room.d * s);
  ctx.font = FONT;
  ctx.fillStyle = rgb(p.graphite);
  ctx.fillText(`${room.w} m`, X(room.w / 2) - 10, Y(0) - 8);
  ctx.fillText(`${room.d} m`, X(0) - 24, Y(room.d / 2));

  // Range rings.
  const now = performance.now();
  for (const n of nodes.values()) {
    const t = n.tel;
    if (!t || t.range === null || now - n.lastRangeT > 1500) continue;
    const r = horizontal(t.range, 0.35) * s;
    ctx.strokeStyle = rgb(p.ink, t.confirmed ? 0.45 : 0.2);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(X(n.x), Y(n.y), r, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Trail and fused position.
  if (fused) {
    ctx.strokeStyle = rgb(p.ink, 0.35);
    ctx.lineWidth = 2;
    ctx.beginPath();
    trail.forEach((q, i) => (i ? ctx.lineTo(X(q.x), Y(q.y)) : ctx.moveTo(X(q.x), Y(q.y))));
    ctx.stroke();
    ctx.fillStyle = rgb(p.ink, 0.12);
    ctx.beginPath();
    ctx.arc(X(fused.x), Y(fused.y), fused.r * s, 0, Math.PI * 2);
    ctx.fill();
    const alerting = [...nodes.values()].some((n) => n.tel?.status === 'alert');
    ctx.fillStyle = rgb(alerting ? p.crimson : p.ink);
    ctx.beginPath();
    ctx.arc(X(fused.x), Y(fused.y), 9, 0, Math.PI * 2);
    ctx.fill();
  }
  // Phones.
  for (const n of nodes.values()) {
    const x = X(n.x);
    const y = Y(n.y);
    const off = n.info.online === false;
    ctx.globalAlpha = off ? 0.4 : 1;
    ctx.fillStyle = rgb(n.tel?.status === 'alert' && !off ? p.crimson : p.ink);
    ctx.beginPath();
    const rw = 12;
    const rh = 20;
    ctx.roundRect?.(x - rw / 2, y - rh / 2, rw, rh, 3);
    if (!ctx.roundRect) ctx.rect(x - rw / 2, y - rh / 2, rw, rh);
    ctx.fill();
    ctx.fillStyle = rgb(p.ink);
    ctx.font = '600 13px Barlow, system-ui, sans-serif';
    ctx.fillText(n.info.name, x + 12, y - 8);
    ctx.font = FONT;
    ctx.fillStyle = rgb(p.graphite);
    const t = n.tel;
    ctx.fillText(off ? 'offline' : t ? (t.range !== null ? `${t.range.toFixed(1)} m` : t.presence) : '', x + 12, y + 8);
    ctx.globalAlpha = 1;
  }
  // Places from the room map, located from their distances to the phones.
  for (const pl of mapPlaces) {
    const rs = Object.entries(pl.ranges)
      .map(([id, r]) => ({ n: nodes.get(id), r }))
      .filter((x) => x.n)
      .map((x) => ({ id: x.n!.info.nodeId, x: x.n!.x, y: x.n!.y, range: horizontal(x.r, 0.35), sigma: 0.2 }));
    if (rs.length < 2) continue;
    const q = trilaterate(rs, null, { minX: 0, maxX: room.w, minY: 0, maxY: room.d });
    if (!q) continue;
    ctx.fillStyle = rgb(p.amber);
    ctx.beginPath();
    ctx.moveTo(X(q.x), Y(q.y) - 7);
    ctx.lineTo(X(q.x) + 7, Y(q.y));
    ctx.lineTo(X(q.x), Y(q.y) + 7);
    ctx.lineTo(X(q.x) - 7, Y(q.y));
    ctx.fill();
    ctx.fillStyle = rgb(p.ink);
    ctx.font = '600 12px Barlow, system-ui, sans-serif';
    ctx.fillText(pl.name, X(q.x) + 10, Y(q.y) + 4);
  }
  if (!nodes.size) {
    ctx.fillStyle = rgb(p.graphite);
    ctx.font = '500 16px Barlow, system-ui, sans-serif';
    const msg = 'Sensors appear here when phones connect';
    ctx.fillText(msg, (w - ctx.measureText(msg).width) / 2, h / 2);
  }
}

map.addEventListener('pointerdown', (e) => {
  const r = map.getBoundingClientRect();
  const { s, ox, oy } = scale(r.width, r.height);
  const mx = e.clientX - r.left;
  const my = e.clientY - r.top;
  for (const n of nodes.values()) {
    if (Math.hypot(ox + n.x * s - mx, oy + n.y * s - my) < 24) {
      dragging = n;
      map.setPointerCapture(e.pointerId);
      break;
    }
  }
});
map.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const r = map.getBoundingClientRect();
  const { s, ox, oy } = scale(r.width, r.height);
  dragging.x = Math.max(0, Math.min(room.w, (e.clientX - r.left - ox) / s));
  dragging.y = Math.max(0, Math.min(room.d, (e.clientY - r.top - oy) / s));
  tracker.reset();
});
map.addEventListener('pointerup', () => {
  if (dragging) saveLayout();
  dragging = null;
});

function tick(): void {
  locate();
  drawMap();
  updateBanner();
  updateHeadline();
  for (const n of nodes.values()) if (n.card) {
    const cv = n.card.querySelector('canvas')!;
    const { w, h, ctx } = fit(cv);
    ctx.drawImage(n.echo, 0, 0, w, h);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);
