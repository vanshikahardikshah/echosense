import { createHash } from 'node:crypto';
/**
 * EchoSense hub: serves the phone app and the console, relays telemetry and
 * alerts over WebSocket, assigns each phone its own ultrasonic band, and can
 * forward alerts to a chat webhook (Discord or Slack).
 *
 *   node dist/server.cjs [--port 8080] [--https] [--webhook URL]
 *
 * Phones need a secure origin (https) to use the microphone. Options:
 *   - On this computer: http://localhost:8080 counts as secure.
 *   - A tunnel with a real certificate: cloudflared tunnel --url http://localhost:8080
 *   - --https: a self-signed certificate (accept the warning on the phone).
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { WebSocket, WebSocketServer } from 'ws';
import { startBus } from '../agents/bus';
import type { HomeMap } from '../agents/cartographer';
import type { HomeMemory } from '../agents/memory';
import { Council } from '../agents/council';
import { evaluate, formatTable, METHODS, cell } from '../agents/eval';
import { checkKey, llmFromEnv } from '../agents/llm';
import { saysHelpOutright, stripPromptEcho, understand } from '../agents/intent';
import { Budget, type BudgetState } from '../agents/budget';
import { pcm16ToFloat, SpeechToText } from './stt';
import { gatherReply, Notifier, notifyFromEnv } from '../agents/notify';
import { ROLE_INFO } from '../agents/roles';
import type { FusionAlert } from '../fusion/fusion';
import type { ClientMsg, NodeInfo, ServerMsg, Telemetry } from '../net/protocol';

interface Args {
  port: number;
  https: boolean;
  webhook: string;
  bands: number;
  root: string;
  caregiver: string;
  publicUrl: string;
}

/** Loads KEY=value lines from .env next to where the hub is started (keys, phone numbers). */
function loadEnvFile(): void {
  const file = path.resolve(process.cwd(), '.env');
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const v = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnvFile();

function parseArgs(): Args {
  const a = process.argv.slice(2);
  const get = (k: string) => {
    const i = a.indexOf(k);
    return i >= 0 ? a[i + 1] : undefined;
  };
  return {
    port: Number(get('--port') ?? process.env.PORT ?? 8080),
    https: a.includes('--https'),
    webhook: get('--webhook') ?? process.env.ECHOSENSE_WEBHOOK ?? '',
    bands: Number(get('--bands') ?? 0),
    root: get('--root') ?? path.resolve(__dirname, '..', 'public'),
    caregiver: get('--caregiver') ?? '',
    publicUrl: get('--public-url') ?? '',
  };
}

const args = parseArgs();

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.wav': 'audio/wav',
  '.map': 'application/json',
};

// ---------------------------------------------------------------- spoken prompts
// iPhones will not speak with speech synthesis while the microphone is on, so
// the hub records the prompts once with the computer's own voice and the
// phones play them as audio. On a Mac this uses "say"; elsewhere espeak-ng.
const VOICE_LINES: Record<string, string> = {
  ask1: "Are you OK? Say I'm OK, or say help.",
  ask2: "Are you OK? Please answer. If I don't hear from you, I will call your family.",
  urgent1: "It looks like you may have fallen. If you are OK, say I'm OK. Otherwise I will call for help.",
  urgent2: "I'm about to call for help. Say I'm OK if you are OK.",
  again1: "Sorry, I didn't catch that. Say I'm OK, or say help.",
  again2: 'Please say I am OK, or say help.',
  glad: "Okay, glad you're OK.",
  toldok: "Okay. I've told your family you're OK.",
  help: 'Help has been called. Stay where you are.',
  onway: 'Help is on the way.',
};
/** Recordings are named by their words, so changed wording is recorded again. */
const voiceFile = (k: string) => `${k}-${createHash('sha1').update(VOICE_LINES[k] ?? k).digest('hex').slice(0, 8)}.wav`;
const voiceDir = path.resolve(process.cwd(), '.voice');
function makeVoice(): void {
  try {
    mkdirSync(voiceDir, { recursive: true });
    for (const [k, text] of Object.entries(VOICE_LINES)) {
      const out = path.join(voiceDir, voiceFile(k));
      if (existsSync(out)) continue;
      if (process.platform === 'darwin') {
        execFileSync('say', ['-r', '165', '--file-format=WAVE', '--data-format=LEI16@22050', '-o', out, text], { stdio: 'ignore' });
      } else {
        execFileSync('espeak-ng', ['-s', '150', '-w', out, text], { stdio: 'ignore' });
      }
    }
  } catch (e) {
    console.warn('[hub] could not record the spoken prompts (phones fall back to speech synthesis):', (e as Error).message);
  }
}
makeVoice();

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
  const u = new URL(req.url ?? '/', 'http://x');
  let p = decodeURIComponent(u.pathname);
  const voice = /^\/voice\/([a-z0-9]+)\.wav$/.exec(p);
  if (voice) {
    const f = path.join(voiceDir, VOICE_LINES[voice[1]] ? voiceFile(voice[1]) : `${voice[1]}.wav`);
    if (existsSync(f)) {
      res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'public, max-age=3600' });
      res.end(readFileSync(f));
    } else {
      res.writeHead(404);
      res.end();
    }
    return;
  }
  if (p === '/') p = '/index.html';
  if (p === '/console') p = '/console.html';
  if (p === '/twilio/gather' && req.method === 'POST') {
    onGather(req, res, u);
    return;
  }
  if (p === '/webex/actions' && req.method === 'POST') {
    onWebex(req, res);
    return;
  }
  const card = /^\/agents\/([a-z0-9.-]+)\/\.well-known\/agent-card\.json$/.exec(p);
  if (card) {
    const a = (agentDirectory() as { agents: { name: string }[] }).agents.find((x) => x.name === card[1] || x.name.endsWith(`.${card[1]}`));
    res.writeHead(a ? 200 : 404, { 'content-type': 'application/json' });
    res.end(a ? JSON.stringify(agentCard(a as Parameters<typeof agentCard>[0]), null, 2) : '{}');
    return;
  }
  if (p === '/agents' || p === '/.well-known/agents.json') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(agentDirectory(), null, 2));
    return;
  }
  if (p === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, nodes: nodes.size, consoles: consoles.size }));
    return;
  }
  const file = path.normalize(path.join(args.root, p));
  if (!file.startsWith(args.root) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': p.startsWith('/models/') ? 'public, max-age=86400' : 'no-cache',
    // Allows the microphone and motion sensors on this origin.
    'permissions-policy': 'microphone=(self), accelerometer=(self), gyroscope=(self)',
  });
  res.end(readFileSync(file));
}

