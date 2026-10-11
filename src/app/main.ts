import type { SoundEvent } from '../audio/passive';
import { GROUP_WORDS, groupsBetween, impactLabel, type AiFrame, type SoundGroup } from '../audio/soundLabels';
import type { FromAi, ToAi } from './soundai-worker';
import { Band, bandPlan, LOW_BAND, WIDE_BAND } from '../dsp/chirp';
import type { EngineSnapshot } from '../engine/engine';
import type { FusionAlert } from '../fusion/fusion';
import type { Telemetry } from '../net/protocol';
import { SCENARIOS } from '../sim/scenarios';
import { AudioIO } from './audio';
import { HubClient } from './hub';
import { drawHeat, drawLine, palette } from './ui/draw';
import { Echogram } from './ui/echogram';
import type { ToWorker } from './worker';

// ---------------------------------------------------------------- settings
interface Settings {
  mode: 'room' | 'body';
  zone: number;
  level: number;
  timeout: number;
  hub: string;
}
const DEFAULTS: Settings = { mode: 'room', zone: 1.2, level: 0.5, timeout: 30, hub: '' };
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem('echosense.settings');
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : { ...DEFAULTS };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(): void {
  try {
    localStorage.setItem('echosense.settings', JSON.stringify(settings));
  } catch {
    /* private mode: settings last for this visit only */
  }
}
const settings = loadSettings();

// ---------------------------------------------------------------- dom
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const onboard = $('onboard');
const live = $('live');
const statusBox = $('status');
const headline = $('headline');
const subline = $('subline');
const liveDot = $('live-dot');
const simBadge = $('sim-badge');
const eventsEl = $('events');
const eventsCount = $('events-count');
const rRange = $('r-range');
const rBreath = $('r-breath');
const rSound = $('r-sound');
const breathBox = $('breath-box');
const breathLabel = $('breath-label');
const breathTrace = $<HTMLCanvasElement>('breath-trace');
const checkin = $('checkin');
const ciTitle = $('ci-title');
const ciReason = $('ci-reason');
const ciCount = $('ci-count');
const ciOk = $<HTMLButtonElement>('ci-ok');
const ciHelp = $<HTMLButtonElement>('ci-help');
const startErr = $('start-error');

// ---------------------------------------------------------------- state
const audio = new AudioIO();
let worker: Worker | null = null;
let echogram: Echogram | null = null;
let lastSnap: EngineSnapshot | null = null;
let simMode = false;
let currentBand: Band = WIDE_BAND;
let hubBandCount = 1;
// Band probe: if this device hears its own sonar badly in the default band, try a lower one once.
const probe = { state: 'idle' as 'idle' | 'trying' | 'done', defaultDb: 0, since: 0, note: '' };
function bandProbe(s: EngineSnapshot): void {
  if (simMode || s.sonarPhase !== 'running' || hubBandCount > 1) return;
  const now = performance.now();
  if (!probe.since) probe.since = now;
  if (now - probe.since < 5000) return;
  const link = s.sonar.linkSnrDb;
  if (probe.state === 'idle' && currentBand === WIDE_BAND) {
    probe.since = 0;
    if (link >= 14) {
      probe.state = 'done';
      probe.note = `default band works (${link.toFixed(0)} dB)`;
      return;
    }
    probe.state = 'trying';
    probe.defaultDb = link;
    currentBand = LOW_BAND;
    post({ type: 'recalibrate', band: LOW_BAND });
    probe.note = `default band weak (${link.toFixed(0)} dB): trying ${LOW_BAND.f0 / 1000} to ${LOW_BAND.f1 / 1000} kHz`;
  } else if (probe.state === 'trying') {
    probe.state = 'done';
    probe.since = 0;
    if (link >= probe.defaultDb + 3) probe.note = `using ${LOW_BAND.f0 / 1000} to ${LOW_BAND.f1 / 1000} kHz: ${link.toFixed(0)} dB here vs ${probe.defaultDb.toFixed(0)} dB in the default band`;
    else {
      probe.note = `lower band no better (${link.toFixed(0)} dB): back to the default band. Check the volume, and on a Mac set Mic Mode to Standard`;
      currentBand = WIDE_BAND;
      post({ type: 'recalibrate', band: WIDE_BAND });
    }
  }
}
let fs = 48000;
let epoch = 0; // wall clock ms at engine t = 0
const alerts: FusionAlert[] = [];
let spokenCheckIn = '';
let localDismissed = '';
let melCols: Float32Array[] = [];
let micInfo = '';
// ---------------------------------------------------------------- sound recognition (YAMNet)
let aiWorker: Worker | null = null;
const aiFrames: AiFrame[] = [];
let aiStatus = 'not started';
function startAi(rate: number): void {
  aiWorker?.terminate();
  aiFrames.length = 0;
  aiStatus = 'loading the model (4 MB)';
  aiWorker = new Worker('dist/soundai-worker.js');
  aiWorker.onmessage = (e: MessageEvent<FromAi>) => {
    const m = e.data;
    if (m.type === 'ready') aiStatus = `ready (loaded in ${(m.ms / 1000).toFixed(1)} s)`;
    else if (m.type === 'error') aiStatus = `off: ${m.message}`;
    else if (m.type === 'clip') sendClip(m.pcm, m.levelDb);
    else {
      aiFrames.push(m.frame);
      while (aiFrames.length > 80) aiFrames.shift();
      aiStatus = `running, ${m.ms.toFixed(0)} ms per half second`;
      post({ type: 'ai', frame: m.frame });
      showHeard(m.frame);
      listenForWords(m.frame);
    }
  };
  aiWorker.postMessage({ type: 'init', fs: rate, url: new URL('models/yamnet.bin', location.href).href, classesUrl: new URL('models/yamnet-classes.json', location.href).href } satisfies ToAi);
}
// ---------------------------------------------------------------- spoken answers
/**
 * While "Are you OK?" is open, the sound model notices when someone talks.
 * The phone then sends just that answer (a few seconds of audio) to the hub,
 * which turns it into words on the hub itself and works out what they mean:
 * "I'm fine" closes the check-in, "No, I'm hurt" calls for help. Nothing else
 * is ever recorded or sent.
 */
