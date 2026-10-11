import { existsSync, readFileSync } from 'node:fs';
import { GATHER_MS } from '../src/agents/phoneAgent';
import { deliberate } from '../src/agents/protocol';
import type { EvidenceReport, Incident, Outcome } from '../src/agents/types';

/**
 * Calibration and validation from labelled real incidents (training.jsonl,
 * written by the console's calibration label row). Nothing here changes
 * EchoSense: it shows how far apart real falls and everyday events are on each
 * measurement, alone and in combination, in this room with these phones.
 *
 *   node dist/calibrate.cjs              the calibration set (held-out rows are counted, never shown)
 *   node dist/calibrate.cjs --holdout    the held-out set, re-scored with the current rules (run once, after freezing)
 */

interface Rec {
  label: 'fall' | 'not_fall';
  subtype?: string;
  location?: string;
  heldOut?: boolean;
  labelledAt: number;
  incident: Incident;
  reports: EvidenceReport[];
  outcome: Outcome | null;
  answer: { answer: string; transcript?: string } | null;
  escalated?: boolean;
}

const args = process.argv.slice(2);
const holdout = args.includes('--holdout');
const file = args.find((a) => !a.startsWith('--')) ?? 'training.jsonl';
if (!existsSync(file)) {
  console.log(`No ${file} yet. Label some incidents on the console first (the calibration label row above the incident).`);
  process.exit(0);
}
const byId = new Map<string, Rec>();
for (const line of readFileSync(file, 'utf8').split('\n').filter(Boolean)) {
  const r = JSON.parse(line) as Rec;
  byId.set(r.incident.id, r); // the last label for an incident wins
}
const all = [...byId.values()];

interface Row {
  rec: Rec;
  time: string;
  fall: boolean;
  subtype: string;
  location: string;
  impact: number;
  burst: number;
  still: number;
  rangeChange: number;
  link: number;
  heardBy: number;
  sawBy: number;
  resumed: boolean;
  sound: string;
  live: 'stood_down' | 'asked' | 'countdown' | 'caregiver_call';
  human: 'ok' | 'hurt' | 'none';
}

function toRow(r: Rec): Row {
  const online = r.reports.filter((x) => x.sonar.online);
  const seeing = online.filter((x) => x.sonar.sawPersonBefore);
  const loud = [...r.reports].filter((x) => x.sound.impactDb !== null).sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  const moves = seeing.filter((x) => x.sonar.rangeBefore !== null && x.sonar.rangeAfter !== null).map((x) => Math.abs(x.sonar.rangeAfter! - x.sonar.rangeBefore!));
  const st = r.incident.status;
  const live: Row['live'] = r.escalated || st === 'escalated' || st === 'resolved_help' ? 'caregiver_call' : r.outcome?.kind === 'escalate' || st === 'urgent' ? 'countdown' : r.outcome?.kind === 'ask_human' || st === 'asking' || r.answer ? 'asked' : 'stood_down';
  return {
    rec: r,
    time: new Date(r.incident.t0).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }),
    fall: r.label === 'fall',
    subtype: r.subtype ?? (r.label === 'fall' ? 'other_fall' : 'other'),
    location: r.location ?? '?',
    impact: Math.max(0, ...r.reports.map((x) => x.sound.impactDb ?? 0)),
    burst: Math.max(0, ...seeing.map((x) => x.sonar.burstDb)),
    still: Math.max(0, ...seeing.map((x) => x.sonar.stillAfter)) * 100,
    rangeChange: moves.length ? Math.max(...moves) : 0,
    link: online.length ? Math.min(...online.map((x) => x.sonar.medianLinkDb)) : 0,
    heardBy: r.reports.filter((x) => (x.sound.impactDb ?? 0) >= 15).length,
    sawBy: seeing.length,
    resumed: seeing.some((x) => x.sonar.motionResumed),
    sound: loud?.sound.impactAi ? `${loud.sound.impactAi.label} ${Math.round(loud.sound.impactAi.score * 100)}%` : '-',
    live,
    human: r.answer?.answer === 'ok' ? 'ok' : r.answer?.answer === 'help' ? 'hurt' : 'none',
  };
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const acted = (live: string) => live !== 'stood_down';

