import type { EvidenceReport } from './types';

/**
 * The Cartographer: the agent that knows the home.
 *
 * Sonar measures distance, not identity: it cannot tell a sofa from a TV. So
 * the map is taught once, the way you would show a new carer around: stand at
 * the sofa and press "I'm at the sofa"; every phone records how far away you
 * are. Each place becomes a fingerprint of distances. Phones can also be
 * labelled with what they sit next to ("by the TV"). On top of that it learns
 * on its own where people usually rest (distances where someone stays still).
 *
 * During an incident it answers two questions for the other agents:
 *   Where did the bang come from? Sound loses 6 dB per doubling of distance,
 *     so the pattern of loudness across phones fits one place much better than
 *     others: the TV, the person, or one of the phones itself.
 *   Where did the person end up? Their final distances match a known place
 *     (the sofa, the bed) or none (the middle of the floor).
 */

export type PlaceKind = 'tv' | 'speaker' | 'sofa' | 'chair' | 'bed' | 'desk' | 'kitchen' | 'bathroom' | 'door' | 'stairs' | 'other';

export const PLACE_KINDS: { kind: PlaceKind; label: string; rest: boolean; source: boolean }[] = [
  { kind: 'tv', label: 'TV', rest: false, source: true },
  { kind: 'speaker', label: 'Speaker or radio', rest: false, source: true },
  { kind: 'sofa', label: 'Sofa', rest: true, source: false },
  { kind: 'chair', label: 'Chair', rest: true, source: false },
  { kind: 'bed', label: 'Bed', rest: true, source: false },
  { kind: 'desk', label: 'Desk', rest: true, source: false },
  { kind: 'kitchen', label: 'Kitchen', rest: false, source: false },
  { kind: 'bathroom', label: 'Bathroom', rest: false, source: false },
  { kind: 'door', label: 'Door', rest: false, source: false },
  { kind: 'stairs', label: 'Stairs', rest: false, source: false },
  { kind: 'other', label: 'Other', rest: false, source: false },
];

export interface Place {
  id: string;
  name: string;
  kind: PlaceKind;
  /** Distance from each phone (by phone id) when the place was marked, metres. */
  ranges: Record<string, number>;
  createdAt: number;
}

export interface HomeMap {
  /** What each phone sits next to (by phone id). */
  phones: Record<string, { label: string; near?: PlaceKind }>;
  places: Place[];
  /** Learned resting distances per phone: counts per 0.1 m bin (0..4 m). */
  resting: Record<string, number[]>;
}

export function emptyMap(): HomeMap {
  return { phones: {}, places: [], resting: {} };
}

const BIN = 0.1;
const BINS = 40;

/** Record that someone stayed still at this distance from this phone. */
export function learnRest(map: HomeMap, phone: string, range: number): void {
  const h = (map.resting[phone] ??= new Array(BINS).fill(0));
  const b = Math.min(BINS - 1, Math.max(0, Math.round(range / BIN)));
  h[b]++;
}

export function isUsualRest(map: HomeMap, phone: string, range: number): number {
  const h = map.resting[phone];
  if (!h) return 0;
  const b = Math.round(range / BIN);
  let n = 0;
  for (let k = b - 2; k <= b + 2; k++) if (k >= 0 && k < BINS) n += h[k];
  return n;
}

export interface SourceFit {
  name: string;
  kind: PlaceKind | 'person' | 'phone';
  /** RMS misfit of the loudness pattern, dB (lower is better). */
  errDb: number;
  phones: number;
}

export interface MapContext {
  notes: string[];
  source: SourceFit | null;
  /** How well the person's own position fits the loudness pattern, for comparison. */
  personFit: SourceFit | null;
  endedAt: { place: Place; offBy: number; phones: number } | null;
  usualRest: boolean;
  /** A phone labelled as sitting next to a sound source heard the bang loudest. */
  loudestNear: { phone: string; near: PlaceKind; label: string } | null;
}

/** Fit a source at known distances to the measured levels: L_i = L0 - 20 log10(d_i). */
function fit(levels: { id: string; db: number }[], dist: Record<string, number>, name: string, kind: SourceFit['kind']): SourceFit | null {
  const pts = levels.filter((l) => dist[l.id] !== undefined).map((l) => ({ db: l.db, att: 20 * Math.log10(Math.max(dist[l.id], 0.25)) }));
  // Two points always fit some loudness; it takes three phones to tell places apart.
  if (pts.length < 3) return null;
  const l0 = pts.reduce((a, p) => a + p.db + p.att, 0) / pts.length;
  const err = Math.sqrt(pts.reduce((a, p) => a + (p.db + p.att - l0) ** 2, 0) / pts.length);
  return { name, kind, errDb: err, phones: pts.length };
}