let hubStt = false;
let speakingUntil = 0;
/** Last time anyone was heard talking (not the phone itself). */
let lastTalkAt = 0;
/** Someone was already talking when the question started: a call or a conversation, not an answer. */
let talkingAtPrompt = false;
let gapAfterPrompt = false;
const answerState = { checkIn: '', start: 0, last: 0, waiting: false, tries: 0 };
function listenForWords(f: AiFrame): void {
  const c = lastSnap?.fusion.checkIn;
  const now = performance.now();
  if (now < speakingUntil) return; // the phone hears itself
  const talking = f.groups.speech >= 0.45 && f.groups.media < 0.35;
  const crying = f.groups.distress >= 0.5;
  if (talking) lastTalkAt = now;
  if (!hubStt || hub.status !== 'open' || !c || c.state !== 'pending') {
    answerState.start = 0;
    return;
  }
  if (answerState.checkIn !== c.id) Object.assign(answerState, { checkIn: c.id, start: 0, last: 0, waiting: false, tries: 0 });
  if (answerState.waiting) return;
  // In the middle of a phone call the talking carries on through the question. An answer
  // comes after a pause; until there is one, nothing counts.
  if (talkingAtPrompt && !gapAfterPrompt) {
    if (!talking && now - lastTalkAt >= 1200) gapAfterPrompt = true;
    else return;
  }
  // An answer starts within 10 s of the question; later talk waits for the next question.
  if (!answerState.start && now - speakingUntil > 10000) return;
  if (talking || crying) {
    if (!answerState.start) answerState.start = now;
    answerState.last = now;
    showListening('Listening...');
  }
  // Done when they pause for a moment, or after 7 s of talking.
  if (answerState.start && (now - answerState.last > 1300 || now - answerState.start > 7000)) {
    // A little lead-in before the first word, but never reaching back into the phone's own question.
    const seconds = Math.min(10, (now - answerState.start) / 1000 + 1.0, Math.max(0.5, (now - speakingUntil) / 1000));
    answerState.start = 0;
    answerState.waiting = true;
    showListening('Understanding what you said...');
    aiWorker?.postMessage({ type: 'clip', seconds } satisfies ToAi);
    // Never hang on a lost reply.
    setTimeout(() => (answerState.waiting = false), 9000);
  }
}
function sendClip(pcm: Int16Array, levelDb: number): void {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  hub.send({ type: 'answer_audio', pcm: btoa(bin), urgent: !!lastSnap?.fusion.checkIn?.urgent, levelDb: Math.round(levelDb) });
}
function showListening(text: string): void {
  if (!checkin.hidden) setText(ciCount, text);
}
function onHeard(m: { answer: 'ok' | 'help' | 'unclear'; transcript: string }): void {
  answerState.waiting = false;
  const said = m.transcript ? `"${m.transcript}"` : 'something';
  if (m.answer === 'ok') {
    showNotice(`Heard ${said}: you are OK.`);
    post({ type: 'respond', answer: 'ok' });
  } else if (m.answer === 'help') {
    showNotice(`Heard ${said}: calling for help.`);
    post({ type: 'respond', answer: 'help' });
  } else {
    showNotice(`Heard ${said}, but not sure what you meant.`);
    answerState.tries++;
    speak(answerState.tries >= 2 ? 'Please say I am OK, or say help.' : "Sorry, I didn't catch that. Say I'm OK, or say help.");
  }
}

// Show what the sound model hears in the activity list (on this phone only), so you can see it work.
const quietLabels = /^(Silence|Inside, |Static|Noise|White noise|Pink noise|Hum|Mains hum|Outside, |Animal|Wild animals|Snoring|Breathing)/;
let lastHeard = { label: '', at: 0 };
function showHeard(f: AiFrame): void {
  const top = f.top[0];
  if (!top || top.score < 0.35 || quietLabels.test(top.name)) return;
  const now = performance.now();
  if (now - lastHeard.at < 3000 || (top.name === lastHeard.label && now - lastHeard.at < 10000)) return;
  lastHeard = { label: top.name, at: now };
  const g = impactLabel(f.groups);
  const harmless = ['tap', 'speech', 'media', 'footsteps', 'object'].includes(g.group);
  alerts.unshift({
    id: `heard-${now}`,
    t: f.t,
    kind: 'sound',
    severity: 'info',
    title: `Heard: ${top.name} ${Math.round(top.score * 100)}%`,
    detail: harmless ? `${GROUP_WORDS[g.group]}: not treated as a fall` : GROUP_WORDS[g.group],
    confidence: top.score,
    evidence: f.top.map((x) => `${x.name} ${Math.round(x.score * 100)}%`),
  });
  if (alerts.length > 60) alerts.pop();
  renderEvents();
}

