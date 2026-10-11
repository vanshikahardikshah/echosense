import { PLACE_KINDS, type PlaceKind } from '../agents/cartographer';
import { ROLE_INFO } from '../agents/roles';
import { SCENARIOS } from '../agents/sim';
import { ACTION_WORDS, describePlan, type Move } from '../agents/negotiation';
import type { ActionRecord, AgentTrace, BoardMsg, ContextNote, EvidenceReport, Incident, Outcome, Position, RoleName } from '../agents/types';
import type { HubClient } from '../app/hub';
import type { NodeInfo, ServerMsg } from '../net/protocol';

/** The console's view of the Witness board: live deliberation, history and demo tools. */

interface View {
  incident: Incident;
  reports: EvidenceReport[];
  positions: Position[];
  outcome: Outcome | null;
  actions: ActionRecord[];
  human: { answer: string; source: string } | null;
  context?: ContextNote;
  traces: AgentTrace[];
  moves: Move[];
  /** Every message on the channel for this incident, in order: who sent what, when. */
  log: { t: number; from: string; what: string }[];
}

const ROLES: RoleName[] = ['responder', 'skeptic', 'auditor'];
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
};

const views = new Map<string, View>();
/** Things already drawn once: they never animate in again when the view is redrawn. */
const drawn = new Set<string>();
function fresh<T extends HTMLElement>(e: T, key: string): T {
  if (!drawn.has(key)) {
    drawn.add(key);
    e.classList.add('fresh');
  }
  return e;
}
/** Redraw at most once per frame, however fast the agents post. */
let renderQueued = false;
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    render();
  });
}
/** Which channel identity posted each report or position. */
const sender = new Map<string, string>();
let channelKind = 'local';
/** Places in the room map (shared with the floor plan drawing). */
export const mapPlaces: { id: string; name: string; kind: PlaceKind; ranges: Record<string, number> }[] = [];
let phoneLabels: Record<string, { label: string; near?: PlaceKind }> = {};
let phoneList: NodeInfo[] = [];
const loose: ActionRecord[] = [];
let selected: string | null = null;
let pinned = false;
let hub: HubClient;

const STATUS_TEXT: Record<Incident['status'], string> = {
  gathering: 'Phones gathering evidence',
  deliberating: 'Agents deliberating',
  asking: 'Asking the person',
  urgent: 'Calling unless they answer',
  escalated: 'Help called',
  stood_down: 'Stood down',
  resolved_ok: 'They are OK',
  resolved_help: 'Help on the way',
};
const STANCE: Record<Position['stance'], string> = { escalate: 'Get help', stand_down: 'Stand down', uncertain: 'Not sure' };

export function initWitness(h: HubClient): void {
  hub = h;
  const scn = $<HTMLSelectElement>('w-scn');
  for (const s of SCENARIOS) {
    const o = el('option', undefined, `${s.title}${s.emergency ? '' : ' (no emergency)'}`);
    o.value = s.key;
    scn.append(o);
  }
  $('w-run').addEventListener('click', () => {
    pinned = false;
    hub.send({ type: 'council', action: 'run_scenario', key: scn.value });
  });
  $('w-eval').addEventListener('click', () => {
    $<HTMLDialogElement>('w-evaldlg').showModal();
    if (!$('w-evaltable').childElementCount) $('w-evalnote').textContent = 'Running every scenario 40 times...';
    hub.send({ type: 'council', action: 'eval' });
  });
  $('w-evalclose').addEventListener('click', () => $<HTMLDialogElement>('w-evaldlg').close());
  $('w-fake').addEventListener('click', () => {
    const id = $<HTMLSelectElement>('w-phone').value;
    if (!id) return;
    pinned = false;
    hub.send({ type: 'council', action: 'inject_fake', nodeId: id });
  });
  $<HTMLInputElement>('w-simcalls').addEventListener('change', (e) => hub.send({ type: 'council', action: 'sim_calls', on: (e.target as HTMLInputElement).checked }));
  $<HTMLSelectElement>('w-llm').addEventListener('change', (e) =>
    hub.send({ type: 'council', action: 'llm_mode', mode: (e.target as HTMLSelectElement).value as 'off' | 'narrate' | 'reason' | 'agent' }),
  );
  const kindSel = $<HTMLSelectElement>('w-pkind');
  for (const k of PLACE_KINDS) {
    const o = el('option', undefined, k.label);
    o.value = k.kind;
    kindSel.append(o);
  }
  kindSel.value = 'sofa';
  $('w-psave').addEventListener('click', () => {
    $('w-presult').dataset.ok = '';
    $('w-presult').textContent = 'Measuring: sway gently where you are for 5 seconds...';
    hub.send({ type: 'council', action: 'mark_place', name: $<HTMLInputElement>('w-pname').value, kind: kindSel.value as PlaceKind });
  });
  $('w-testask').addEventListener('click', () => hub.send({ type: 'council', action: 'test_ask' }));
  $('w-testcall').addEventListener('click', () => hub.send({ type: 'council', action: 'test_call' }));
  $('w-testwebex').addEventListener('click', () => hub.send({ type: 'council', action: 'test_webex' }));
  $('w-lab-save').addEventListener('click', () => {
    if (!selected) return;
    const subtype = $<HTMLSelectElement>('w-lab-type').value;
    const label = ['hard_fall', 'soft_fall', 'chair_slide', 'other_fall'].includes(subtype) ? 'fall' : 'not_fall';
    hub.send({ type: 'council', action: 'label_incident', incidentId: selected, label, subtype, location: $<HTMLSelectElement>('w-lab-loc').value, heldOut: $<HTMLInputElement>('w-lab-held').checked });
  });
  render();
}

