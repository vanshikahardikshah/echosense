import type { ScenarioSpec } from '../../src/agents/sim';

/**
 * Held-out red-team scenarios. Written before any red-team result was seen,
 * fingerprinted (sha256 in docs/REDTEAM.md), and run exactly once, last.
 * Nothing in EchoSense may be tuned against these.
 */
export interface RTSpec extends ScenarioSpec {
  /** How many phones are live (the first N of the layout). */
  phones?: number;
  family?: string;
}

export const HOLDOUT: RTSpec[] = [
  {
    key: 'ho_slide_off_bed',
    title: 'Slides off the edge of the bed',
    description: 'Sitting on the bed edge near Phone 3, slides down to the floor; soft thud sometimes; Phone 1 cannot see.',
    emergency: true,
    person: { from: [2.6, 3.0], to: [2.6, 3.0], at: [2.8, 2.6], before: 'sit', after: 'floor', event: 'collapse' },
    sounds: [{ at: 500, from: 'person', level: 22, cls: 'impact', ai: { group: 'thud', p: 0.55 }, prob: 0.6 }],
    occluded: [0],
  },
  {
    key: 'ho_pet_knocks_chair',
    title: 'Pet knocks over a chair',
    description: 'Seated and still on the couch; a chair falls over across the room.',
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'none' },
    sounds: [{ at: 0, from: [3.6, 1.0], level: 37, cls: 'impact', ai: { group: 'object', p: 0.65 } }],
  },
  {
    key: 'ho_fall_mid_call',
    title: 'Falls in the middle of a loud phone call',
    description: 'Talking loudly on a call while walking, trips and falls.',
    emergency: true,
    person: { from: [1.2, 1.0], to: [2.3, 1.8], at: [2.7, 2.3], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [
      { at: -3000, from: 'person', level: 30, cls: 'voice', ai: { group: 'speech', p: 0.9 } },
      { at: -1500, from: 'person', level: 32, cls: 'scream', ai: { group: 'speech', p: 0.85 } },
      { at: 250, from: 'person', level: 36, cls: 'impact', ai: { group: 'thud', p: 0.7 } },
    ],
  },
  {
    key: 'ho_kneels_to_clean',
    title: 'Kneels down to clean under the couch',
    description: 'Walks over, gets down on the floor on purpose, usually gets up again.',
    emergency: false,
    person: { from: [2.6, 1.2], to: [1.8, 2.2], at: [1.8, 2.4], before: 'walk', after: 'floor', event: 'bend', resumeProb: 0.75 },
    sounds: [],
  },
  {
    key: 'ho_fall_two_phones',
    title: 'Fall with only two phones running',
    description: 'Phone 3 is off (charging elsewhere); a real fall in the middle of the room.',
    emergency: true,
    person: { from: [1.6, 1.2], to: [2.4, 1.9], at: [2.7, 2.4], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 36, cls: 'impact', ai: { group: 'thud', p: 0.7 } }],
    phones: 2,
  },
  {
    key: 'ho_tv_scream_nap',
    title: 'Horror movie scream while napping',
    description: 'Dozing still on the couch; the TV screams loudly.',
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'none' },
    sounds: [{ at: 0, from: 'media', level: 42, cls: 'scream', ai: { group: 'media', p: 0.7 } }],
    media: [4.7, 0.9],
  },
  {
    key: 'ho_fake_fall_tv',
    title: 'Hacked phone fakes a fall during a movie',
    description: 'Seated watching TV; compromised Phone 3 reports a fall.',
    emergency: false,
    person: { from: [1.3, 2.6], to: [1.3, 2.6], at: [1.3, 2.6], before: 'sit', after: 'sit', event: 'none' },
    sounds: [],
    media: [4.7, 0.9],
    compromised: { phone: 2, kind: 'fake_fall' },
  },
  {
    key: 'ho_quiet_fall_hall',
    title: 'Quiet fall in the hallway',
    description: 'Falls out of every sonar view onto carpet; only a muffled sound.',
    emergency: true,
    person: { from: [2.6, 1.6], to: [4.5, 3.5], at: [4.75, 3.75], before: 'walk', after: 'floor', event: 'fall' },
    sounds: [{ at: 250, from: 'person', level: 25, cls: 'impact', ai: { group: 'thud', p: 0.6 } }],
    outOfView: [4.1, 3.1, 5, 4],
  },
];