/** Share of the last span seconds that sounded like TV or music, and like talking. */
function scene(span = 12): { media: number; speech: number; label: string } | null {
  const last = aiFrames[aiFrames.length - 1];
  if (!last) return null;
  const fr = aiFrames.filter((f) => f.t > last.t - span);
  const media = fr.filter((f) => f.groups.media >= 0.3).length / fr.length;
  const speech = fr.filter((f) => f.groups.speech >= 0.5).length / fr.length;
  return { media, speech, label: last.top[0]?.name ?? '' };
}
let txInfo = { f0: 0, f1: 0, crest: 0 };
let motionGranted: boolean | null = null;
const hub = new HubClient('node', `EchoSense ${navigator.userAgent.includes('iPhone') ? 'iPhone' : 'phone'}`, () => ({ sim: simMode }));

// ---------------------------------------------------------------- start
function requestMotion(): Promise<boolean> {
  const D = window.DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> } | undefined;
  if (D && typeof D.requestPermission === 'function') {
    // iOS: must be called synchronously inside the tap handler.
    return D.requestPermission().then((r) => r === 'granted').catch(() => false);
  }
  return Promise.resolve(typeof window.DeviceMotionEvent !== 'undefined');
}

async function keepAwake(): Promise<void> {
  try {
    const nav = navigator as Navigator & { wakeLock?: { request: (t: 'screen') => Promise<unknown> } };
    await nav.wakeLock?.request('screen');
  } catch {
    /* not available: ask the user to disable auto-lock (see runbook) */
  }
}

$('start').addEventListener('click', () => {
  // iOS only allows speech after a tap: say nothing once now, so later prompts can speak.
  try {
    if ('speechSynthesis' in window) speechSynthesis.speak(new SpeechSynthesisUtterance(' '));
  } catch {
    /* ignore */
  }
  setTimeout(preloadVoice, 3000);
  const motion = requestMotion();
  audio.createContext();
  void keepAwake();
  startLive(motion).catch((err: unknown) => {
    const name = err instanceof Error ? err.name : '';
    startErr.hidden = false;
    startErr.textContent =
      name === 'NotAllowedError'
        ? 'Microphone access was declined. Allow it in Settings, Safari, Microphone, then reload this page.'
        : location.protocol === 'http:' && location.hostname !== 'localhost'
          ? 'The microphone needs a secure (https) address. Open the https link shown by the hub.'
          : `Could not start the microphone (${err instanceof Error ? err.message : String(err)}).`;
    audio.stop();
  });
});

$('start-sim').addEventListener('click', () => startSim('demo'));

async function startLive(motion: Promise<boolean>): Promise<void> {
  const info = await audio.start();
  fs = info.fs;
  micInfo = `${info.deviceLabel}${info.worklet ? '' : ' (fallback capture)'}`;
  if (info.echoCancellation) micInfo += ', echo cancellation still on';
  motionGranted = await motion;
  if (motionGranted) window.addEventListener('devicemotion', onMotion);
  audio.setLevel(settings.level);
  if (new URLSearchParams(location.search).get('ai') !== '0') startAi(fs);
  audio.onAudio = (buf) => {
    aiWorker?.postMessage({ type: 'audio', buf: buf.slice() } satisfies ToAi);
    worker?.postMessage({ type: 'audio', buf } satisfies ToWorker, [buf.buffer]);
  };
  simMode = false;
  startWorker();
  showLive();
  connectHub();
}

function startSim(name: string): void {
  simMode = true;
  fs = 48000;
  startWorker(name);
  showLive();
  connectHub();
}

function startWorker(sim?: string): void {
  worker?.terminate();
  worker = new Worker('dist/engine-worker.js');
  worker.onmessage = onWorker;
  epoch = 0;
  post({
    type: 'init',
    fs,
    band: currentBand,
    mode: settings.mode,
    fusion: { zoneRadius: settings.zone, checkInTimeout: settings.timeout },
    sim,
  });
  simBadge.hidden = !sim;
  liveDot.dataset.on = 'false';
  liveDot.textContent = sim ? 'Preparing' : 'Starting';
}

function post(m: ToWorker, transfer: Transferable[] = []): void {
  worker?.postMessage(m, transfer);
}

function showLive(): void {
  onboard.hidden = true;
  live.hidden = false;
  if (!echogram) echogram = new Echogram($<HTMLCanvasElement>('echogram'), 96, 3.2);
  echogram.clear();
  requestAnimationFrame(frame);
}

function onMotion(e: DeviceMotionEvent): void {
  const a = e.accelerationIncludingGravity;
  const r = e.rotationRate;
  if (!a || a.x === null) return;
  post({
    type: 'imu',
    s: {
      t: performance.now() / 1000,
      ax: a.x ?? 0,
      ay: a.y ?? 0,
      az: a.z ?? 0,
      gx: r?.alpha ?? 0,
      gy: r?.beta ?? 0,
      gz: r?.gamma ?? 0,
    },
  });
}

// ---------------------------------------------------------------- worker messages
type FromWorker =
  | { type: 'ready'; txPeriod: Float32Array; n: number; fps: number; f0: number; f1: number; crest: number }
  | { type: 'txPeriod'; txPeriod: Float32Array; f0: number; f1: number }
  | { type: 'tx'; gain: number }
  | { type: 'snapshot'; snap: EngineSnapshot }
  | { type: 'alert'; alert: FusionAlert }
  | { type: 'sound'; sound: unknown }
  | { type: 'sim'; state: 'rendering' | 'playing' | 'ended'; name: string; duration?: number };