function renderMapBox(): void {
  $('w-mapsum').textContent = mapPlaces.length ? `(${mapPlaces.length} place${mapPlaces.length > 1 ? 's' : ''})` : '(not set up)';
  const ul = $('w-places');
  ul.replaceChildren();
  const name = (id: string) => phoneList.find((n) => n.nodeId === id)?.name ?? id;
  for (const p of mapPlaces) {
    const li = el('li');
    li.append(
      el('strong', undefined, p.name),
      el('span', undefined, ` ${PLACE_KINDS.find((k) => k.kind === p.kind)?.label ?? p.kind}: ${Object.entries(p.ranges).map(([id, r]) => `${name(id)} ${r.toFixed(1)} m`).join(', ')}`),
    );
    const del = el('button', 'small-btn', 'Remove');
    del.addEventListener('click', () => hub.send({ type: 'council', action: 'remove_place', id: p.id }));
    li.append(del);
    ul.append(li);
  }
  const box = $('w-plabels');
  if (box.contains(document.activeElement)) return;
  box.replaceChildren();
  for (const n of phoneList) {
    const row = el('label', 'w-plabel');
    const sel = el('select');
    for (const [v, t] of [['', 'nothing in particular'], ...PLACE_KINDS.map((k) => [k.kind, `the ${k.label.toLowerCase()}`])]) {
      const o = el('option', undefined, t);
      o.value = v;
      sel.append(o);
    }
    sel.value = phoneLabels[n.nodeId]?.near ?? '';
    sel.addEventListener('change', () => {
      const near = (sel.value || undefined) as PlaceKind | undefined;
      hub.send({ type: 'council', action: 'label_phone', nodeId: n.nodeId, label: near ? `by the ${PLACE_KINDS.find((k) => k.kind === near)!.label.toLowerCase()}` : '', near });
    });
    row.append(el('span', undefined, `${n.name} is next to`), sel);
    box.append(row);
  }
}

export function syncPhones(nodes: NodeInfo[]): void {
  phoneList = nodes;
  renderMapBox();
  const sel = $<HTMLSelectElement>('w-phone');
  const cur = sel.value;
  sel.replaceChildren();
  for (const n of nodes) {
    const o = el('option', undefined, n.name);
    o.value = n.nodeId;
    sel.append(o);
  }
  if (!nodes.length) sel.append(el('option', undefined, 'No phones connected'));
  if (cur) sel.value = cur;
}