// ---------------------------------------------------------------- state
interface NodeConn {
  ws: WebSocket;
  info: NodeInfo;
  last: Telemetry | null;
  dropTimer: ReturnType<typeof setTimeout> | null;
}
const nodes = new Map<string, NodeConn>();
const consoles = new Set<WebSocket>();
const history: { nodeId: string; alert: FusionAlert; name: string }[] = [];
let bandCount = Math.max(1, Math.min(3, args.bands || 1));
let counter = 0;

// ---------------------------------------------------------------- witness agents
const notifyCfg = notifyFromEnv(process.env, args.webhook);
if (args.caregiver) notifyCfg.to = args.caregiver.split(',').map((x) => x.trim()).filter(Boolean);
if (args.publicUrl) notifyCfg.publicUrl = args.publicUrl.replace(/\/+$/, '');
const notifier = new Notifier(notifyCfg);
const llm = llmFromEnv();
const usageFile = path.resolve(process.cwd(), 'claude-usage.json');
const budget = new Budget(
  Number(process.env.ECHOSENSE_CLAUDE_DAILY_USD ?? 0.5),
  () => llm.model,
  (() => {
    try {
      return existsSync(usageFile) ? (JSON.parse(readFileSync(usageFile, 'utf8')) as BudgetState) : null;
    } catch {
      return null;
    }
  })(),
  (st) => {
    try {
      writeFileSync(usageFile, JSON.stringify(st));
    } catch {
      /* best effort */
    }
  },
);
const stt = new SpeechToText(process.cwd(), (line) => console.log(`[hub] ${line}`), () => {
  for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: 'caps', stt: true });
  toConsoles({ type: 'council_status', status: council.status() });
});
let council!: Council;
const mapFile = path.resolve(process.cwd(), 'homemap.json');
const memoryFile = path.resolve(process.cwd(), 'homememory.json');
const trainingFile = path.resolve(process.cwd(), 'training.jsonl');
async function startAgents(): Promise<void> {
  const bus = await startBus({
    enabled: process.env.ECHOSENSE_SLIM !== '0',
    home: (process.env.ECHOSENSE_HOME ?? 'home').toLowerCase().replace(/[^a-z0-9-]/g, '-'),
    endpoint: process.env.SLIM_ENDPOINT || undefined,
    listen: process.env.SLIM_LISTEN ?? '127.0.0.1:46357',
    secret: process.env.SLIM_SECRET ?? 'echosense-witness-local-secret-0123456789',
    log: (line) => console.log(`[witness] ${line}`),
  });
  council = new Council({
  bus,
  notifier,
  llm,
  publish: (msg, from) => toConsoles({ type: 'board', msg, from }),
  askPhones: (incidentId, reason, urgent, seconds) => {
    for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: 'ask', incidentId, reason, urgent, seconds });
  },
  clearPhones: () => {
    for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: 'respond', answer: 'ok' });
  },
  urgentMs: Number(process.env.ECHOSENSE_URGENT_SECONDS ?? 25) * 1000,
  speechStatus: () => stt.status,
  budget,
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || undefined,
  tellPhones: (text) => {
    for (const n of nodes.values()) if (n.info.online !== false) send(n.ws, { type: 'notice', text });
  },
  log: (line) => console.log(line),
  askTimeoutMs: Number(process.env.ECHOSENSE_ASK_TIMEOUT ?? 40) * 1000,
  loadMap: () => {
    try {
      return existsSync(mapFile) ? (JSON.parse(readFileSync(mapFile, 'utf8')) as HomeMap) : null;
    } catch {
      return null;
    }
  },
  saveMap: (m) => {
    try {
      writeFileSync(mapFile, JSON.stringify(m, null, 1));
    } catch (e) {
      console.warn('[witness] could not save the room map:', (e as Error).message);
    }
  },
  loadMemory: () => {
    try {
      return existsSync(memoryFile) ? (JSON.parse(readFileSync(memoryFile, 'utf8')) as HomeMemory) : null;
    } catch {
      return null;
    }
  },
  saveMemory: (m) => {
    try {
      writeFileSync(memoryFile, JSON.stringify(m));
    } catch (e) {
      console.warn('[witness] could not save the home memory:', (e as Error).message);
    }
  },
  });
  await council.start();
  stt.start();
  if (llm.mode !== 'off')
    void checkKey(llm).then((r) => (council.llmHealth = r === 'OK' ? 'OK' : r.slice(0, 160), console.log(r === 'OK' ? '[witness] Claude key check: OK, the agents are live' : `[witness] Claude key check FAILED: ${r}. Agents will use rules until this is fixed.`)));
  setInterval(() => {
    if (consoles.size) toConsoles({ type: 'council_status', status: council.status() });
  }, 3000);
  webexStatus = await notifier.registerWebex(webexSecret);
}
let webexStatus = '';

