import { WebSocket } from 'ws';
const URL = 'ws://localhost:8090/ws';
const open = (hello) => new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => { ws.send(JSON.stringify(hello)); res(ws); }); });
const board = [];
const con = await open({ type: 'hello', role: 'console', name: 'c', device: 'test' });
con.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'board') board.push(m.msg); });
const phones = [];
for (const name of ['A', 'B']) { const ws = await open({ type: 'hello', role: 'node', name, device: 'iPhone', nodeId: 'x-' + name }); ws.asks = 0; ws.on('message', (d) => { if (JSON.parse(d).type === 'ask') ws.asks++; }); phones.push(ws); }
const tel = (o) => ({ type: 'telemetry', telemetry: { nodeId: '', t: Date.now(), status: 'ok', headline: '', subline: '', presence: 'still', mode: 'room', range: 1.4, velocity: 0, snrDb: 20, confirmed: true, breathing: null, linkSnrDb: 24, motionDb: 10, fastMotionDb: 4, staticChangeDb: 2, sonarOk: true, echo: [], maxRange: 3.2, band: [18000, 19000], sim: false, checkIn: null, ...o } });
const start = Date.now();
const timer = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  // A watches someone sitting quietly; small shift at 14 s.
  const a = t > 14 && t < 14.6 ? { presence: 'moving', fastMotionDb: 15, motionDb: 17 } : { presence: 'still', fastMotionDb: 4, motionDb: 11, range: 1.3 };
  phones[0].send(JSON.stringify(tel(a)));
  phones[1].send(JSON.stringify(tel({ presence: 'empty', range: null, confirmed: false, fastMotionDb: 2, motionDb: 4 })));
}, 125);
await new Promise((r) => setTimeout(r, 9000));
con.send(JSON.stringify({ type: 'council', action: 'inject_fake', nodeId: 'x-B' }));
await new Promise((r) => setTimeout(r, 9000));
clearInterval(timer);
const o = board.find((b) => b.type === 'outcome');
for (const b of board.filter((b) => b.type === 'position' && b.position.round === 2)) console.log(b.position.agent, b.position.stance, '|', b.position.argument);
console.log('OUTCOME', o?.outcome.kind, o?.outcome.quarantined, 'asks', phones.map((p) => p.asks));
process.exit(0);