function onWorker(e: MessageEvent<FromWorker>): void {
  const m = e.data;
  switch (m.type) {
    case 'ready':
      txInfo = { f0: m.f0, f1: m.f1, crest: m.crest };
      if (!simMode) audio.setTxPeriod(m.txPeriod);
      $('band-info').textContent = `Sonar band ${(m.f0 / 1000).toFixed(1)} to ${(m.f1 / 1000).toFixed(1)} kHz, ${m.fps.toFixed(0)} pings per second`;
      break;
    case 'txPeriod':
      txInfo.f0 = m.f0;
      txInfo.f1 = m.f1;
      if (!simMode) audio.setTxPeriod(m.txPeriod);
      $('band-info').textContent = `Sonar band ${(m.f0 / 1000).toFixed(1)} to ${(m.f1 / 1000).toFixed(1)} kHz`;
      echogram?.clear();
      break;
    case 'tx':
      if (!simMode) audio.setTxEnabled(m.gain);
      break;
    case 'snapshot':
      onSnapshot(m.snap);
      break;
    case 'alert':
      onAlert(m.alert);
      break;
    case 'sound': {
      // Only labels and levels leave the phone, never audio. Wait for the
      // sound model to hear the moment, then send what it recognised too.
      const ev = m.sound as SoundEvent;
      setTimeout(() => {
        const g = groupsBetween(aiFrames, ev.t - 0.2, ev.t + 0.4);
        if (g) {
          const lab = impactLabel(g);
          const top = aiFrames.filter((f) => f.t >= ev.t - 0.2 && f.t - 0.975 <= ev.t + 0.4).flatMap((f) => f.top).sort((a, b) => b.score - a.score);
          ev.ai = { group: lab.group, score: lab.score, words: GROUP_WORDS[lab.group as SoundGroup], top: top.slice(0, 3) };
          ev.benign = ev.cls === 'impact' && ev.aboveFloorDb < 30 && ((['tap', 'speech', 'media', 'footsteps'].includes(lab.group) && lab.score >= (lab.group === 'speech' || lab.group === 'media' ? 0.2 : 0.35)) || (lab.group === 'object' && lab.score >= 0.35 && g.thud < 0.15)) && g.distress < 0.3;
        }
        ev.lateMs = 1600;
        hub.send({ type: 'sound', sound: ev });
      }, 1600);
      break;
    }
    case 'sim':
      if (m.state === 'rendering') liveDot.textContent = 'Preparing scene';
      if (m.state === 'ended') {
        liveDot.dataset.on = 'false';
        liveDot.textContent = 'Scene ended';
      }
      break;
  }
}

// ---------------------------------------------------------------- snapshot rendering
let lastTelemetry = 0;
function onSnapshot(s: EngineSnapshot): void {
  if (!epoch) epoch = Date.now() - s.t * 1000;
  lastSnap = s;
  for (const row of s.echoRows) echogram?.push(row);
  for (const c of s.audio.melCols) {
    melCols.push(c);
    if (melCols.length > 140) melCols.shift();
  }
  const f = s.fusion;
  statusBox.dataset.status = f.status;
  setText(headline, f.headline);
  setText(subline, f.subline);
  const running = s.sonarPhase === 'running';
  liveDot.dataset.on = String(running || f.mode === 'body');
  setText(liveDot, running ? 'Sensing' : s.sonarPhase === 'paused' ? 'Paused' : 'Calibrating');
  echogram?.setPaused(s.sonarPhase === 'paused');
  echogram?.setMarkers(f.target?.range ?? null, f.breathing?.range ?? null, settings.zone);

  rRange.innerHTML = f.target ? `${f.target.range.toFixed(1)}<small>m</small>` : '–';
  rBreath.innerHTML = f.breathing ? `${f.breathing.rateBpm.toFixed(0)}<small>/min</small>` : '–';
  const above = s.audio.levelDb - s.audio.floorDb;
  const sc = scene(4);
  const heard = aiFrames[aiFrames.length - 1];
  rSound.textContent =
    s.audio.levelDb < -110
      ? '–'
      : heard && sc && above > 6 && heard.top[0] && heard.top[0].name !== 'Silence'
        ? heard.top[0].name.split(',')[0]
        : above > 20
          ? 'Loud'
          : above > 8
            ? 'Sound'
            : 'Quiet';

  const br = s.breathing;
  const showBreath = br.waveform.length > 40 && (br.valid || br.quality > 0.35);
  breathBox.hidden = !showBreath;
  if (showBreath) {
    breathLabel.textContent = br.valid
      ? `Chest movement at ${br.range.toFixed(1)} m, ${br.rateBpm.toFixed(0)} breaths a minute`
      : 'Chest movement, still settling';
    drawLine(breathTrace, br.waveform, { min: -1.1, max: 1.1, fill: true });
  }
  updateCheckIn(s);
  bandProbe(s);
  if (!$('tab-signals').hidden) drawSignals(s);
  if (hub.status === 'open' && performance.now() - lastTelemetry > 120) {
    lastTelemetry = performance.now();
    hub.send({ type: 'telemetry', telemetry: telemetry(s) });
  }
}

function setText(el: HTMLElement, text: string): void {
  if (el.textContent !== text) el.textContent = text;
}