/** A spoken answer to "Are you OK?": words on this computer, then meaning (rules and Claude, help wins). */
/**
 * Several phones hear the same answer. Each one's recording is turned into
 * words, and after a short moment the answers are judged together: the
 * clearest recording (the loudest, so the closest phone, preferring the one
 * that caught the most words) decides, so one phone catching only "No." of
 * "No, I'm fine" cannot call for help on its own. A plain cry for help heard
 * by any phone still counts.
 */
interface HeardClip {
  n: { ws: WebSocket; info: NodeInfo };
  nodeId: string;
  transcript: string;
  levelDb: number;
  urgent: boolean;
}
let answerGroup: { clips: HeardClip[]; timer: ReturnType<typeof setTimeout> } | null = null;

async function onAnswerAudio(n: { ws: WebSocket; info: NodeInfo }, nodeId: string, pcm: string, urgent: boolean, levelDb?: number): Promise<void> {
  let transcript = '';
  const samples = pcm16ToFloat(pcm);
  const secs = samples.length / 16000;
  saveAnswer(n.info.name, pcm);
  try {
    transcript = stt.transcribe(samples);
  } catch (e) {
    console.warn('[hub] speech to text failed:', (e as Error).message);
  }
  if (!transcript) {
    const why = !stt.ready ? `speech recognition is ${stt.status}` : levelDb !== undefined && levelDb < -50 ? `the voice was very quiet on that phone (${levelDb} dB); speak closer to it` : `${secs.toFixed(1)} s clip${levelDb !== undefined ? ` at ${levelDb} dB` : ''}, no words found`;
    console.log(`[hub] ${n.info.name}: no words recognised (${why}). Clip saved in .voice/answers`);
  } else console.log(`[hub] ${n.info.name} heard "${transcript}"${levelDb !== undefined ? ` at ${levelDb} dB` : ''}`);
  const clip: HeardClip = { n, nodeId, transcript, levelDb: levelDb ?? -60, urgent };
  if (!answerGroup) answerGroup = { clips: [], timer: setTimeout(() => void judgeAnswers(), 2500) };
  answerGroup.clips.push(clip);
}

