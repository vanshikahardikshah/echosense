// Spoken answer check: a fake phone sees a fall, the hub asks "It looks like you may have fallen",
// the phone answers with a real recording, and we see what the hub understood and did.
// Usage: node tools/e2e-voice.mjs <clip key from test/fixtures/spoken-answers.json> [ws url]
import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
const key = process.argv[2] ?? 'hurt';
const URL = process.argv[3] ?? 'ws://localhost:8090/ws';
const clips = JSON.parse(readFileSync(new globalThis.URL('../test/fixtures/spoken-answers.json', import.meta.url), 'utf8'));
const open = (hello) => new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => { ws.send(JSON.stringify(hello)); res(ws); }); });
const board = [];
const t0 = Date.now();
const at = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const con = await open({ type: 'hello', role: 'console', name: 'c', device: 'test' });
con.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'board') { board.push(m.msg); const b = m.msg; if (b.type === 'incident') console.log(at(), 'incident', b.incident.status); if (b.type === 'outcome') console.log(at(), 'outcome', b.outcome.kind); if (b.type === 'action') console.log(at(), 'action', b.action.action, b.action.detail.slice(0, 140)); if (b.type === 'human') console.log(at(), 'human', b.answer, b.source); } });
const phones = [];
let answered = false;
for (const name of ['A', 'B']) {
  const ws = await open({ type: 'hello', role: 'node', name, device: 'iPhone' });
  ws.on('message', (d) => {
    const m = JSON.parse(d);
    if (m.type === 'caps') console.log(at(), name, 'caps', JSON.stringify(m));
    if (m.type === 'ask') {
      console.log(at(), name, 'ask', m.urgent ? 'URGENT' : 'gentle', m.reason);
      if (name === 'A' && !answered) { answered = true; setTimeout(() => ws.send(JSON.stringify({ type: 'answer_audio', pcm: clips[key], urgent: !!m.urgent, levelDb: -30 })), 3000); }
      // Phone B is further away and only catches a fragment (set B_CLIP to try it).
      if (name === 'B' && process.env.B_CLIP && !ws.answered) { ws.answered = true; setTimeout(() => ws.send(JSON.stringify({ type: 'answer_audio', pcm: clips[process.env.B_CLIP], urgent: !!m.urgent, levelDb: -40 })), 3300); }
    }
    if (m.type === 'heard') console.log(at(), name, 'HEARD', m.answer, JSON.stringify(m.transcript), 'by', m.by);
    if (m.type === 'notice') console.log(at(), name, 'notice:', m.text);
  });
  phones.push(ws);
}
await new Promise((r) => setTimeout(r, 300));
const tel = (o) => ({ type: 'telemetry', telemetry: { nodeId: '', t: Date.now(), status: 'ok', headline: '', subline: '', presence: 'still', mode: 'room', range: 1.4, velocity: 0, snrDb: 20, confirmed: true, breathing: null, linkSnrDb: 24, motionDb: 10, fastMotionDb: 4, staticChangeDb: 2, sonarOk: true, echo: [], maxRange: 3.2, band: [18000, 19000], sim: false, checkIn: null, ...o } });
const start = Date.now();
let fell = false;
const timer = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  const a = t < 6 ? { presence: 'moving', fastMotionDb: 15, motionDb: 20, range: 1.2 } : t < 6.6 ? { presence: 'moving', fastMotionDb: 30, motionDb: 30, range: 1.4 } : { presence: 'still', fastMotionDb: 3, motionDb: 10, range: 1.9 };
  phones[0].send(JSON.stringify(tel(a)));
  phones[1].send(JSON.stringify(tel({ presence: 'still', range: 2.2, fastMotionDb: t > 6 && t < 6.6 ? 26 : 3, motionDb: 10 })));
  if (t > 6.2 && !fell) { fell = true; for (const p of phones) p.send(JSON.stringify({ type: 'sound', sound: { t: 0, cls: 'impact', confidence: 0.9, aboveFloorDb: p === phones[0] ? 32 : 27, peakDb: -20, duration: 0.1, repetitive: false, evidence: '', ai: { group: 'thud', score: 0.6, words: 'Thump, thud' } } })); }
}, 125);
await new Promise((r) => setTimeout(r, Number(process.env.WAIT ?? 60000)));
clearInterval(timer);
const calls = board.filter((b) => b.type === 'action' && b.action.action === 'call').length;
const inc = [...board].reverse().find((b) => b.type === 'incident');
console.log(`\nRESULT clip=${key} final=${inc?.incident.status} calls=${calls}`);
process.exit(0);
