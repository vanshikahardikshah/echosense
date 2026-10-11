import { Rng } from '../../src/sim/random';
import type { RTSpec } from './holdout';

/**
 * Adversarial scenario families. Each family is a generator: given a variant
 * rng it returns a fresh ScenarioSpec with randomized positions, loudness,
 * sound-model reliability, occlusion and phone count, so one family covers
 * many nearby situations instead of one hand-picked case.
 */
type Gen = (r: Rng) => Omit<RTSpec, 'key' | 'family'>;
export interface Family {
  id: string;
  emergency: boolean;
  /** What makes it nasty. */
  why: string;
  gen: Gen;
}

const u = (r: Rng, a: number, b: number) => r.uniform(a, b);
const pick = <T>(r: Rng, xs: T[]): T => xs[Math.floor(r.next() * xs.length)];
const pt = (r: Rng, x0: number, x1: number, y0: number, y1: number): [number, number] => [u(r, x0, x1), u(r, y0, y1)];
const near = (p: [number, number], r: Rng, d: number): [number, number] => [Math.min(4.8, Math.max(0.2, p[0] + u(r, -d, d))), Math.min(3.8, Math.max(0.2, p[1] + u(r, -d, d)))];
const TV: [number, number] = [4.7, 0.9];

export const FAMILIES: Family[] = [
  // ---------- Emergencies ----------
  {
    id: 'E01_fall_any_loudness',
    emergency: true,
    why: 'Plain fall, but impact loudness swept from carpet-quiet to tile-loud.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Fall, varied loudness', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.6), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 22, 42), cls: 'impact', ai: { group: 'thud', p: u(r, 0.5, 0.8) } }], screamProb: 0.15 };
    },
  },
  {
    id: 'E02_slide_from_chair',
    emergency: true,
    why: 'Seated person slides to the floor: small burst, little or no sound, no walking before.',
    gen: (r) => {
      const to = pt(r, 1.0, 3.8, 1.2, 3.0);
      return { title: 'Slides out of a chair', description: '', emergency: true, person: { from: to, to, at: near(to, r, 0.4), before: 'sit', after: 'floor', event: 'collapse' }, sounds: [{ at: 600, from: 'person', level: u(r, 10, 22), cls: 'impact', ai: { group: 'thud', p: 0.5 }, prob: 0.5 }] };
    },
  },
  {
    id: 'E03_silent_lowering',
    emergency: true,
    why: 'Slow lowering to the floor, no sound at all: sonar only.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Silent lowering', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'collapse' }, sounds: [] };
    },
  },
  {
    id: 'E04_fall_one_viewer',
    emergency: true,
    why: 'Only one phone has line of sight; the other two are occluded.',
    gen: (r) => {
      const seer = Math.floor(r.next() * 3);
      const anchors: [number, number][] = [[1.0, 1.0], [4.0, 1.0], [2.5, 3.0]];
      const to = near(anchors[seer], r, 0.3);
      return { title: 'Fall, one phone sees', description: '', emergency: true, person: { from: near(to, r, 0.8), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 28, 40), cls: 'impact', ai: { group: 'thud', p: 0.7 } }], occluded: [0, 1, 2].filter((i) => i !== seer) };
    },
  },
  {
    id: 'E05_fall_tv_masking',
    emergency: true,
    why: 'Real fall while the TV is loud: the media prior argues it was the movie.',
    gen: (r) => {
      const to = pt(r, 1.3, 2.6, 1.6, 2.8);
      return { title: 'Fall during TV', description: '', emergency: true, person: { from: near(to, r, 0.6), to, at: near(to, r, 0.6), before: pick(r, ['sit', 'walk'] as const), after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 28, 40), cls: 'impact', ai: { group: 'thud', p: u(r, 0.5, 0.75) } }, { at: u(r, -800, 800), from: 'media', level: u(r, 34, 42), cls: 'impact', ai: { group: 'media', p: 0.6 }, prob: 0.5 }], media: TV };
    },
  },
  {
    id: 'E06_fall_while_talking',
    emergency: true,
    why: 'Talking (or on speakerphone) right before the fall: lots of voice, a loud "scream" that is really speech.',
    gen: (r) => {
      const to = pt(r, 1.4, 3.4, 1.2, 2.6);
      return { title: 'Fall while talking', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: -3000, from: 'person', level: 28, cls: 'voice', ai: { group: 'speech', p: 0.9 } }, { at: -1200, from: 'person', level: u(r, 28, 36), cls: 'scream', ai: { group: 'speech', p: 0.85 }, prob: 0.6 }, { at: 250, from: 'person', level: u(r, 26, 38), cls: 'impact', ai: { group: 'thud', p: 0.65 } }] };
    },
  },
  {
    id: 'E07_fall_two_phones',
    emergency: true,
    why: 'Only two phones live (third off or charging).',
    gen: (r) => {
      const to = pt(r, 1.2, 3.8, 0.8, 2.6);
      return { title: 'Fall, two phones', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: pick(r, ['fall', 'collapse'] as const) }, sounds: [{ at: 250, from: 'person', level: u(r, 18, 40), cls: 'impact', ai: { group: 'thud', p: 0.65 }, prob: 0.8 }], phones: 2 };
    },
  },
  {
    id: 'E08_fall_single_phone',
    emergency: true,
    why: 'Only one phone running at all. No corroboration is possible.',
    gen: (r) => {
      const to = pt(r, 0.8, 2.6, 0.8, 2.2);
      return { title: 'Fall, one phone', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 24, 40), cls: 'impact', ai: { group: 'thud', p: 0.7 } }], phones: 1 };
    },
  },
  {
    id: 'E09_hidden_by_hacked_phone',
    emergency: true,
    why: 'A compromised phone insists all is well during a real fall.',
    gen: (r) => {
      const to = pt(r, 1.0, 3.6, 1.0, 2.6);
      const bad = Math.floor(r.next() * 3);
      return { title: 'Hacked phone hides fall', description: '', emergency: true, person: { from: near(to, r, 0.8), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 28, 40), cls: 'impact', ai: { group: 'thud', p: 0.7 } }], compromised: { phone: bad, kind: 'hide' }, occluded: r.next() < 0.4 ? [(bad + 1) % 3] : undefined };
    },
  },
  {
    id: 'E10_fall_out_of_view',
    emergency: true,
    why: 'Falls where no sonar can see (hallway, bathroom doorway); sound only.',
    gen: (r) => ({ title: 'Fall out of view', description: '', emergency: true, person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 22, 40), cls: 'impact', ai: { group: 'thud', p: u(r, 0.5, 0.8) } }], outOfView: [4.1, 3.1, 5, 4] }),
  },
  {
    id: 'E11_collapse_with_cry',
    emergency: true,
    why: 'Soft collapse with a cry/groan but almost no impact.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Collapse with cry', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'collapse' }, sounds: [{ at: 600, from: 'person', level: u(r, 10, 18), cls: 'impact', ai: { group: 'thud', p: 0.5 }, prob: 0.4 }], screamProb: 1 };
    },
  },
  {
    id: 'E12_fall_resumes_then_down',
    emergency: true,
    why: 'Falls, briefly struggles (a second burst), then stays down: "movement came back" is a trap.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Fall then struggle', description: '', emergency: true, person: { from: near(to, r, 1), to, at: near(to, r, 0.5), before: 'walk', after: 'floor', event: 'fall' }, sounds: [{ at: 250, from: 'person', level: u(r, 28, 38), cls: 'impact', ai: { group: 'thud', p: 0.7 } }, { at: 3000, from: 'person', level: u(r, 14, 22), cls: 'impact', ai: { group: 'object', p: 0.6 }, prob: 0.6 }] };
    },
  },
  // ---------- Not emergencies ----------
  {
    id: 'N01_tv_crash',
    emergency: false,
    why: 'Loud crash from the TV, person seated (sometimes flinches).',
    gen: (r) => ({ title: 'TV crash', description: '', emergency: false, person: { from: [1.3, 2.6], to: [u(r, 1.0, 2.0), u(r, 2.2, 3.0)], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'flinch', eventProb: u(r, 0.3, 0.9) }, sounds: [{ at: 0, from: 'media', level: u(r, 36, 44), cls: 'impact', ai: { group: pick(r, ['media', 'thud'] as const), p: 0.6 } }], media: near(TV, r, 0.2) }),
  },
  {
    id: 'N02_tv_scream',
    emergency: false,
    why: 'Screaming from the TV. The sound model sometimes says distress, not media.',
    gen: (r) => ({ title: 'TV scream', description: '', emergency: false, person: { from: [1.3, 2.6], to: [u(r, 1.0, 2.0), u(r, 2.2, 3.0)], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'flinch', eventProb: 0.4 }, sounds: [{ at: 0, from: 'media', level: u(r, 36, 44), cls: 'scream', ai: { group: pick(r, ['media', 'distress'] as const), p: u(r, 0.5, 0.8) } }], media: near(TV, r, 0.2) }),
  },
  {
    id: 'N03_drop_while_still',
    emergency: false,
    why: 'Drops a heavy object while standing still (no bend, no walk-away).',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Drop while still', description: '', emergency: false, person: { from: to, to, at: to, before: 'still', after: 'still', event: 'none' }, sounds: [{ at: 0, from: 'person', level: u(r, 28, 40), cls: 'impact', ai: { group: pick(r, ['object', 'thud'] as const), p: 0.65 } }] };
    },
  },
  {
    id: 'N04_hard_sit',
    emergency: false,
    why: 'Drops hard onto a couch or chair with a thump: burst + thud, then stillness.',
    gen: (r) => {
      const to = pt(r, 1.0, 2.0, 2.0, 3.0);
      return { title: 'Hard sit', description: '', emergency: false, person: { from: near(to, r, 1.2), to, at: near(to, r, 0.2), before: 'walk', after: 'sit', event: 'sit' }, sounds: [{ at: 300, from: 'person', level: u(r, 18, 30), cls: 'impact', ai: { group: pick(r, ['thud', 'object'] as const), p: 0.6 }, prob: 0.7 }] };
    },
  },
  {
    id: 'N05_door_slam',
    emergency: false,
    why: 'Door slams out of view while the person moves around or sits.',
    gen: (r) => ({ title: 'Door slam', description: '', emergency: false, person: { from: pt(r, 0.8, 2, 0.8, 2), to: pt(r, 1.5, 3, 1.2, 2.5), at: [2.4, 2.2], before: pick(r, ['walk', 'sit'] as const), after: 'walk', event: 'none' }, sounds: [{ at: 0, from: [u(r, 4.6, 5), u(r, 3.5, 4)], level: u(r, 34, 44), cls: 'impact', ai: { group: pick(r, ['object', 'thud'] as const), p: 0.7 } }] }),
  },
  {
    id: 'N06_phone_knocked',
    emergency: false,
    why: 'A phone itself falls to the floor (its own IMU and sonar go wild).',
    gen: (r) => {
      const k = Math.floor(r.next() * 3);
      const anchors: [number, number][] = [[0.8, 0.9], [4.2, 0.9], [2.5, 3.2]];
      return { title: 'Phone knocked', description: '', emergency: false, person: { from: near(anchors[k], r, 0.8), to: anchors[k], at: anchors[k], before: 'walk', after: 'walk', event: 'none' }, sounds: [{ at: 120, from: { phone: k }, level: u(r, 28, 36), cls: 'impact', ai: { group: 'object', p: 0.6 } }], knock: k };
    },
  },
  {
    id: 'N07_fake_fall',
    emergency: false,
    why: 'A compromised phone fabricates a consistent fall while the person is fine.',
    gen: (r) => ({ title: 'Fake fall', description: '', emergency: false, person: { from: pt(r, 0.8, 2, 0.8, 2), to: pt(r, 1.5, 3.5, 1.2, 2.8), at: [2.4, 2.3], before: pick(r, ['walk', 'sit'] as const), after: 'walk', event: 'none' }, sounds: [], compromised: { phone: Math.floor(r.next() * 3), kind: 'fake_fall' }, media: r.next() < 0.3 ? TV : undefined }),
  },
  {
    id: 'N08_bend_pick_up',
    emergency: false,
    why: 'Bends to pick something up; sometimes stays crouched a while.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Bend', description: '', emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.1), before: 'walk', after: 'still', event: 'bend', resumeProb: u(r, 0.3, 0.9) }, sounds: [{ at: 0, from: 'person', level: u(r, 20, 36), cls: 'impact', ai: { group: 'object', p: 0.7 }, prob: 0.6 }] };
    },
  },
  {
    id: 'N09_tap_near_phone',
    emergency: false,
    why: 'Taps/snaps/sets a cup down right next to a phone (loud to that phone only).',
    gen: (r) => {
      const k = Math.floor(r.next() * 3);
      return { title: 'Tap near phone', description: '', emergency: false, person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'none' }, sounds: [{ at: 0, from: { phone: k }, level: u(r, 14, 28), cls: 'impact', ai: { group: pick(r, ['tap', 'object'] as const), p: 0.8 } }] };
    },
  },
  {
    id: 'N10_animated_call',
    emergency: false,
    why: 'Loud, high-pitched talking on a call: the loudness detector says "scream".',
    gen: (r) => ({ title: 'Animated call', description: '', emergency: false, person: { from: [1.3, 2.6], to: pt(r, 1, 3, 1.5, 3), at: [1.3, 2.6], before: pick(r, ['sit', 'still', 'walk'] as const), after: 'sit', event: 'none' }, sounds: [{ at: 0, from: 'person', level: u(r, 30, 40), cls: 'scream', ai: { group: 'speech', p: u(r, 0.6, 0.9) } }, { at: 1500, from: 'person', level: u(r, 26, 34), cls: 'voice', ai: { group: 'speech', p: 0.9 } }] }),
  },
  {
    id: 'N11_kneel_on_purpose',
    emergency: false,
    why: 'Gets down on the floor on purpose (cleaning, cat under the bed), usually gets up.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Kneel', description: '', emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.2), before: 'walk', after: 'floor', event: 'bend', resumeProb: u(r, 0.5, 0.95) }, sounds: [] };
    },
  },
  {
    id: 'N12_lie_down_exercise',
    emergency: false,
    why: 'Lies down on the floor for stretching: indistinguishable from a collapse by design. Asking is the right answer; calling is not.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Floor exercise', description: '', emergency: false, person: { from: near(to, r, 1), to, at: near(to, r, 0.4), before: 'walk', after: 'floor', event: 'sit', resumeProb: 0.2 }, sounds: [] };
    },
  },
  {
    id: 'N13_object_falls_unseen',
    emergency: false,
    why: 'Something falls off a shelf while the person sits out of every view.',
    gen: (r) => ({ title: 'Shelf item falls, person unseen', description: '', emergency: false, person: { from: [4.6, 3.6], to: [4.6, 3.6], at: [4.6, 3.6], before: 'sit', after: 'sit', event: 'none' }, sounds: [{ at: 0, from: pt(r, 1, 4, 1, 3), level: u(r, 30, 40), cls: 'impact', ai: { group: pick(r, ['object', 'thud'] as const), p: 0.65 } }], outOfView: [4.1, 3.1, 5, 4] }),
  },
  {
    id: 'N14_hammering',
    emergency: false,
    why: 'Repetitive knocking/hammering while working at a table.',
    gen: (r) => {
      const to = pt(r, 1.2, 3.6, 1.0, 2.8);
      return { title: 'Hammering', description: '', emergency: false, person: { from: to, to, at: to, before: 'still', after: 'still', event: 'none' }, sounds: [0, 700, 1400, 2100].map((at) => ({ at, from: 'person' as const, level: u(r, 28, 38), cls: 'impact' as const, repetitive: true, ai: { group: 'object' as const, p: 0.7 } })) };
    },
  },
];