async function judgeAnswers(): Promise<void> {
  const group = answerGroup;
  answerGroup = null;
  if (!group) return;
  const t0 = Date.now();
  const heard = group.clips.filter((c) => c.transcript.trim());
  const words = (c: HeardClip) => stripPromptEcho(c.transcript).split(' ').filter(Boolean).length;
  const loudest = Math.max(-99, ...heard.map((c) => c.levelDb));
  // Among the recordings within 8 dB of the clearest one, the one that caught the most words.
  const best = heard.filter((c) => c.levelDb >= loudest - 8).sort((a, b) => words(b) - words(a) || b.levelDb - a.levelDb)[0];
  const cry = heard.find((c) => saysHelpOutright(c.transcript));
  const chosen = cry ?? best;
  const urgent = group.clips.some((c) => c.urgent);
  const transcript = chosen?.transcript ?? '';
  const u = await understand(transcript, llm.mode === 'off' ? null : llm, urgent, (use) => {
    if (use.input_tokens || use.output_tokens) {
      budget.add(use);
      return true;
    }
    return budget.canSpend();
  });
  const others = group.clips.filter((c) => c !== chosen).map((c) => `${c.n.info.name}: "${c.transcript || '(no words)'}"`);
  console.log(`[hub] answer from ${group.clips.length} phone(s): "${transcript}" (${chosen?.n.info.name ?? 'none'}) -> ${u.answer} (${u.by}, ${Date.now() - t0} ms)`);
  for (const c of group.clips) send(c.n.ws, { type: 'heard', answer: u.answer, transcript, by: u.by });
  council.note(
    `${group.clips.length > 1 ? `${group.clips.length} phones heard the answer; ${cry ? 'a plain call for help' : 'the clearest recording'} (${chosen?.n.info.name ?? 'none'})` : (chosen?.n.info.name ?? group.clips[0].n.info.name)} said "${transcript || '(no words recognised)'}": ${u.answer === 'ok' ? 'they are OK' : u.answer === 'help' ? 'they want help' : 'not clear, asking again'} (understood by ${u.by})${others.length ? `. Also heard: ${others.join('; ')}` : ''}`,
  );
  if (u.answer !== 'unclear' && chosen) {
    const handled = council.personSaid(chosen.nodeId, chosen.n.info.name, transcript, u.answer, u.injury);
    if (!handled && u.answer === 'ok') for (const c of group.clips) send(c.n.ws, { type: 'notice', text: "Okay, glad you're OK." });
  }
}

/** An A2A Agent Card for one Witness agent (reachable on the SLIM channel, A2A messages as JSON). */
function agentCard(a: { name: string; title: string; description: string; skills: string[]; address: string; reasoning?: string }): unknown {
  return {
    protocolVersion: '0.3.0',
    name: a.title,
    description: a.description,
    version: '1.0.0',
    url: `slim://${a.address}`,
    preferredTransport: 'SLIM',
    additionalInterfaces: [{ url: `slim://${a.address}`, transport: 'SLIM group session witness/home/board (MLS), A2A Message JSON' }],
    provider: { organization: 'EchoSense Witness' },
    capabilities: { streaming: false, pushNotifications: false },
    defaultInputModes: ['application/json'],
    defaultOutputModes: ['application/json'],
    skills: a.skills.map((s) => ({ id: s, name: s.replace(/[._]/g, ' '), description: `${a.title}: ${s}`, tags: ['home-safety', 'witness'] })),
    metadata: { reasoning: a.reasoning ?? 'local' },
  };
}

