/**
 * Groups of YAMNet (AudioSet) classes that matter for home safety. A group's
 * score is the highest score among its classes.
 */

export type SoundGroup = 'thud' | 'glass' | 'distress' | 'speech' | 'media' | 'tap' | 'object' | 'footsteps' | 'silence';

const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

export const GROUPS: Record<SoundGroup, number[]> = {
  // A body or something heavy hitting the floor.
  thud: [454, 455, 460, 462, 463, 464, 434],
  glass: [435, 436, 437],
  // Someone hurt or frightened: screaming, crying, whimpering, wailing, groaning.
  // Not shouting, yelling, gasping or grunting: animated talking (a phone call,
  // an argument with the TV) scores high on those and is not distress.
  distress: [11, 19, 21, 22, 33],
  speech: [0, 1, 2, 3],
  // TV, radio, music, film sound effects.
  media: [...range(132, 276), 518, 519, 498, 420, 421, 422, 423, 424, 426, 61, 62, 5],
  // Small sounds people make on purpose or in passing: snaps, claps, taps, typing.
  tap: [57, 58, 353, 354, 401, 402, 378, 380, 381, 359, 357, 356, 373, 374, 355, 360, 432, 413],
  // Household objects: doors, pots and pans, things clattering.
  object: [358, 352, 348, 351, 483, 465, 431],
  footsteps: [46, 47, 48],
  silence: [494],
};

export const GROUP_WORDS: Record<SoundGroup, string> = {
  thud: 'a heavy thud',
  glass: 'glass breaking',
  distress: 'someone in distress',
  speech: 'someone talking',
  media: 'TV or music',
  tap: 'a small tap or snap',
  object: 'a household object',
  footsteps: 'footsteps',
  silence: 'silence',
};

export interface AiFrame {
  /** Seconds of audio stream at the end of the analysed window. */
  t: number;
  groups: Record<SoundGroup, number>;
  top: { name: string; score: number }[];
}

export function groupScores(scores: ArrayLike<number>): Record<SoundGroup, number> {
  const out = {} as Record<SoundGroup, number>;
  for (const g of Object.keys(GROUPS) as SoundGroup[]) {
    let m = 0;
    for (const i of GROUPS[g]) m = Math.max(m, scores[i]);
    out[g] = m;
  }
  return out;
}

export function topClasses(scores: ArrayLike<number>, names: string[], n = 3): { name: string; score: number }[] {
  return Array.from(scores, (s, i) => ({ s, i }))
    .sort((a, b) => b.s - a.s)
    .slice(0, n)
    .map(({ s, i }) => ({ name: names[i] ?? String(i), score: Math.round(s * 1000) / 1000 }));
}

/** Highest group scores over AI frames whose window overlaps [t0, t1]. */
export function groupsBetween(frames: AiFrame[], t0: number, t1: number, windowS = 0.975): Record<SoundGroup, number> | null {
  const hit = frames.filter((f) => f.t >= t0 && f.t - windowS <= t1);
  if (!hit.length) return null;
  const out = {} as Record<SoundGroup, number>;
  for (const g of Object.keys(GROUPS) as SoundGroup[]) out[g] = Math.max(...hit.map((f) => f.groups[g]));
  return out;
}

/** What the impact most likely was, among the groups that compete with a fall. */
export function impactLabel(g: Record<SoundGroup, number>): { group: SoundGroup; score: number } {
  const order: SoundGroup[] = ['thud', 'glass', 'distress', 'tap', 'object', 'speech', 'media', 'footsteps'];
  let best: SoundGroup = 'thud';
  for (const k of order) if (g[k] > g[best]) best = k;
  return { group: best, score: g[best] };
}

/**
 * Distress the model is sure about: a scream, crying or groaning that is
 * clearly stronger than ordinary talking in the same window.
 */
export function isDistress(g: Record<SoundGroup, number>): boolean {
  return g.distress >= 0.5 && g.distress >= g.speech;
}