function telemetry(s: EngineSnapshot): Telemetry {
  const f = s.fusion;
  const row = s.echoRows[s.echoRows.length - 1];
  const echo: number[] = [];
  if (row) for (let i = 0; i < row.length; i += 2) echo.push(Math.round(Math.max(row[i], row[i + 1] ?? 0)));
  const p = s.sonar.primary;
  return {
    nodeId: hub.nodeId ?? '',
    t: Date.now(),
    status: f.status,
    headline: f.headline,
    subline: f.subline,
    presence: f.presence,
    mode: f.mode,
    range: p ? p.range : null,
    velocity: p ? p.velocity : 0,
    snrDb: p ? p.snrDb : 0,
    confirmed: p ? p.confirmed : false,
    breathing: f.breathing,
    linkSnrDb: s.sonar.linkSnrDb,
    motionDb: s.sonar.motionDb,
    fastMotionDb: s.sonar.fastMotionDb,
    staticChangeDb: s.sonar.staticChangeDb,
    sonarOk: s.sonarPhase === 'running',
    scene: scene() ?? undefined,
    echo,
    maxRange: s.sonar.maxRange,
    band: [s.sonar.f0, s.sonar.f1],
    sim: simMode,
    checkIn: f.checkIn ? { state: f.checkIn.state, deadline: f.checkIn.deadline, startedAt: f.checkIn.startedAt, reason: f.checkIn.reason } : null,
  };
}

function frame(): void {
  echogram?.draw();
  requestAnimationFrame(frame);
}