function table(rows: Row[]): void {
  console.log(pad('time', 12) + pad('label', 6) + pad('subtype', 15) + pad('where', 13) + pad('impact', 7) + pad('burst', 6) + pad('still', 6) + pad('range', 6) + pad('link', 5) + pad('saw', 4) + pad('moved', 6) + pad('sound', 18) + pad('EchoSense', 15) + 'person');
  for (const r of rows)
    console.log(
      pad(r.time, 12) + pad(r.fall ? 'FALL' : 'not', 6) + pad(r.subtype, 15) + pad(r.location, 13) + pad(r.impact.toFixed(0), 7) + pad(r.burst.toFixed(0), 6) + pad(`${r.still.toFixed(0)}%`, 6) + pad(`${r.rangeChange.toFixed(2)}`, 6) + pad(r.link.toFixed(0), 5) + pad(r.sawBy, 4) + pad(r.resumed ? 'yes' : 'no', 6) + pad(r.sound.slice(0, 17), 18) + pad(r.live, 15) + r.human,
    );
}

function bySubtype(rows: Row[]): void {
  const groups = new Map<string, Row[]>();
  for (const r of rows) groups.set(r.subtype, [...(groups.get(r.subtype) ?? []), r]);
  console.log(`\n${pad('what happened', 16)}${pad('n', 4)}${pad('stood down', 12)}${pad('asked', 7)}${pad('countdown', 11)}caregiver call`);
  for (const [k, g] of [...groups].sort((a, b) => Number(b[1][0].fall) - Number(a[1][0].fall) || a[0].localeCompare(b[0]))) {
    const c = (x: Row['live']) => g.filter((r) => r.live === x).length;
    const warn = g[0].fall && c('stood_down') ? '  <- missed falls' : !g[0].fall && c('caregiver_call') ? '  <- false calls' : '';
    console.log(`${pad(k, 16)}${pad(g.length, 4)}${pad(c('stood_down'), 12)}${pad(c('asked'), 7)}${pad(c('countdown'), 11)}${c('caregiver_call')}${warn}`);
  }
}

type Feat = 'impact' | 'burst' | 'still' | 'rangeChange';
const FEATS: Record<Feat, string> = { impact: 'impact dB', burst: 'body burst dB', still: 'still after %', rangeChange: 'range change m' };
const COMBOS: Feat[][] = [['impact'], ['burst'], ['still'], ['rangeChange'], ['impact', 'still'], ['burst', 'still'], ['impact', 'burst'], ['burst', 'rangeChange', 'still']];

/** Best "fall when every feature is at or above its cut" rule on these rows; ties go to catching more falls. */
function fitAll(rows: Row[], feats: Feat[]): { cuts: number[]; caught: number; left: number } {
  const falls = rows.filter((r) => r.fall);
  const nots = rows.filter((r) => !r.fall);
  const cands = feats.map((f) => [0, ...new Set(rows.map((r) => r[f]))].sort((a, b) => a - b));
  let best = { cuts: cands.map((c) => c[0]), caught: -1, left: -1 };
  const walk = (i: number, cuts: number[]) => {
    if (i === feats.length) {
      const hit = (r: Row) => feats.every((f, j) => r[f] >= cuts[j]);
      const caught = falls.filter(hit).length;
      const left = nots.filter((r) => !hit(r)).length;
      if (caught + left > best.caught + best.left || (caught + left === best.caught + best.left && caught > best.caught)) best = { cuts: [...cuts], caught, left };
      return;
    }
    for (const v of cands[i]) walk(i + 1, [...cuts, v]);
  };
  walk(0, []);
  return best;
}

