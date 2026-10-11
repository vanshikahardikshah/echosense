import { Scenario } from './body';

/**
 * Scripted scenarios: used by the test-suite, by the end-to-end browser test
 * (rendered to a WAV that replaces the microphone) and by the app's clearly
 * labelled simulation mode.
 */
export const SCENARIOS: Record<string, Scenario> = {
  demo: {
    name: 'Investor demo: arrive, sit, breathe, stand, fall',
    segments: [
      { kind: 'absent', dur: 6 },
      { kind: 'walk', dur: 3.2, from: [3.0, 0.6], to: [1.0, 0.2] },
      { kind: 'sit', dur: 26, at: [1.0, 0.2], bpm: 14 },
      { kind: 'walk', dur: 1.5, from: [1.0, 0.2], to: [1.5, 0.3] },
      { kind: 'stand', dur: 3, at: [1.5, 0.3], bpm: 16 },
      { kind: 'fall', dur: 40, at: [1.5, 0.3], bpm: 19 },
    ],
    truth: [
      { t: 6, label: 'enters' },
      { t: 9.2, label: 'sits' },
      { t: 39.7, label: 'stands' },
      { t: 44.2, label: 'falls' },
    ],
  },
  fall: {
    name: 'Walk in, stand, fall with impact',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 3, from: [3.0, 0.8], to: [1.4, 0.3] },
      { kind: 'stand', dur: 4, at: [1.4, 0.3] },
      { kind: 'fall', dur: 25, at: [1.4, 0.3], bpm: 18 },
    ],
  },
  sitDown: {
    name: 'Walk in and sit down quickly (no fall)',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 3, from: [3.0, 0.8], to: [1.3, 0.2] },
      { kind: 'sit', dur: 25, at: [1.3, 0.2], bpm: 13 },
    ],
  },
  droppedObject: {
    name: 'Person standing still, a heavy object is dropped (no fall)',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 2.5, from: [3.0, 0.0], to: [1.6, 0.0] },
      { kind: 'stand', dur: 25, at: [1.6, 0.0], bpm: 12 },
    ],
    sounds: [{ t: 14, kind: 'thud', level: 0.3 }],
  },
  approach: {
    name: 'Someone walks straight up to the phone',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 3.5, from: [3.2, 0.0], to: [0.6, 0.0] },
      { kind: 'stand', dur: 10, at: [0.6, 0.0], bpm: 15 },
    ],
  },
  noisyEmpty: {
    name: 'Empty room with TV, music, speech, keys and a door slam',
    segments: [{ kind: 'absent', dur: 40 }],
    sounds: [
      { t: 3, kind: 'tv', dur: 10, level: 0.05 },
      { t: 14, kind: 'keys', level: 0.06 },
      { t: 17, kind: 'speech', dur: 5, level: 0.07 },
      { t: 24, kind: 'door', level: 0.3 },
      { t: 27, kind: 'music', dur: 12, level: 0.06 },
    ],
  },
  walkThroughDoor: {
    name: 'Person walks through, door slams behind them (no fall)',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 4, from: [3.0, -1.2], to: [2.0, 1.5] },
      { kind: 'walk', dur: 4, from: [2.0, 1.5], to: [3.2, 2.5] },
      { kind: 'absent', dur: 14 },
    ],
    sounds: [{ t: 9, kind: 'door', level: 0.3 }],
  },
  scream: {
    name: 'Scream in an otherwise quiet room',
    segments: [
      { kind: 'absent', dur: 4 },
      { kind: 'walk', dur: 2, from: [3.0, 0], to: [2.0, 0] },
      { kind: 'stand', dur: 12, at: [2.0, 0] },
    ],
    sounds: [{ t: 9, kind: 'scream', level: 0.25 }],
  },
};