// ---------------------------------------------------------------- events
function clock(t: number): string {
  const d = new Date(epoch + t * 1000);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function onAlert(a: FusionAlert): void {
  alerts.unshift(a);
  if (alerts.length > 60) alerts.pop();
  renderEvents();
  hub.send({ type: 'event', nodeId: hub.nodeId ?? '', alert: a });
  if (a.severity === 'critical' && navigator.vibrate) navigator.vibrate([300, 150, 300]);
}

function renderEvents(): void {
  eventsEl.replaceChildren();
  eventsCount.textContent = alerts.length ? `${alerts.length} event${alerts.length > 1 ? 's' : ''}` : '';
  if (!alerts.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = 'Nothing yet. Events appear here as they happen.';
    eventsEl.append(li);
    return;
  }
  for (const a of alerts) {
    const li = document.createElement('li');
    li.dataset.sev = a.severity;
    const b = document.createElement('button');
    b.setAttribute('aria-expanded', 'false');
    const time = document.createElement('time');
    time.textContent = clock(a.t);
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = a.title;
    const detail = document.createElement('span');
    detail.className = 'detail';
    detail.textContent = a.detail;
    b.append(time, title, detail);
    const ev = document.createElement('ul');
    ev.className = 'evidence';
    ev.hidden = true;
    for (const e of a.evidence) {
      const item = document.createElement('li');
      item.textContent = e;
      ev.append(item);
    }
    const conf = document.createElement('li');
    conf.textContent = `confidence ${(a.confidence * 100).toFixed(0)}%`;
    ev.append(conf);
    b.append(ev);
    b.addEventListener('click', () => {
      ev.hidden = !ev.hidden;
      b.setAttribute('aria-expanded', String(!ev.hidden));
    });
    li.append(b);
    eventsEl.append(li);
  }
}

// ---------------------------------------------------------------- check-in
function updateCheckIn(s: EngineSnapshot): void {
  const c = s.fusion.checkIn;
  if (!c || c.id === localDismissed || c.state === 'ok') {
    checkin.hidden = true;
    return;
  }
  checkin.hidden = false;
  checkin.dataset.state = c.state;
  if (c.state === 'pending') {
    const left = Math.max(0, Math.ceil(c.deadline - s.t - (c.urgent ? 5 : 0)));
    setText(ciTitle, c.urgent ? 'It looks like you may have fallen' : 'Are you OK?');
    setText(ciReason, c.urgent ? 'Say "I\'m OK" or tap below. Otherwise help is called.' : c.reason);
    if (!answerState.start && !answerState.waiting) setText(ciCount, c.urgent ? `Calling for help in ${left} s` : `Alerting your contacts in ${left} s`);
    ciOk.textContent = "I'm OK";
    ciHelp.hidden = false;
    // Ask out loud. A gentle question three times; an urgent one at the start and once more.
    const since = s.t - c.startedAt;
    const round = c.urgent ? (since < 12 ? 0 : 1) : since < 11 ? 0 : since < 22 ? 1 : 2;
    const key = `${c.id}:${c.urgent ? 'u' : 'g'}:${round}`;
    if (spokenCheckIn !== key) {
      spokenCheckIn = key;
      speak(
        c.urgent
          ? round === 0
            ? "It looks like you may have fallen. If you are OK, say I'm OK. Otherwise I will call for help."
            : "I'm about to call for help. Say I'm OK if you are OK."
          : round === 0
            ? "Are you OK? Say I'm OK, or say help."
            : "Are you OK? Please answer. If I don't hear from you, I will call your family.",
      );
    }
  } else if (c.state === 'escalated') {
    setText(ciTitle, 'Contacts alerted');
    setText(ciReason, 'Nobody answered the check-in, so your contacts have been told.');
    setText(ciCount, hub.status === 'open' ? 'The console has been notified.' : 'Connect a console in Settings to reach a caregiver.');
    ciOk.textContent = "I'm OK now";
    ciHelp.hidden = true;
  } else if (c.state === 'help') {
    setText(ciTitle, 'Help requested');
    setText(ciReason, 'Your contacts have been told you asked for help.');
    setText(ciCount, '');
    ciOk.textContent = 'Close';
    ciHelp.hidden = true;
  }
}

ciOk.addEventListener('click', () => {
  const c = lastSnap?.fusion.checkIn;
  if (!c) return;
  if (c.state === 'help') localDismissed = c.id;
  else post({ type: 'respond', answer: 'ok' });
  checkin.hidden = true;
});
ciHelp.addEventListener('click', () => post({ type: 'respond', answer: 'help' }));

function showNotice(text: string): void {
  let el = document.getElementById('notice');
  if (!el) {
    el = document.createElement('div');
    el.id = 'notice';
    el.className = 'notice';
    el.setAttribute('role', 'status');
    document.body.append(el);
  }
  el.textContent = text;
  el.hidden = false;
  clearTimeout((showNotice as unknown as { timer?: number }).timer);
  (showNotice as unknown as { timer?: number }).timer = window.setTimeout(() => (el!.hidden = true), 8000);
}

/**
 * Spoken prompts. iOS Safari will not play speech synthesis while the
 * microphone is in use (you only hear the chime), so the hub records each
 * prompt as audio (the Mac's own voice) and the phone plays it through the
 * same audio path as the chime. Speech synthesis is only the fallback.
 */
const VOICE: Record<string, string> = {
  "Are you OK? Say I'm OK, or say help.": 'ask1',
  "Are you OK? Please answer. If I don't hear from you, I will call your family.": 'ask2',
  "It looks like you may have fallen. If you are OK, say I'm OK. Otherwise I will call for help.": 'urgent1',
  "I'm about to call for help. Say I'm OK if you are OK.": 'urgent2',
  "Sorry, I didn't catch that. Say I'm OK, or say help.": 'again1',
  'Please say I am OK, or say help.': 'again2',
  "Okay, glad you're OK.": 'glad',
  "Okay. I've told your family you're OK.": 'toldok',
  'Help has been called.': 'help',
  'Help is on the way.': 'onway',
};
const voiceCache = new Map<string, AudioBuffer | null>();
async function voiceClip(key: string): Promise<AudioBuffer | null> {
  const ctx = audio.ctx;
  if (!ctx) return null;
  if (voiceCache.has(key)) return voiceCache.get(key)!;
  try {
    const r = await fetch(`voice/${key}.wav`);
    const buf = r.ok ? await ctx.decodeAudioData(await r.arrayBuffer()) : null;
    voiceCache.set(key, buf);
    return buf;
  } catch {
    voiceCache.set(key, null);
    return null;
  }
}
/** Fetch the clips early so the first prompt plays without delay. */
function preloadVoice(): void {
  for (const k of Object.values(VOICE)) void voiceClip(k);
}

function speak(text: string): void {
  // Ignore what the phone hears of itself while it speaks, but only that long: people answer
  // the moment the question ends, and muting longer throws their answer away.
  // Estimate from the words first (chime 0.9 s, about 14 characters a second), exact once the clip is loaded.
  const t0 = performance.now();
  const secs = 0.9 + text.length / 14 + 0.4;
  post({ type: 'speaking', seconds: secs });
  talkingAtPrompt = t0 - lastTalkAt < 1500;
  gapAfterPrompt = false;
  speakingUntil = t0 + secs * 1000;
  const ctx = audio.ctx;
  try {
    if (ctx) {
      void ctx.resume();
      // Two chime notes first (the passive listener is muted meanwhile).
      for (const [f, t0] of [[880, 0], [660, 0.35]] as const) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.frequency.value = f;
        g.gain.setValueAtTime(0, ctx.currentTime + t0);
        g.gain.linearRampToValueAtTime(0.3, ctx.currentTime + t0 + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + t0 + 0.6);
        o.connect(g).connect(ctx.destination);
        o.start(ctx.currentTime + t0);
        o.stop(ctx.currentTime + t0 + 0.65);
      }
    }
  } catch {
    /* no audio */
  }
  const key = VOICE[text];
  void (async () => {
    const clip = key ? await voiceClip(key) : null;
    if (clip && ctx) {
      const src = ctx.createBufferSource();
      const g = ctx.createGain();
      g.gain.value = 1;
      src.buffer = clip;
      src.connect(g).connect(ctx.destination);
      src.start(ctx.currentTime + 0.9);
      speakingUntil = t0 + (0.9 + clip.duration + 0.4) * 1000;
      // The exact moment the question ends, plus a short pause before listening.
      src.onended = () => (speakingUntil = Math.max(speakingUntil, performance.now() + 400));
      return;
    }
    if ('speechSynthesis' in window) {
      const u = new SpeechSynthesisUtterance(text);
      u.rate = 0.95;
      u.volume = 1;
      setTimeout(() => speechSynthesis.speak(u), 900);
    }
  })();
}

