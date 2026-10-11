// Room map check: mark the sofa while standing there, then an incident ends at the sofa.
import { WebSocket } from 'ws';
const URL = 'ws://localhost:8090/ws';
const open = (hello) => new Promise((res) => { const ws = new WebSocket(URL); ws.on('open', () => { ws.send(JSON.stringify(hello)); res(ws); }); });
const board = [];
const con = await open({ type: 'hello', role: 'console', name: 'c', device: 'test' });
con.on('message', (d) => { const m = JSON.parse(d); if (m.type === 'board') board.push(m.msg); if (m.type === 'map_result') console.log('MARK', m.detail); });
const A = await open({ type: 'hello', role: 'node', name: 'A', device: 'iPhone', nodeId: 'node-1' });
const B = await open({ type: 'hello', role: 'node', name: 'B', device: 'iPhone', nodeId: 'node-2' });
const tel = (o) => ({ type: 'telemetry', telemetry: { nodeId: '', t: Date.now(), status: 'ok', headline: '', subline: '', presence: 'still', mode: 'room', range: 1.4, velocity: 0, snrDb: 20, confirmed: true, breathing: null, linkSnrDb: 24, motionDb: 10, fastMotionDb: 4, staticChangeDb: 2, sonarOk: true, echo: [], maxRange: 3.2, band: [18000, 19000], sim: false, checkIn: null, ...o } });
let phase = 'sofa';
const start = Date.now();
const timer = setInterval(() => {
  const t = (Date.now() - start) / 1000;
  if (phase === 'sofa') { A.send(JSON.stringify(tel({ range: 1.8 }))); B.send(JSON.stringify(tel({ range: 2.6 }))); }
  else {
    // walk around, then drop quickly onto the sofa, then rest (no impact)
    const k = t - 6;
    const a = k < 4 ? { presence: 'moving', fastMotionDb: 15, motionDb: 20, range: 1.2 } : k < 4.6 ? { presence: 'moving', fastMotionDb: 22, motionDb: 25, range: 1.6 } : { presence: 'still', fastMotionDb: 3, motionDb: 10, range: 1.8 };
    const b = k < 4 ? { presence: 'moving', fastMotionDb: 15, motionDb: 20, range: 2.0 } : k < 4.6 ? { presence: 'moving', fastMotionDb: 21, motionDb: 25, range: 2.4 } : { presence: 'still', fastMotionDb: 3, motionDb: 10, range: 2.6 };
    A.send(JSON.stringify(tel(a))); B.send(JSON.stringify(tel(b)));
  }
}, 125);
await new Promise((r) => setTimeout(r, 4500));
con.send(JSON.stringify({ type: 'council', action: 'mark_place', name: 'Sofa', kind: 'sofa' }));
await new Promise((r) => setTimeout(r, 1500));
phase = 'walk';
await new Promise((r) => setTimeout(r, 26000));
clearInterval(timer);
for (const b of board) {
  if (b.type === 'context') console.log('CARTOGRAPHER', b.context.notes.join(' | '));
  if (b.type === 'position' && b.position.round === 2) console.log(b.position.agent, b.position.stance, '|', b.position.argument);
  if (b.type === 'outcome') console.log('OUTCOME', b.outcome.kind, b.outcome.headline);
}
process.exit(0);