export function onServer(m: ServerMsg): boolean {
  if (m.type === 'board') {
    if (m.from) {
      if (m.msg.type === 'report') sender.set(m.msg.report.id, m.from);
      if (m.msg.type === 'position') sender.set(m.msg.position.id, m.from);
      if (m.msg.type === 'context') sender.set(`ctx-${m.msg.context.incidentId}`, m.from);
    }
    apply(m.msg, true, m.from);
  }
  else if (m.type === 'board_history') {
    for (const b of m.msgs) apply(b, false);
    render();
  } else if (m.type === 'council_status') {
    const s = m.status as {
      llm: string;
      notify: string;
      realCallsForSims: boolean;
      llmMode: string;
      llmKey: boolean;
      bus: { kind: string; channel: string; encrypted: boolean; members: string[]; removed: string[]; note: string };
      quarantined: string[];
    };
    const st = s as unknown as { claude?: { today: number; cap: number; calls: number; skipped: number } | null; memory?: { incidents: number; answered: number } };
    const used = st.claude ? ` Claude today: $${st.claude.today.toFixed(3)} of $${st.claude.cap.toFixed(2)} (${st.claude.calls} call${st.claude.calls === 1 ? '' : 's'}${st.claude.skipped ? `, ${st.claude.skipped} skipped at the cap` : ''}).` : '';
    const learned = st.memory && st.memory.incidents ? ` Home memory: ${st.memory.incidents} incidents, ${st.memory.answered} answered by a person.` : '';
    const speech = (s as unknown as { speech?: string }).speech;
    $('w-status').textContent = `Reasoning: ${s.llm}. Spoken answers: ${speech ?? 'off'}. ${s.notify}.${used}${learned}`;
    const sel = $<HTMLSelectElement>('w-llm');
    if (document.activeElement !== sel) sel.value = s.llmMode;
    sel.disabled = !s.llmKey;
    sel.title = s.llmKey ? '' : 'Add ANTHROPIC_API_KEY to .env and restart the hub';
    channelKind = s.bus.kind;
    const mp = (s as unknown as { map?: { places: typeof mapPlaces; phones: typeof phoneLabels } }).map;
    if (mp) {
      mapPlaces.splice(0, mapPlaces.length, ...mp.places);
      phoneLabels = mp.phones;
      renderMapBox();
    }
    const ch = $('w-channel');
    ch.replaceChildren();
    ch.dataset.kind = s.bus.kind;
    ch.append(
      el('strong', undefined, s.bus.kind === 'slim' ? 'AGNTCY SLIM' : 'Local channel'),
      el('span', undefined, `${s.bus.channel}${s.bus.encrypted ? ', MLS end to end encrypted' : ''}${s.bus.kind === 'slim' ? '' : ` (${s.bus.note})`}`),
    );
    const ul = el('ul', 'w-members');
    for (const id of s.bus.members) ul.append(el('li', id === 'moderator' ? 'mod' : undefined, id));
    for (const id of s.bus.removed) {
      const li = el('li', 'out', id);
      li.title = 'Removed from the channel by the moderator';
      ul.append(li);
    }
    ch.append(ul);
    $<HTMLInputElement>('w-simcalls').checked = s.realCallsForSims;
  } else if (m.type === 'eval') {
    renderEval(m);
  } else if (m.type === 'map_result') {
    $('w-presult').textContent = m.detail;
    $('w-presult').dataset.ok = String(m.ok);
  } else return false;
  return true;
}