// ---------------------------------------------------------------- signals tab
function drawSignals(s: EngineSnapshot): void {
  const maxR = s.sonar.maxRange;
  const mLabels: [number, string][] = [0, 1, 2, 3].filter((m) => m <= maxR).map((m) => [m / maxR, m === 0 ? '0' : `${m} m`]);
  if (s.profileRow) drawLine($<HTMLCanvasElement>('sig-profile'), s.profileRow, { min: -70, max: 2, xLabels: mLabels, yLabels: [[0, '0 dB'], [-30, '-30'], [-60, '-60']] });
  const rd = s.rangeDoppler;
  if (rd) {
    let mx = -300;
    for (const v of rd.db) mx = Math.max(mx, v);
    // Transpose: rows = range cells, cols = Doppler.
    const vmax = Math.abs(rd.velocities[0]);
    drawHeat($<HTMLCanvasElement>('sig-rd'), rd.db, rd.cells, rd.dopplerBins, mx - 35, mx, {
      x: [[0.03, `-${vmax.toFixed(2)} m/s`], [0.5, '0'], [0.97, `+${vmax.toFixed(2)}`]],
      y: [[0.02, '0'], [1 / maxR, '1 m'], [2 / maxR, '2 m'], [3 / maxR, '3 m']],
    });
  }
  if (melCols.length > 2) {
    const rows = melCols[0].length;
    const cols = melCols.length;
    const data = new Float32Array(rows * cols);
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) data[r * cols + c] = melCols[c][r];
    drawHeat($<HTMLCanvasElement>('sig-mel'), data, rows, cols, -100, -30, { y: [[0.02, '60 Hz'], [0.5, '1 kHz'], [0.95, '8 kHz']] });
  }
  if (s.sonar.channelResponse) {
    const cr = s.sonar.channelResponse;
    const mx = Math.max(...cr);
    drawLine($<HTMLCanvasElement>('sig-eq'), cr.map((v) => 20 * Math.log10(v / mx + 1e-9)), {
      min: -24,
      max: 2,
      xLabels: [[0, `${(s.sonar.f0 / 1000).toFixed(1)} kHz`], [1, `${(s.sonar.f1 / 1000).toFixed(1)} kHz`]],
      yLabels: [[0, '0 dB'], [-12, '-12'], [-24, '-24']],
    });
  }
  const m = $('metrics');
  const rows: [string, string, boolean?][] = [
    ['Mode', simMode ? 'Simulated room' : s.fusion.mode === 'room' ? 'Room sensor' : 'Carried'],
    ['Sample rate', `${(s.sonar.fs / 1000).toFixed(1)} kHz`],
    ['Sonar band', `${(s.sonar.f0 / 1000).toFixed(2)} to ${(s.sonar.f1 / 1000).toFixed(2)} kHz`],
    ['Pings per second', s.sonar.fps.toFixed(1)],
    ['Range resolution', `${(s.sonar.resolution * 100).toFixed(0)} cm`],
    ['Speaker to mic link', `${s.sonar.linkSnrDb.toFixed(0)} dB (needs 14)`, s.sonar.linkSnrDb > 0 && s.sonar.linkSnrDb < 14],
    ['Band check', probe.note || 'after 5 s of sensing'],
    ['Ultrasonic background', `${s.sonar.ambientUltrasoundDb.toFixed(0)} dB`],
    ['Strongest motion', `${s.sonar.motionDb.toFixed(0)} dB, fast ${s.sonar.fastMotionDb.toFixed(0)} dB`],
    ['Body moving now', s.sonar.fastMotionDb > 12 ? `yes (fast ${s.sonar.fastMotionDb.toFixed(0)} dB, over 12 counts)` : 'no', s.sonar.fastMotionDb > 12],
    ['Breathing: stillness', `${s.breathing.stillSeconds.toFixed(0)} s (needs 10 s)`, s.breathing.stillSeconds < 10],
    ['Breathing: rhythm', `${(s.breathing.quality * 100).toFixed(0)}% (needs 45%)`, s.breathing.quality < 0.45],
    ['Breathing: chest echo', s.breathing.range > 0 ? `${s.breathing.prominenceDb.toFixed(0)} dB at ${s.breathing.range.toFixed(2)} m (needs 10 dB)` : 'not measured yet', s.breathing.prominenceDb < 10],
    ['Tracks', `${s.sonar.tracks.filter((t) => t.confirmed).length} confirmed`],
    ['Microphone', simMode ? 'simulated' : micInfo || '–', micInfo.includes('echo')],
    ['Sound model (YAMNet)', simMode ? 'off in simulation' : aiStatus, aiStatus.startsWith('off')],
    ['Hearing now', aiFrames.length ? aiFrames[aiFrames.length - 1].top.map((x) => `${x.name.split(',')[0]} ${Math.round(x.score * 100)}%`).join(', ') : '–'],
    ['Motion sensor', simMode ? 'simulated' : motionGranted ? 'on' : 'off'],
    ['Processing', `${s.perf.msPerFrame.toFixed(2)} ms per ping (${(s.perf.realtimeFactor * 100).toFixed(1)}% of real time)`],
    ['Console', hub.status === 'open' ? 'connected' : 'not connected'],
  ];
  if (txInfo.crest) rows.push(['Transmit crest factor', txInfo.crest.toFixed(2)]);
  m.replaceChildren();
  for (const [k, v, warn] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = k;
    const dd = document.createElement('dd');
    dd.textContent = v;
    if (warn) dd.className = 'warn';
    m.append(dt, dd);
  }
}

// ---------------------------------------------------------------- tabs
for (const b of document.querySelectorAll<HTMLButtonElement>('.tabs button')) {
  b.addEventListener('click', () => {
    for (const o of document.querySelectorAll<HTMLButtonElement>('.tabs button')) o.setAttribute('aria-selected', String(o === b));
    $('tab-room').hidden = b.dataset.tab !== 'room';
    $('tab-signals').hidden = b.dataset.tab !== 'signals';
    if (b.dataset.tab === 'room') echogram?.markDirty();
    if (lastSnap && b.dataset.tab === 'signals') drawSignals(lastSnap);
  });
}