function combos(rows: Row[]): void {
  const F = rows.filter((r) => r.fall).length;
  const N = rows.length - F;
  console.log(`\nWhich signals separate falls from everyday events (rule: fall when every listed signal is at or above its cut)`);
  console.log(`${pad('signals', 50)}${pad('best cuts (- = not needed)', 28)}${pad('falls caught', 14)}everyday left alone`);
  for (const c of COMBOS) {
    const b = fitAll(rows, c);
    console.log(`${pad(c.map((f) => FEATS[f]).join(' + '), 50)}${pad(c.map((f, i) => (b.cuts[i] === 0 ? '-' : `${b.cuts[i].toFixed(f === 'rangeChange' ? 2 : 0)}`)).join(' / '), 28)}${pad(`${b.caught}/${F}`, 14)}${b.left}/${N}`);
  }
  console.log('Reference, today\'s phone triggers: body burst >= 16 dB or impact >= 15 dB, then the agents weigh everything.');
  const stat = (xs: number[]) => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length ? `${s[0].toFixed(1)} / ${s[s.length >> 1].toFixed(1)} / ${s[s.length - 1].toFixed(1)}` : '-';
  };
  console.log(`\n${pad('min / median / max', 22)}${pad('falls', 24)}everyday`);
  for (const f of Object.keys(FEATS) as Feat[]) console.log(`${pad(FEATS[f], 22)}${pad(stat(rows.filter((r) => r.fall).map((r) => r[f])), 24)}${stat(rows.filter((r) => !r.fall).map((r) => r[f]))}`);
}

async function main(): Promise<void> {
  const cal = all.filter((r) => !r.heldOut).map(toRow);
  const held = all.filter((r) => r.heldOut).map(toRow);
  if (!holdout) {
    const F = cal.filter((r) => r.fall).length;
    console.log(`Calibration set: ${cal.length} labelled incidents (${F} falls, ${cal.length - F} everyday). Held-out set: ${held.length} (not shown; run with --holdout once, after freezing).\n`);
    if (!cal.length) return;
    table(cal);
    bySubtype(cal);
    if (F && cal.length - F) combos(cal);
    const weak = cal.filter((r) => r.link < 18).length;
    if (weak) console.log(`\n${weak} incident(s) had a phone with a sonar link under 18 dB (our setup target). Compare those rows before trusting a cut.`);
    console.log('\nThis is evidence, not new settings. With a few dozen examples a "best cut" fits these exact runs; move a threshold only when falls and everyday events are clearly apart, then check it on the held-out set.');
    return;
  }
  if (!held.length) {
    console.log('No held-out incidents yet. Tick "held out" on the console when labelling the final ~30%.');
    return;
  }
  // Re-score with the current agent rules (phone-side thresholds are already baked into the saved reports).
  const now: Row[] = [];
  for (const r of held) {
    const { outcome } = await deliberate(r.rec.incident, r.rec.reports, { now: () => r.rec.incident.t0 + GATHER_MS, seenFingerprints: new Set() });
    now.push({ ...r, live: outcome.kind === 'escalate' ? 'countdown' : outcome.kind === 'ask_human' ? 'asked' : 'stood_down' });
  }
  const F = held.filter((r) => r.fall).length;
  console.log(`Held-out set: ${held.length} incidents (${F} falls, ${held.length - F} everyday)\n`);
  table(held);
  console.log('\nAs it happened live:');
  bySubtype(held);
  console.log('\nRe-scored with the current rules (no person answering; watchful waiting not counted):');
  bySubtype(now);
  const caught = now.filter((r) => r.fall && acted(r.live)).length;
  const left = now.filter((r) => !r.fall && !acted(r.live)).length;
  console.log(`\nFalls acted on: ${caught}/${F}. Everyday events left alone: ${left}/${held.length - F}.`);
}

void main();