/** Keep the last few spoken answers as WAV files (on this computer only), to check what the phones heard. */
function saveAnswer(phone: string, b64: string): void {
  try {
    const dir = path.join(voiceDir, 'answers');
    mkdirSync(dir, { recursive: true });
    const pcm = Buffer.from(b64, 'base64');
    const h = Buffer.alloc(44);
    h.write('RIFF', 0);
    h.writeUInt32LE(36 + pcm.length, 4);
    h.write('WAVEfmt ', 8);
    h.writeUInt32LE(16, 16);
    h.writeUInt16LE(1, 20);
    h.writeUInt16LE(1, 22);
    h.writeUInt32LE(16000, 24);
    h.writeUInt32LE(32000, 28);
    h.writeUInt16LE(2, 32);
    h.writeUInt16LE(16, 34);
    h.write('data', 36);
    h.writeUInt32LE(pcm.length, 40);
    writeFileSync(path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${phone.replace(/\W+/g, '')}.wav`), Buffer.concat([h, pcm]));
    const files = readdirSync(dir).sort();
    for (const f of files.slice(0, Math.max(0, files.length - 20))) rmSync(path.join(dir, f), { force: true });
  } catch {
    /* best effort */
  }
}

function agentDirectory(): unknown {
  const info = council.status().bus as { kind: string; channel: string; encrypted: boolean };
  const channel = info.channel;
  // A small agent directory in the spirit of AGNTCY / OASF records.
  const roles = Object.entries(ROLE_INFO).filter(([id]) => id !== 'investigator').map(([id, r]) => ({
    name: `witness.${id}`,
    title: r.title,
    description: r.goal,
    skills: ['evidence.read', 'position.post', 'negotiate.offer', 'negotiate.challenge', 'negotiate.concede', 'negotiate.accept', 'phones.look_again', 'cartographer.ask'],
    inputs: ['EvidenceReport[]', 'ContextNote', 'Position[] (round 1)', 'Move[] (the negotiation so far)'],
    outputs: ['Position', 'Move (offer, challenge, concede, counter, accept)', 'AgentTrace'],
    reasoning: llm.mode === 'agent' ? `local position for free; ${llm.model} for its negotiation moves when the agents disagree` : 'local, deterministic, free',
    address: `${channel.replace(/\/board$/, '')}/${id}`,
  }));
  const phones = [...council.agents.values()]
    .filter((a) => !a.nodeId.startsWith('sim-'))
    .map((a) => ({
      name: `witness.phone.${a.nodeId}`,
      title: a.name,
      description: 'Turns its own sonar, sound and motion stream into evidence reports.',
      skills: ['trigger.raise', 'evidence.report'],
      outputs: ['EvidenceReport'],
      address: `${channel.replace(/\/board$/, '')}/phone-${a.nodeId}`,
    }));
  return {
    protocol: 'witness/1',
    transport: info.kind === 'slim' ? `AGNTCY SLIM group session ${channel}${info.encrypted ? ' (MLS)' : ''}` : `in memory ${channel}`,
    outcomeRule: 'escalate if no agent stands down and two or more escalate; stand down if none escalates and two or more stand down; otherwise ask the person',
    messages: 'every channel message is an A2A Message (role agent, one data part, contextId = incident id)',
    patterns: 'group chat: the incident board and the negotiation (moderated MLS group); broadcast: an agent asks every phone to look again; addressed: one phone',
    agentCards: '/agents/<name>/.well-known/agent-card.json',
    negotiation: 'when the role agents disagree they negotiate a plan in up to 3 rounds (offer, challenge, concede, counter, accept); no deal keeps the disagreement on the record and asks the person (no answer calls for help); Claude spend capped at ECHOSENSE_CLAUDE_DAILY_USD a day',
    agents: [
      ...roles,
      {
        name: 'witness.cartographer',
        title: 'Cartographer',
        description: 'Knows the room map. Does not vote; answers where a sound came from and where the person ended up.',
        skills: ['map.locate_source', 'map.locate_person'],
        outputs: ['ContextNote'],
        address: `${channel.replace(/\/board$/, '')}/cartographer`,
      },
      ...phones.map((p) => ({ ...p, skills: [...p.skills, 'look.now'] })),
    ],
  };
}

function onGather(req: http.IncomingMessage, res: http.ServerResponse, u: URL): void {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    const params = Object.fromEntries(new URLSearchParams(body));
    const full = `${notifier.cfg.publicUrl}${u.pathname}${u.search}`;
    const sig = req.headers['x-twilio-signature'];
    if (!notifier.verify(full, params, typeof sig === 'string' ? sig : undefined)) {
      console.warn('[witness] rejected a key press callback with a bad signature');
      res.writeHead(403);
      res.end();
      return;
    }
    const digit = params.Digits ?? '';
    council.caregiver(u.searchParams.get('incident') ?? '', digit);
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end(gatherReply(digit));
  });
}

const webexSecret = process.env.WEBEX_WEBHOOK_SECRET ?? randomBytes(16).toString('hex');
function onWebex(req: http.IncomingMessage, res: http.ServerResponse): void {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const sig = req.headers['x-spark-signature'];
    console.log('[witness] Webex called the hub (a card button was pressed)');
    if (!Notifier.verifyWebex(raw, webexSecret, typeof sig === 'string' ? sig : undefined)) {
      console.warn('[witness] Webex call rejected: bad signature (restart the hub so it registers again)');
      res.writeHead(403);
      res.end();
      return;
    }
    res.writeHead(200);
    res.end();
    let id = '';
    try {
      id = (JSON.parse(raw) as { data?: { id?: string } }).data?.id ?? '';
    } catch {
      return;
    }
    void notifier.webexAction(id).then((a) => {
      if (!a) {
        console.warn('[witness] Webex: could not read which button was pressed');
        return;
      }
      console.log(`[witness] Webex: ${a.person} pressed ${a.answer}`);
      council.caregiver(a.incident, a.answer === 'on_my_way' ? '1' : '2', a.person);
    });
  });
}

let evalCache: { rows: import('../net/protocol').EvalRow[]; totals: string[]; trials: number } | null = null;
async function runEval(): Promise<NonNullable<typeof evalCache>> {
  if (evalCache) return evalCache;
  const trials = 40;
  const t = await evaluate(trials);
  console.log('\n' + formatTable(t) + '\n');
  const rows = t.scenarios.map(({ spec, scores }) => ({
    title: spec.title,
    emergency: spec.emergency,
    heldOut: !!spec.heldOut,
    cells: METHODS.map((m) => cell(scores[m], spec.emergency)),
  }));
  const totals = METHODS.map((m) => {
    const s = t.totals[m];
    const emerg = s.caught + s.caughtAfterAsk + s.missed;
    return `missed ${s.missed} of ${emerg} falls, ${s.falseAlarms} false alarms in ${s.trials - emerg}, asked ${s.prompts}`;
  });
  evalCache = { rows, totals, trials };
  return evalCache;
}

function send(ws: WebSocket, m: ServerMsg): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
}
function toConsoles(m: ServerMsg): void {
  for (const c of consoles) send(c, m);
}
function nodeList(): NodeInfo[] {
  return [...nodes.values()].map((n) => n.info);
}

/** Give every phone its own slice of the ultrasonic band (frequency division). */
function rebalanceBands(): void {
  const want = args.bands || Math.max(bandCount, Math.min(3, nodes.size));
  if (want === bandCount && [...nodes.values()].every((n) => n.info.bandCount === bandCount)) return;
  bandCount = want;
  const used = new Set<number>();
  for (const n of nodes.values()) {
    let idx = n.info.bandIndex;
    if (idx >= bandCount || used.has(idx)) {
      idx = 0;
      while (used.has(idx)) idx++;
    }
    used.add(idx);
    n.info.bandIndex = idx;
    n.info.bandCount = bandCount;
    send(n.ws, { type: 'band', bandIndex: idx, bandCount });
  }
  toConsoles({ type: 'nodes', nodes: nodeList() });
}

async function forward(name: string, a: FusionAlert): Promise<void> {
  // The agents now decide what reaches people; raw phone alerts only go out when asked to.
  if (!args.webhook || process.env.ECHOSENSE_RAW_ALERTS !== '1' || (a.severity !== 'critical' && a.severity !== 'warning')) return;
  const text = `EchoSense, ${name}: ${a.title}. ${a.detail} (${Math.round(a.confidence * 100)}% confidence)`;
  try {
    await fetch(args.webhook, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      // `content` is read by Discord, `text` by Slack.
      body: JSON.stringify({ content: text, text }),
    });
  } catch (e) {
    console.warn('Webhook failed:', (e as Error).message);
  }
}

function onConnection(ws: WebSocket): void {
  let role: 'node' | 'console' | null = null;
  let nodeId = '';
  ws.on('message', (raw) => {
    let m: ClientMsg;
    try {
      m = JSON.parse(String(raw));
    } catch {
      return;
    }
    if (m.type === 'hello') {
      role = m.role;
      if (role === 'console') {
        consoles.add(ws);
        send(ws, { type: 'nodes', nodes: nodeList() });
        send(ws, { type: 'history', events: history.slice(-100) });
        for (const n of nodes.values()) if (n.last) send(ws, { type: 'telemetry', telemetry: n.last });
        send(ws, { type: 'board_history', msgs: council.board.slice(-300) });
        send(ws, { type: 'council_status', status: council.status() });
        return;
      }
      const prev = m.nodeId ? nodes.get(m.nodeId) : undefined;
      if (prev && prev.info.online === false) {
        // Same phone coming back (screen was locked): keep its name, band and place on the map.
        nodeId = m.nodeId!;
        prev.ws = ws;
        prev.info.online = true;
        prev.info.lastSeen = Date.now();
        if (prev.dropTimer) clearTimeout(prev.dropTimer);
        console.log(`[hub] ${prev.info.name} reconnected`);
        send(ws, { type: 'welcome', nodeId, bandIndex: prev.info.bandIndex, bandCount, serverTime: Date.now() });
        send(ws, { type: 'caps', stt: stt.ready });
        toConsoles({ type: 'nodes', nodes: nodeList() });
        return;
      }
      const num = /^node-(\d+)$/.exec(m.nodeId ?? '');
      if (num) counter = Math.max(counter, Number(num[1]));
      nodeId = m.nodeId && !nodes.has(m.nodeId) ? m.nodeId : `node-${++counter}`;
      const used = new Set([...nodes.values()].map((n) => n.info.bandIndex));
      let idx = 0;
      while (used.has(idx)) idx++;
      const info: NodeInfo = {
        nodeId,
        name: `Phone ${nodeId.replace('node-', '')}`,
        device: m.device,
        bandIndex: idx,
        bandCount,
        connectedAt: Date.now(),
        lastSeen: Date.now(),
        sim: !!m.sim,
        online: true,
      };
      nodes.set(nodeId, { ws, info, last: null, dropTimer: null });
      console.log(`[hub] ${info.name} connected (${m.device}${m.sim ? ', simulated' : ''})`);
      if (args.bands === 0) bandCount = Math.max(bandCount, Math.min(3, nodes.size));
      info.bandIndex = Math.min(info.bandIndex, bandCount - 1);
      info.bandCount = bandCount;
      send(ws, { type: 'welcome', nodeId, bandIndex: info.bandIndex, bandCount, serverTime: Date.now() });
      send(ws, { type: 'caps', stt: stt.ready });
      rebalanceBands();
      toConsoles({ type: 'nodes', nodes: nodeList() });
      return;
    }
    if (m.type === 'ping') {
      send(ws, { type: 'pong', t: m.t, serverTime: Date.now() });
      return;
    }
    if (role === 'node') {
      const n = nodes.get(nodeId);
      if (!n) return;
      n.info.lastSeen = Date.now();
      if (m.type === 'telemetry') {
        const tel = { ...m.telemetry, nodeId };
        n.last = tel;
        n.info.sim = tel.sim;
        toConsoles({ type: 'telemetry', telemetry: tel });
        if (!tel.sim) council.onTelemetry(nodeId, n.info.name, tel);
      } else if (m.type === 'sound') {
        if (!n.info.sim) council.onSound(nodeId, n.info.name, m.sound);
      } else if (m.type === 'answer_audio') {
        void onAnswerAudio(n, nodeId, m.pcm, !!m.urgent, m.levelDb);
      } else if (m.type === 'event') {
        if (!n.info.sim) council.onAlert(nodeId, n.info.name, m.alert);
        const e = { nodeId, alert: m.alert, name: n.info.name };
        history.push(e);
        if (history.length > 500) history.shift();
        console.log(`[hub] ${n.info.name}: ${m.alert.severity} ${m.alert.title}`);
        toConsoles({ type: 'event', ...e });
        void forward(n.info.name, m.alert);
      }
    } else if (role === 'console' && m.type === 'respond') {
      const n = nodes.get(m.nodeId);
      if (n) send(n.ws, { type: 'respond', answer: m.answer });
    } else if (role === 'console' && m.type === 'council') {
      void onCouncil(ws, m);
    }
  });
  ws.on('close', () => {
    if (role === 'console') consoles.delete(ws);
    const n = nodes.get(nodeId);
    if (role === 'node' && n?.ws === ws) {
      // Keep it on the map for a while: phones drop off whenever the screen locks.
      console.log(`[hub] ${n.info.name} went offline`);
      n.info.online = false;
      toConsoles({ type: 'nodes', nodes: nodeList() });
      n.dropTimer = setTimeout(() => {
        if (nodes.get(nodeId) !== n || n.info.online) return;
        console.log(`[hub] ${n.info.name} removed`);
        nodes.delete(nodeId);
        if (nodes.size === 0 && args.bands === 0) bandCount = 1;
        toConsoles({ type: 'nodes', nodes: nodeList() });
      }, 120000);
    }
  });
}

async function onCouncil(ws: WebSocket, m: Extract<ClientMsg, { type: 'council' }>): Promise<void> {
  switch (m.action) {
    case 'run_scenario':
      council.runScenario(m.key, m.seed);
      break;
    case 'compromise':
      council.setCompromised(m.nodeId, m.on);
      break;
    case 'inject_fake':
      council.injectFake(m.nodeId);
      break;
    case 'human':
      council.human(m.incidentId, m.answer, 'answered at the console');
      break;
    case 'mark_place': {
      const r = await council.markPlace(m.name, m.kind);
      send(ws, { type: 'map_result', ...r });
      break;
    }
    case 'test_webex': {
      const r = await notifier.webex('test', 'EchoSense test', 'If you can read this, Webex alerts work.', [{ title: 'From', value: 'the hub console' }], false);
      toConsoles({ type: 'board', msg: { type: 'action', action: { incidentId: '-', action: 'webex', ok: r.ok, detail: `test: ${r.detail}`, t: Date.now() } } });
      break;
    }
    case 'label_incident': {
      const rec = council.incidentRecord(m.incidentId);
      let detail: string;
      if (!rec) detail = 'training: that incident is no longer in memory';
      else if (rec.incident.simulated) detail = 'training: simulated incidents are not saved, only real ones';
      else {
        appendFileSync(trainingFile, JSON.stringify({ label: m.label, subtype: m.subtype, location: m.location, heldOut: m.heldOut, labelledAt: Date.now(), ...rec }) + '\n');
        const lines = readFileSync(trainingFile, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x) as { label: string; incident: { id: string } });
        const last = new Map(lines.map((x) => [x.incident.id, x.label]));
        const falls = [...last.values()].filter((x) => x === 'fall').length;
        detail = `training: saved ${m.subtype.replace(/_/g, ' ')} at ${m.location.replace(/_/g, ' ')}${m.heldOut ? ' (HELD OUT)' : ''}. So far ${falls} falls, ${last.size - falls} not falls.`;
      }
      toConsoles({ type: 'board', msg: { type: 'action', action: { incidentId: '-', action: 'ask_phone', ok: !!rec, detail, t: Date.now() } } });
      break;
    }
    case 'test_ask': {
      let n = 0;
      for (const node of nodes.values()) if (node.info.online !== false) {
        send(node.ws, { type: 'ask', incidentId: 'test', reason: 'This is a test of the spoken check-in.' });
        n++;
      }
      toConsoles({ type: 'board', msg: { type: 'action', action: { incidentId: '-', action: 'ask_phone', ok: n > 0, detail: n ? `test: asked "Are you OK?" on ${n} phone${n > 1 ? 's' : ''}. Answer out loud; the result shows under Alerts.` : 'test: no phone connected', t: Date.now() } } });
      break;
    }
    case 'remove_place':
      council.removePlace(m.id);
      break;
    case 'label_phone':
      council.labelPhone(m.nodeId, m.label, m.near);
      break;
    case 'llm_mode':
      if (!council.setLlmMode(m.mode)) {
        toConsoles({ type: 'board', msg: { type: 'action', action: { incidentId: '-', action: 'ask_phone', ok: false, detail: 'Claude needs ANTHROPIC_API_KEY in .env (then restart the hub)', t: Date.now() } } });
      }
      break;
    case 'sim_calls':
      council.realCallsForSims = m.on;
      break;
    case 'eval': {
      const e = await runEval();
      send(ws, { type: 'eval', ...e });
      break;
    }
    case 'test_call': {
      const r = await notifier.call('test', 'This is an EchoSense test call. Your phone number is set up correctly.');
      toConsoles({ type: 'board', msg: { type: 'action', action: { incidentId: '-', action: 'call', ok: r.ok, detail: `test call: ${r.detail}`, t: Date.now() } } });
      break;
    }
  }
  toConsoles({ type: 'council_status', status: council.status() });
}

// ---------------------------------------------------------------- https
function lanAddresses(): string[] {
  const out: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

function selfSigned(): { key: Buffer; cert: Buffer } {
  const dir = path.resolve(process.cwd(), 'certs');
  const key = path.join(dir, 'echosense-key.pem');
  const cert = path.join(dir, 'echosense-cert.pem');
  if (!existsSync(key) || !existsSync(cert)) {
    mkdirSync(dir, { recursive: true });
    const san = ['DNS:localhost', ...lanAddresses().map((a) => `IP:${a}`)].join(',');
    const base = ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '30', '-subj', '/CN=EchoSense local'];
    try {
      execFileSync('openssl', [...base, '-addext', `subjectAltName=${san}`], { stdio: 'ignore' });
    } catch {
      execFileSync('openssl', base, { stdio: 'ignore' });
    }
  }
  return { key: readFileSync(key), cert: readFileSync(cert) };
}

// Plain http for this computer and the tunnel; https on the local network for the phones
// (a self-signed certificate: the phone asks once, then it works with no tunnel at all).
const server = http.createServer(serveStatic);
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('connection', onConnection);
let secure: https.Server | null = null;
const httpsPort = Number(process.env.HTTPS_PORT ?? (args.https && args.port !== 8080 ? args.port : 8443));
if (!process.argv.includes('--no-https')) {
  try {
    secure = https.createServer(selfSigned(), serveStatic);
    new WebSocketServer({ server: secure, path: '/ws' }).on('connection', onConnection);
  } catch (e) {
    console.warn('[hub] no local https (openssl missing?):', (e as Error).message);
  }
}

/** The tunnel script writes its current public link here; follow it without a restart. */
const tunnelFile = path.resolve(process.cwd(), 'tunnel-url.txt');
let tunnelSeen = '';
setInterval(() => {
  try {
    if (!existsSync(tunnelFile)) return;
    const url = readFileSync(tunnelFile, 'utf8').trim().replace(/\/+$/, '');
    if (!url || url === tunnelSeen) return;
    tunnelSeen = url;
    notifier.cfg.publicUrl = url;
    console.log(`[hub] public link is now ${url}`);
    void notifier.registerWebex(webexSecret).then((st) => {
      webexStatus = st;
      console.log(`[hub] Webex: ${st}`);
    });
  } catch {
    /* ignore */
  }
}, 3000);

process.on('unhandledRejection', (e) => console.warn('[hub] background task failed:', (e as Error)?.message ?? e));
void startAgents().then(() => {
  const port = args.https && args.port === httpsPort ? 8080 : args.port;
  server.listen(port, '0.0.0.0');
  secure?.listen(httpsPort, '0.0.0.0');
  const lan = lanAddresses();
  const lines = [
    '',
    'EchoSense hub is running.',
    '',
    `  Console (this computer):   http://localhost:${port}/console`,
    secure
      ? `  Phones (same wifi):        ${lan.map((a) => `https://${a}:${httpsPort}/`).join('   ') || `https://<this computer's IP>:${httpsPort}/`}`
      : '',
    secure ? '                             First time on each phone: tap "Show Details", then "visit this website".' : '',
    secure ? '                             If the phones cannot load it, put the laptop and phones on one phone\'s Personal Hotspot.' : '',
    `  Public link (Webex buttons): run  sh tools/tunnel.sh  in another window`,
    '',
    args.webhook ? '  Agent decisions are posted to your webhook.' : '',
    `  Witness agents: ${llm.mode === 'off' ? (llm.apiKey ? 'Claude off (switch it on in the console)' : 'rule reasoning (set ANTHROPIC_API_KEY in .env for Claude)') : llm.mode === 'agent' ? `local agents; when they disagree they negotiate with Claude (${llm.model}, at most $${budget.dailyUsd.toFixed(2)} a day)` : `Claude ${llm.mode} with ${llm.model}`}`,
    `  Caregiver alerts: ${notifier.describe()}`,
    `  Webex: ${webexStatus}`,
    `  Agent channel: ${(() => { const b = council.status().bus as { kind: string; channel: string; encrypted: boolean }; return b.kind === 'slim' ? `AGNTCY SLIM ${b.channel}${b.encrypted ? ', MLS encrypted' : ''}` : `in memory (${b.channel})`; })()}`,
    '',
  ];
  console.log(lines.filter((l, i, a) => l || a[i - 1]).join('\n'));
});
