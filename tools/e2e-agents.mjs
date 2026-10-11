// Live path check: two fake phones stream telemetry, sounds and alerts to the hub
// exactly like the app does; a console watches the Witness board.
import { WebSocket } from 'ws';
const URL = process.argv[2] ?? 'ws://localhost:8090/ws';
const open = (hello) => new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => { ws.send(JSON.stringify(hello)); res(ws); }); });
const board = [];
const con = await open({ type: 'hello', role: 'console', name: 'c', device: 'test' });
con.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'board') { board.push(m.msg); const b = m.msg; console.log('board', b.type, b.type === 'position' ? `${b.position.agent} R${b.position.round} ${b.position.stance}` : b.type === 'outcome' ? b.outcome.kind : b.type === 'incident' ? `${b.incident.status} ${b.incident.trigger.kind}` : b.type === 'action' ? `${b.action.action} ${b.action.detail}` : b.type === 'human' ? b.answer : ''); } });
const phones = [];
for (const name of ['A', 'B']) {
  const ws = await open({ type: 'hello', role: 'node', name, device: 'iPhone' });
  ws.asks = 0;
  ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'ask') ws.asks++; if (m.type === 'notice') console.log(name, 'notice:', m.text); });
  phones.push(ws);
}
await new Promise((r) => setTimeout(r, 300));
const tel = (o) => ({ type: 'telemetry', telemetry: { nodeId: '', t: Date.now(), status: 'ok', headline: '', subline: '', presence: 'still', mode: 'room', range: 1.4, velocity: 0, snrDb: 20, confirmed: true, breathing: null, linkSnrDb: 24, motionDb: 10, fastMotionDb: 4, staticChangeDb: 2, sonarOk: true, echo: [], maxRange: 3.2, band: [18000, 19000], sim: false, checkIn: null, ...o } });
const start = Date.now();
let fell = false;
// 8 Hz telemetry for 30 s. Person in front of phone A walks, then at 6 s falls quietly (burst, then nothing).
const timer = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  const a = t < 6 ? { presence: 'moving', fastMotionDb: 15, motionDb: 20, range: 1.2 } : t < 6.6 ? { presence: 'moving', fastMotionDb: 23, motionDb: 26, range: 1.4 } : { presence: 'still', fastMotionDb: 3, motionDb: 10, range: 1.7 };
  phones[0].send(JSON.stringify(tel(a)));
  phones[1].send(JSON.stringify(tel({ presence: 'empty', range: null, confirmed: false, fastMotionDb: 2, motionDb: 4 })));
  if (t > 6.2 && !fell) { fell = true; for (const p of phones) p.send(JSON.stringify({ type: 'sound', sound: { t: 0, cls: 'impact', confidence: 0.8, aboveFloorDb: p === phones[0] ? 30 : 24, peakDb: -20, duration: 0.1, repetitive: false, evidence: '' } })); }
}, 125);
await new Promise((r) => setTimeout(r, 22000));
clearInterval(timer);
const outcome = board.find((b) => b.type === 'outcome');
console.log('\nOUTCOME', outcome?.outcome.kind, '|', outcome?.outcome.headline, '| asks on phones:', phones.map((p) => p.asks));
// The person answers on phone A.
phones[0].send(JSON.stringify({ type: 'event', nodeId: '', alert: { id: 'r1', t: 0, kind: 'resolved', severity: 'info', title: "Check-in answered: OK", detail: '', confidence: 1, evidence: [] } }));
await new Promise((r) => setTimeout(r, 500));
console.log('HUMAN', board.filter((b) => b.type === 'human').map((b) => b.answer + ' ' + b.source));
// Hacked phone B fakes a fall while A watches the person sitting still.
const ids = await (await fetch(URL.replace('ws', 'http').replace('/ws', '/agents'))).json();
console.log('DIRECTORY', ids.agents.map((a) => a.name).join(', '));
process.exit(0);
