// Render a scenario to a WAV file that a browser can use as its microphone.
//   node gen-wav.cjs <scenario> <out.wav> [txOnAt]
import { writeFileSync } from 'node:fs';
import { designChirp, WIDE_BAND, choosePeriod } from '../src/dsp/chirp';
import { defaultRoom, encodeWav, renderRoom } from '../src/sim/room';
import { SCENARIOS } from '../src/sim/scenarios';

const [name = 'demo', out = 'scene.wav', txOn = '0.8'] = process.argv.slice(2);
const fs = 48000;
const design = designChirp(fs, choosePeriod(fs, 3.5), WIDE_BAND);
const room = defaultRoom(fs, design, { txOnAt: Number(txOn), seed: 21 });
const { mic } = renderRoom(room, SCENARIOS[name]);
writeFileSync(out, encodeWav(mic, fs));
console.log(`wrote ${out}: ${(mic.length / fs).toFixed(1)} s`);