function apply(b: BoardMsg, live: boolean, from = ''): void {
  const id = b.type === 'incident' ? b.incident.id : b.type === 'report' ? b.report.incidentId : b.type === 'position' ? b.position.incidentId : b.type === 'outcome' ? b.outcome.incidentId : b.type === 'action' ? b.action.incidentId : b.type === 'context' ? b.context.incidentId : b.type === 'trace' ? b.trace.incidentId : b.type === 'move' ? b.move.incidentId : b.incidentId;
  let v = views.get(id);
  if (b.type === 'incident') {
    if (!v) {
      v = { incident: b.incident, reports: [], positions: [], outcome: null, actions: [], human: null, traces: [], moves: [], log: [] };
      views.set(id, v);
      if (!pinned) selected = id;
    }
    v.incident = b.incident;
  } else if (!v) {
    if (b.type === 'action') loose.unshift(b.action);
    if (live) scheduleRender();
    return;
  }
  if (v) v.log.push({ t: Date.now(), from: from.replace(/^witness\/[^/]+\//, ''), what: logLine(b) });
  if (b.type === 'incident') {
    /* handled above */
  } else if (b.type === 'report') {
    v.reports = v.reports.filter((r) => r.nodeId !== b.report.nodeId).concat(b.report);
  } else if (b.type === 'position') v.positions.push(b.position);
  else if (b.type === 'outcome') v.outcome = b.outcome;
  else if (b.type === 'action') v.actions.push(b.action);
  else if (b.type === 'context') v.context = b.context;
  else if (b.type === 'trace') v.traces.push(b.trace);
  else if (b.type === 'move') v.moves.push(b.move);
  else if (b.type === 'human') v.human = { answer: b.answer, source: b.source };
  if (live) scheduleRender();
}

function logLine(b: BoardMsg): string {
  switch (b.type) {
    case 'incident':
      return `incident ${b.incident.status.replace('_', ' ')}`;
    case 'report':
      return `evidence report (${b.report.localVerdict === 'none' ? 'nothing on its own' : b.report.localVerdict.replace('_', ' ')})`;
    case 'context':
      return 'room map note';
    case 'position':
      return `${b.position.agent} round ${b.position.round}: ${STANCE[b.position.stance].toLowerCase()}`;
    case 'trace':
      return `${b.trace.agent}: ${b.trace.tool ?? b.trace.kind}`;
    case 'outcome':
      return `outcome: ${b.outcome.kind.replace('_', ' ')}`;
    case 'action':
      return `${b.action.action}: ${b.action.detail.slice(0, 80)}`;
    case 'human':
      return `person: ${b.answer}`;
    case 'move':
      return `${b.move.agent} ${b.move.kind}${b.move.to ? ` to ${b.move.to}` : ''}: ${ACTION_WORDS[b.move.plan.action]}`;
  }
}

function fmtDb(x: number | null): string {
  return x === null ? 'nothing' : `${x.toFixed(0)} dB`;
}

function reportLines(r: EvidenceReport): string[] {
  const s = r.sonar;
  const lines: string[] = [];
  lines.push(r.sound.impactDb === null ? 'Heard no impact' : `Heard an impact, ${fmtDb(r.sound.impactDb)}`);
  if (r.imu.moved || r.imu.dropped || s.roomChangeDb >= 15) lines.push('The phone itself moved');
  if (!s.online) lines.push('Sonar not running');
  else if (!s.sawPersonBefore && s.rangeAfter === null)
    lines.push(s.lastSeenAgo !== null ? `Sonar: saw the person ${s.lastSeenAgo.toFixed(0)} s before, nobody in view since` : 'Sonar: nobody in view before or after');
  else {
    const parts = [`Sonar: ${s.sawPersonBefore ? 'watching' : 'saw'} the person`];
    if (s.burstDb >= 16) parts.push(`burst ${s.burstDb.toFixed(0)} dB`);
    if (s.motionResumed) parts.push('moving normally after');
    else if (s.firstMoveAfter !== null) parts.push(`moved again at ${s.firstMoveAfter.toFixed(0)} s`);
    else if (s.presentAfter) parts.push('no movement since');
    if (s.rangeBefore !== null && s.rangeAfter !== null) parts.push(`${s.rangeBefore.toFixed(1)} to ${s.rangeAfter.toFixed(1)} m`);
    lines.push(parts.join(', '));
  }
  if (r.sound.mediaEventsBefore >= 3) lines.push('Voice or music playing before');
  if (r.sound.screamDb !== null) lines.push('Heard a scream');
  lines.push(`Own verdict: ${r.localVerdict === 'none' ? 'nothing' : r.localVerdict === 'fall' ? 'fall' : 'possible fall'}`);
  return lines;
}

function render(): void {
  renderHistory();
  $('w-labres').textContent = loose.find((a) => a.detail.startsWith('training:'))?.detail.replace(/^training: /, '') ?? '';
  const lo = $('w-loose');
  lo.replaceChildren(...loose.slice(0, 3).map((a) => {
    const li = el('li', undefined, `${new Date(a.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} ${a.detail}`);
    li.dataset.ok = String(a.ok);
    return li;
  }));
  const box = $('w-incident');
  const v = selected ? views.get(selected) : null;
  box.replaceChildren();
  if (!v) {
    const p = el('div', 'w-empty');
    p.append(
      el('strong', undefined, 'No incidents yet.'),
      el('p', undefined, 'When any phone hears an impact, sees a sudden movement or raises a fall, every phone reports what it measured and three agents argue it out here. Play a scenario to watch one.'),
    );
    box.append(p);
    for (const a of loose.slice(0, 3)) box.append(el('p', 'w-note', a.detail));
    return;
  }
  const inc = v.incident;
  box.dataset.status = inc.status;

  const head = el('div', 'w-trigger');
  const pill = el('span', 'w-pill', STATUS_TEXT[inc.status]);
  pill.dataset.status = inc.status;
  const title = el('strong', undefined, `${inc.trigger.name}: ${inc.trigger.detail}`);
  const meta = el('span', 'w-meta', `${new Date(inc.t0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}${inc.simulated ? `, simulation: ${SCENARIOS.find((s) => s.key === inc.scenario)?.title ?? inc.scenario}` : ''}`);
  head.append(pill, title, meta);
  box.append(head);

  // Evidence from each phone.
  const trust = [...v.positions].reverse().find((p) => p.agent === 'auditor')?.trust;
  const reps = el('div', 'w-reports');
  if (!v.reports.length) reps.append(el('p', 'w-wait', 'Waiting for every phone to report what it measured...'));
  for (const r of v.reports) {
    const card = fresh(el('div', 'w-report'), r.id);
    const t = trust?.[r.nodeId];
    if (t && t.score < 0.5) card.dataset.untrusted = 'true';
    const h = el('div', 'w-rhead');
    h.append(el('strong', undefined, r.name));
    if (t) {
      const bar = el('span', 'w-trust');
      bar.title = t.reasons.join('; ');
      const fill = el('i');
      fill.style.width = `${Math.round(t.score * 100)}%`;
      bar.append(fill);
      h.append(bar, el('span', 'w-trustv', `trust ${Math.round(t.score * 100)}%`));
    }
    card.append(h);
    const via = sender.get(r.id);
    if (via) card.append(el('p', 'w-via', `posted as ${via}${r.ageMs !== undefined ? `, ${r.ageMs < 1500 ? 'live' : `data ${(r.ageMs / 1000).toFixed(1)} s old`}` : ''}`));
    const ul = el('ul');
    for (const line of reportLines(r)) ul.append(el('li', undefined, line));
    card.append(ul);
    if (t && t.score < 0.5) card.append(el('p', 'w-flag', t.reasons.filter((x) => x !== 'consistent with the other phones').join('; ')));
    reps.append(card);
  }
  box.append(reps);

  // What the room map says.
  if (v.context) {
    const c = el('div', 'w-carto');
    const via = sender.get(`ctx-${v.incident.id}`);
    c.append(el('strong', undefined, 'Cartographer'), el('span', undefined, v.context.notes.join('; ')));
    if (via) c.append(el('span', 'w-via', `posted as ${via}`));
    box.append(c);
  }

  // The three agents.
  const cols = el('div', 'w-agents');
  for (const role of ROLES) {
    const col = el('div', 'w-agent');
    col.dataset.role = role;
    const h = el('div', 'w-ahead');
    h.append(el('strong', undefined, ROLE_INFO[role].title), el('span', undefined, ROLE_INFO[role].goal));
    col.append(h);
    const r1 = v.positions.find((p) => p.agent === role && p.round === 1);
    const r2 = v.positions.find((p) => p.agent === role && p.round === 2);
    const steps = (round: 1 | 2 | 3) => {
      const list = v.traces.filter((t) => t.agent === role && t.round === round);
      if (!list.length) return null;
      const ol = el('ol', 'w-steps');
      for (const t of list) {
        const li = fresh(el('li', undefined), `${t.incidentId}:${t.agent}:${t.round}:${t.step}`);
        li.dataset.kind = t.kind;
        if (t.kind === 'tool') li.append(el('b', undefined, toolLabel(t)), el('span', undefined, ` ${t.summary}`));
        else if (t.kind === 'thought') li.append(el('i', undefined, t.summary.replace(/\*\*/g, '').split(/(?<=[.!?])\s/)[0].slice(0, 200)));
        else li.append(el('b', undefined, t.kind === 'floor' ? 'Safety rule: ' : 'Fallback: '), el('span', undefined, t.summary));
        ol.append(li);
      }
      return ol;
    };
    if (!r1) {
      const s1 = steps(1);
      col.append(el('p', 'w-wait', inc.status === 'gathering' ? 'Waiting for evidence' : s1 ? 'Looking into it...' : 'Thinking...'));
      if (s1) col.append(s1);
    }
    for (const p of [r1, r2]) {
      if (!p) continue;
      const s = steps(p.round);
      if (s) col.append(s);
      if (p === r2 && r1 && r1.stance === p.stance && r1.argument === p.argument) {
        const keep = fresh(el('div', 'w-pos w-keep'), p.id);
        keep.dataset.stance = p.stance;
        keep.append(el('span', 'w-round', 'After hearing the others: '), el('span', 'w-stance', STANCE[p.stance]), el('span', 'w-round', ' (unchanged)'));
        col.append(keep);
        continue;
      }
      const blk = fresh(el('div', 'w-pos'), p.id);
      blk.dataset.stance = p.stance;
      const top = el('div', 'w-ptop');
      top.append(el('span', 'w-round', p.round === 1 ? 'First take' : 'After hearing the others'), el('span', 'w-stance', STANCE[p.stance]));
      if (p.round === 2 && r1 && r1.stance !== p.stance) top.append(el('span', 'w-changed', 'changed its mind'));
      if (p.llm) top.append(el('span', 'w-llm', 'Claude'));
      const via = sender.get(p.id);
      if (via) top.append(el('span', 'w-via', `${channelKind === 'slim' ? 'SLIM ' : ''}${via}`));
      blk.append(top, el('p', 'w-arg', p.argument));
      col.append(blk);
    }
    if (r1 && !r2) {
      const s2 = steps(2);
      if (s2) col.append(el('p', 'w-wait', 'Reading the others...'), s2);
    }
    cols.append(col);
  }
  box.append(cols);

  // The negotiation, when they disagreed.
  if (v.moves.length) box.append(renderNegotiation(v));

  // The Investigator, only when it was called in.
  const inv = v.positions.find((p) => p.agent === 'investigator');
  const invSteps = steps3();
  if (inv || invSteps) {
    const ib = el('div', 'w-agent w-inv');
    ib.dataset.role = 'investigator';
    const h = el('div', 'w-ahead');
    h.append(el('strong', undefined, 'Investigator (Claude)'), el('span', undefined, ROLE_INFO.investigator.goal));
    ib.append(h);
    if (invSteps) ib.append(invSteps);
    if (inv) {
      const blk = fresh(el('div', 'w-pos'), inv.id);
      blk.dataset.stance = inv.stance;
      const top = el('div', 'w-ptop');
      top.append(el('span', 'w-round', 'Deciding vote'), el('span', 'w-stance', STANCE[inv.stance]));
      if (inv.llm) top.append(el('span', 'w-llm', 'Claude'));
      blk.append(top, el('p', 'w-arg', inv.argument));
      ib.append(blk);
    } else ib.append(el('p', 'w-wait', 'Looking into it...'));
    box.append(ib);
  }
  function steps3(): HTMLOListElement | null {
    const list = v!.traces.filter((t) => t.agent === 'investigator');
    if (!list.length) return null;
    const ol = el('ol', 'w-steps');
    for (const t of list) {
      const li = fresh(el('li', undefined), `${t.incidentId}:inv:${t.step}`);
      li.dataset.kind = t.kind;
      if (t.kind === 'tool') li.append(el('b', undefined, toolLabel(t)), el('span', undefined, ` ${t.summary}`));
      else if (t.kind === 'thought') li.append(el('i', undefined, t.summary.replace(/\*\*/g, '').split(/(?<=[.!?])\s/)[0].slice(0, 200)));
      else li.append(el('b', undefined, t.kind === 'floor' ? 'Safety rule: ' : 'Note: '), el('span', undefined, t.summary));
      ol.append(li);
    }
    return ol;
  }

  // Outcome, dissent, actions.
  if (v.outcome) {
    const o = v.outcome;
    const out = fresh(el('div', 'w-outcome'), `out:${o.incidentId}`);
    out.dataset.kind = o.kind;
    out.append(el('strong', 'w-ohead', o.headline), el('p', undefined, o.summary));
    const alone = v.reports.filter((r) => r.localVerdict !== 'none');
    const n = v.reports.length;
    let counterfactual = '';
    if (o.kind !== 'escalate' && alone.length) {
      counterfactual = `Without the agents: ${alone.map((r) => r.name).join(' and ')} would have raised a fall alarm on ${alone.length > 1 ? 'their' : 'its'} own.`;
    } else if (o.kind !== 'stand_down' && v.incident.status !== 'resolved_ok' && alone.length * 2 <= n && n >= 2) {
      counterfactual = alone.length
        ? `A majority vote would have missed this: only ${alone.map((r) => r.name).join(' and ')} raised it on its own, ${alone.length} of ${n}.`
        : 'No phone flagged this on its own: a single phone or a majority vote would have missed it.';
    }
    if (counterfactual) out.append(el('p', 'w-counter', counterfactual));
    if (o.dissent.length && o.kind !== 'ask_human') {
      const d = el('p', 'w-dissent');
      d.textContent = `Kept on the record: ${o.dissent.map((x) => `${ROLE_INFO[x.agent].title} said ${STANCE[x.stance].toLowerCase()} ("${x.argument}")`).join('; ')}`;
      out.append(d);
    }
    const acts = el('ul', 'w-actions');
    for (const a of v.actions) {
      const li = el('li', undefined, `${actionLabel(a)}: ${a.detail}`);
      li.dataset.ok = String(a.ok);
      acts.append(li);
    }
    if (v.human) acts.append(el('li', 'w-human', `Human answer: ${v.human.answer === 'ok' ? 'they are OK' : v.human.answer === 'help' ? 'help needed' : 'no answer'} (${v.human.source})`));
    if (acts.childElementCount) out.append(acts);
    if (inc.status === 'asking' || inc.status === 'urgent' || inc.status === 'escalated') {
      const row = el('div', 'w-answer');
      const ok = el('button', 'small-btn', 'They are OK');
      ok.addEventListener('click', () => hub.send({ type: 'council', action: 'human', incidentId: inc.id, answer: 'ok' }));
      row.append(ok);
      if (inc.status === 'asking' || inc.status === 'urgent') {
        const help = el('button', 'small-btn danger', 'They need help');
        help.addEventListener('click', () => hub.send({ type: 'council', action: 'human', incidentId: inc.id, answer: 'help' }));
        row.append(help);
      }
      out.append(row);
    }
    box.append(out);
  }
  box.append(renderLog(v));
}

function toolLabel(t: AgentTrace): string {
  switch (t.tool) {
    case 'physics_check':
      return 'Checked the physics:';
    case 'ask_cartographer':
      return 'Asked the Cartographer:';
    case 'ask_all_phones':
      return 'Asked every phone to look again (one broadcast on SLIM):';
    case 'ask_phone':
      return 'Asked one phone directly:';
    case 'home_history':
      return 'Read the home history:';
    case 'role_checklist':
      return 'Ran its checklist:';
    default:
      return `${t.tool}:`;
  }
}

const MOVE_WORDS: Record<Move['kind'], string> = { offer: 'Opening offer', challenge: 'Challenges', concede: 'Concedes', counter: 'Counter offer', accept: 'Accepts' };
function renderNegotiation(v: View): HTMLElement {
  const box = el('div', 'w-nego');
  const rounds = Math.max(...v.moves.map((m) => m.round));
  const head = el('div', 'w-ahead');
  head.append(
    el('strong', undefined, 'Negotiation'),
    el('span', undefined, v.outcome?.negotiation ? (v.outcome.negotiation.agreed ? `Agreed after ${v.outcome.negotiation.rounds} round${v.outcome.negotiation.rounds > 1 ? 's' : ''}` : `No agreement after ${v.outcome.negotiation.rounds} rounds: the disagreement is kept and the person is asked`) : `Round ${rounds} of 3: each agent is its own Claude, talking over the SLIM channel`),
  );
  box.append(head);
  for (let r = 0; r <= rounds; r++) {
    const ms = v.moves.filter((m) => m.round === r);
    if (!ms.length) continue;
    box.append(el('div', 'w-nround', r === 0 ? 'Where each agent started' : `Round ${r}`));
    for (const m of ms) {
      const row = fresh(el('div', 'w-move'), m.id);
      row.dataset.role = m.agent;
      row.dataset.kind = m.kind;
      const top = el('div', 'w-mtop');
      top.append(el('strong', undefined, ROLE_INFO[m.agent].title), el('span', 'w-mkind', `${m.kind === 'offer' && m.round > 0 ? 'Offers' : MOVE_WORDS[m.kind]}${m.to ? ` the ${ROLE_INFO[m.to].title}` : ''}`));
      // Did this agent move from where it stood before?
      const before = [...v.moves].filter((x) => x.agent === m.agent && x.round < m.round).pop();
      if (before && before.plan.action !== m.plan.action) top.append(el('span', 'w-changed', `changed its mind: ${ACTION_WORDS[before.plan.action]} → ${ACTION_WORDS[m.plan.action]}`));
      if (m.llm) top.append(el('span', 'w-llm', 'Claude'));
      row.append(top);
      const steps = v.traces.filter((t) => t.agent === m.agent && t.round === r + 2 && t.kind === 'tool');
      for (const t of steps) row.append(el('p', 'w-mcheck', `Checked: ${t.summary}`));
      if (m.claim && (m.kind === 'challenge' || m.kind === 'concede')) row.append(el('p', 'w-mclaim', `"${m.claim}"`));
      row.append(el('p', 'w-arg', m.argument));
      const chip = el('span', 'w-plan', describePlan(m.plan));
      chip.dataset.action = m.plan.action;
      row.append(chip);
      box.append(row);
    }
  }
  if (v.outcome?.plan) {
    const fin = el('div', 'w-deal');
    fin.dataset.action = v.outcome.plan.action;
    fin.append(el('strong', undefined, v.outcome.negotiation?.agreed ? 'Agreed plan: ' : 'No agreement, so the person is asked: '), el('span', undefined, describePlan(v.outcome.plan)));
    box.append(fin);
  }
  return box;
}

let logOpen = false;
function renderLog(v: View): HTMLElement {
  const d = el('details', 'w-log');
  d.open = logOpen;
  d.addEventListener('toggle', () => (logOpen = d.open));
  d.append(el('summary', undefined, `Channel log: ${v.log.length} A2A messages over ${channelKind === 'slim' ? 'AGNTCY SLIM' : 'the local channel'}`));
  const ol = el('ol');
  for (const e of v.log) {
    const li = el('li');
    li.append(el('time', undefined, `+${((e.t - v.log[0].t) / 1000).toFixed(1)} s`), el('code', undefined, e.from || 'hub'), el('span', undefined, e.what));
    ol.append(li);
  }
  d.append(ol);
  return d;
}

function actionLabel(a: ActionRecord): string {
  return { call: 'Call', sms: 'Text', webhook: 'Chat', webex: 'Webex', ask_phone: 'Ask', quarantine: 'Quarantine' }[a.action];
}

function renderHistory(): void {
  const ol = $('w-history');
  ol.replaceChildren();
  const list = [...views.values()].sort((a, b) => b.incident.t0 - a.incident.t0).slice(0, 12);
  $('w-histhead').hidden = list.length < 2;
  for (const v of list) {
    const li = el('li');
    const b = el('button');
    b.setAttribute('aria-current', String(v.incident.id === selected));
    const kind = v.outcome?.kind;
    b.dataset.kind = kind ?? 'open';
    b.append(
      el('time', undefined, new Date(v.incident.t0).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })),
      el('span', 'w-hname', v.incident.simulated ? (SCENARIOS.find((s) => s.key === v.incident.scenario)?.title ?? 'Simulation') : `${v.incident.trigger.name}: ${v.incident.trigger.kind.replace('_', ' ')}`),
      el('span', 'w-hout', STATUS_TEXT[v.incident.status]),
    );
    b.addEventListener('click', () => {
      selected = v.incident.id;
      pinned = true;
      render();
    });
    li.append(b);
    ol.append(li);
  }
}

function renderEval(m: Extract<ServerMsg, { type: 'eval' }>): void {
  $('w-evalnote').textContent = `${m.trials} randomized trials per scenario on the evidence simulator (three phones, sensor noise, misses and misclassified sounds). Rows marked held out were written after the agents were tuned. These columns use the rule agents (free and repeatable); to score the Claude agents on the same evidence run node dist/eval.cjs --claude 2 on the hub computer.`;
  const t = $('w-evaltable');
  t.replaceChildren();
  const thead = el('thead');
  const hr = el('tr');
  for (const h of ['Scenario', 'Single phone', 'Any phone', 'Majority vote', 'Agents', 'Agents + room map']) hr.append(el('th', undefined, h));
  thead.append(hr);
  const tb = el('tbody');
  for (const r of m.rows) {
    const tr = el('tr');
    const th = el('th');
    th.append(el('span', undefined, r.title), el('small', undefined, `${r.emergency ? 'real fall' : 'no emergency'}${r.heldOut ? ', held out' : ''}`));
    tr.append(th);
    r.cells.forEach((c, i) => {
      const td = el('td', undefined, c);
      const bad = r.emergency ? !/^100%/.test(c) : !/^0%/.test(c);
      td.dataset.bad = String(bad);
      if (i >= 3) td.dataset.ours = 'true';
      tr.append(td);
    });
    tb.append(tr);
  }
  const tr = el('tr', 'w-total');
  tr.append(el('th', undefined, 'All scenarios'));
  m.totals.forEach((c, i) => {
    const td = el('td', undefined, c);
    if (i >= 3) td.dataset.ours = 'true';
    tr.append(td);
  });
  tb.append(tr);
  t.append(thead, tb);
}
