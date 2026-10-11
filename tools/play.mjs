import { WebSocket } from 'ws';
const ws = new WebSocket('ws://localhost:8090/ws');
await new Promise((r) => ws.on('open', r));
ws.send(JSON.stringify({ type: 'hello', role: 'console', name: 'c', device: 't' }));
ws.send(JSON.stringify({ type: 'council', action: 'run_scenario', key: process.argv[2] }));
await new Promise((r) => setTimeout(r, 500)); process.exit(0);