export function cartograph(map: HomeMap, reports: EvidenceReport[]): MapContext {
  const notes: string[] = [];
  // Levels: phones that heard the impact; phones that heard nothing count as quiet (below 6 dB).
  const heard = reports.filter((r) => r.sound.impactDb !== null);
  const levels = reports.filter((r) => r.samples >= 10).map((r) => ({ id: r.nodeId, db: r.sound.impactDb ?? 4 }));

  // Candidate sources: every marked place, the person, and each phone itself.
  const fits: SourceFit[] = [];
  for (const p of map.places) {
    const f = fit(levels, p.ranges, p.name, p.kind);
    if (f) fits.push(f);
  }
  const person: Record<string, number> = {};
  for (const r of reports) {
    const d = r.sonar.rangeAfter ?? r.sonar.rangeBefore;
    if (d !== null && r.sonar.online) person[r.nodeId] = d;
  }
  const personFit = fit(levels, person, 'where the person is', 'person');
  if (personFit) fits.push(personFit);
  for (const r of heard) {
    // A source right at this phone: about 0.15 m from it, and other phones' distances unknown,
    // so judge it by how much louder it was there than anywhere else.
    const others = levels.filter((l) => l.id !== r.nodeId);
    if (!others.length) continue;
    const margin = (r.sound.impactDb ?? 0) - Math.max(...others.map((o) => o.db));
    if (margin >= 12) fits.push({ name: `right at ${r.name}`, kind: 'phone', errDb: Math.max(0, 6 - margin / 4), phones: levels.length });
  }
  // With fewer phones, use order instead of fit: which marked place is the loudest phone closest to?
  const loudestPhone = [...heard].sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  if (loudestPhone && !fits.some((f) => f.kind !== 'phone')) {
    const others = levels.filter((l) => l.id !== loudestPhone.nodeId);
    const margin = (loudestPhone.sound.impactDb ?? 0) - Math.max(-99, ...others.map((o) => o.db));
    const nearest = map.places
      .map((p) => ({ p, d: p.ranges[loudestPhone.nodeId] }))
      .filter((x) => x.d !== undefined && x.d <= 1.5)
      .sort((a, b) => a.d - b.d)[0];
    const personHere = person[loudestPhone.nodeId];
    if (nearest && margin >= 4 && (personHere === undefined || personHere > nearest.d + 0.8)) {
      fits.push({ name: nearest.p.name, kind: nearest.p.kind, errDb: 1, phones: levels.length });
      notes.push(`the bang was loudest on ${loudestPhone.name}, ${nearest.d.toFixed(1)} m from the ${nearest.p.name}${personHere !== undefined ? ` and ${personHere.toFixed(1)} m from the person` : ''}`);
    }
  }
  fits.sort((a, b) => a.errDb - b.errDb);
  const source = heard.length && fits.length ? fits[0] : null;
  if (source && personFit && source !== personFit) {
    notes.push(`the loudness pattern fits ${source.name} (off by ${source.errDb.toFixed(1)} dB) better than where the person is (off by ${personFit.errDb.toFixed(1)} dB)`);
  } else if (source && source === personFit) {
    notes.push(`the loudness pattern fits where the person is (off by ${source.errDb.toFixed(1)} dB)`);
  }

  // Phone labels: the loudest phone sits next to the TV or a speaker.
  let loudestNear: MapContext['loudestNear'] = null;
  const loudest = heard.sort((a, b) => (b.sound.impactDb ?? 0) - (a.sound.impactDb ?? 0))[0];
  const lab = loudest ? map.phones[loudest.nodeId] : undefined;
  if (loudest && lab?.near && (lab.near === 'tv' || lab.near === 'speaker')) {
    loudestNear = { phone: loudest.name, near: lab.near, label: lab.label };
    if (!notes.some((n) => n.startsWith(`the bang was loudest on ${loudest.name}`))) notes.push(`the bang was loudest on ${loudest.name}, which sits ${lab.label || `by the ${lab.near}`}`);
  }

  // Where did they end up?
  let endedAt: MapContext['endedAt'] = null;
  for (const p of map.places) {
    const common = Object.keys(person).filter((id) => p.ranges[id] !== undefined);
    if (!common.length) continue;
    const off = Math.max(...common.map((id) => Math.abs(person[id] - p.ranges[id])));
    if (off <= 0.4 && (!endedAt || off < endedAt.offBy || common.length > endedAt.phones)) endedAt = { place: p, offBy: off, phones: common.length };
  }
  if (endedAt) notes.push(`they ended up at the ${endedAt.place.name} (within ${(endedAt.offBy * 100).toFixed(0)} cm on ${endedAt.phones} phone${endedAt.phones > 1 ? 's' : ''})`);
  else if (Object.keys(person).length && map.places.length) notes.push('they ended up away from every marked place');

  const usualRest = Object.entries(person).some(([id, d]) => isUsualRest(map, id, d) >= 5);
  if (usualRest && !endedAt) notes.push('they stopped at a spot where someone often rests');
  if (!notes.length) notes.push(map.places.length ? 'nothing in the room map bears on this' : 'no room map yet: mark the TV and the sofa on the console');
  return { notes, source, personFit, endedAt, usualRest, loudestNear };
}

export function kindInfo(k: PlaceKind) {
  return PLACE_KINDS.find((p) => p.kind === k) ?? PLACE_KINDS[PLACE_KINDS.length - 1];
}