// ---------------------------------------------------------------- hub
function connectHub(): void {
  const url = settings.hub || HubClient.defaultUrl();
  if (url) hub.connect(url);
}
hub.onStatus = (st) => {
  // Without the hub, talking counts as an answer here again (offline fallback).
  if (st !== 'open' && hubStt) {
    hubStt = false;
    post({ type: 'fusion', cfg: { speechToHub: false } });
  }
  $('hub-status').textContent =
    st === 'open'
      ? `Connected to the console${hub.nodeId ? ` as ${hub.nodeId}` : ''}.`
      : st === 'connecting'
        ? 'Connecting to the console.'
        : 'Not connected. When this page is opened from the EchoSense hub, it connects automatically.';
};
hub.onMessage = (m) => {
  if (m.type === 'welcome' || m.type === 'band') {
    hubBandCount = m.bandCount;
    // Several phones share the band plan; a single device may keep the band it found works best.
    if (m.bandCount === 1 && currentBand === LOW_BAND) return;
    const plan = bandPlan(m.bandCount);
    const band = plan[Math.min(m.bandIndex, plan.length - 1)];
    if (band.f0 !== currentBand.f0 || band.f1 !== currentBand.f1) {
      currentBand = band;
      post({ type: 'recalibrate', band });
    }
  } else if (m.type === 'respond') {
    post({ type: 'respond', answer: m.answer });
  } else if (m.type === 'ask') {
    post({ type: 'ask', reason: m.reason, urgent: m.urgent, seconds: m.seconds });
  } else if (m.type === 'heard') {
    onHeard(m);
  } else if (m.type === 'caps') {
    hubStt = m.stt;
    post({ type: 'fusion', cfg: { speechToHub: hubStt } });
  } else if (m.type === 'notice') {
    showNotice(m.text);
    speak(m.text);
  }
};

// ---------------------------------------------------------------- settings sheet
const sheet = $('sheet');
const backdrop = $('sheet-backdrop');
function openSheet(open: boolean): void {
  sheet.hidden = !open;
  backdrop.hidden = !open;
}
$('open-settings').addEventListener('click', () => openSheet(true));
$('sheet-close').addEventListener('click', () => openSheet(false));
backdrop.addEventListener('click', () => openSheet(false));

function segment(id: string, value: string, onPick: (v: string) => void): void {
  const box = $(id);
  for (const b of box.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-pressed', String(b.dataset.v === value));
    b.addEventListener('click', () => {
      for (const o of box.querySelectorAll<HTMLButtonElement>('button')) o.setAttribute('aria-pressed', String(o === b));
      onPick(b.dataset.v!);
    });
  }
}
segment('set-mode', settings.mode, (v) => {
  settings.mode = v as Settings['mode'];
  saveSettings();
  post({ type: 'mode', mode: settings.mode });
});
segment('set-timeout', String(settings.timeout), (v) => {
  settings.timeout = Number(v);
  saveSettings();
  post({ type: 'fusion', cfg: { checkInTimeout: settings.timeout } });
});
const zone = $<HTMLInputElement>('set-zone');
zone.value = String(settings.zone);
$('set-zone-v').textContent = `${settings.zone.toFixed(1)} m`;
zone.addEventListener('input', () => {
  settings.zone = Number(zone.value);
  $('set-zone-v').textContent = `${settings.zone.toFixed(1)} m`;
  saveSettings();
  post({ type: 'fusion', cfg: { zoneRadius: settings.zone } });
});
const level = $<HTMLInputElement>('set-level');
level.value = String(settings.level);
$('set-level-v').textContent = `${Math.round(settings.level * 100)}%`;
level.addEventListener('input', () => {
  settings.level = Number(level.value);
  $('set-level-v').textContent = `${Math.round(settings.level * 100)}%`;
  saveSettings();
  audio.setLevel(settings.level);
});
const hubInput = $<HTMLInputElement>('set-hub');
hubInput.value = settings.hub;
$('hub-connect').addEventListener('click', () => {
  settings.hub = hubInput.value.trim();
  saveSettings();
  connectHub();
});
$('recal').addEventListener('click', () => {
  post({ type: 'recalibrate' });
  echogram?.clear();
  openSheet(false);
});
const simSel = $<HTMLSelectElement>('set-sim');
for (const [key, sc] of Object.entries(SCENARIOS)) {
  const o = document.createElement('option');
  o.value = key;
  o.textContent = sc.name;
  simSel.append(o);
}
$('sim-run').addEventListener('click', () => {
  if (!simMode) audio.stop();
  alerts.length = 0;
  renderEvents();
  startSim(simSel.value);
  openSheet(false);
});

// ---------------------------------------------------------------- lifecycle
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) {
    void audio.ctx?.resume();
    void keepAwake();
    // iOS drops sockets while the screen is off: reconnect at once instead of waiting for the backoff.
    hub.reconnectNow();
  }
});
window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  palette(true);
  echogram?.clear();
});
window.addEventListener('resize', () => echogram?.markDirty());

// Expose state for automated end-to-end tests.
(window as unknown as { __echosense: unknown }).__echosense = {
  get snapshot() {
    return lastSnap;
  },
  get alerts() {
    return alerts;
  },
  get ai() {
    return { status: aiStatus, frames: aiFrames.slice(-3) };
  },
  startSim,
};
