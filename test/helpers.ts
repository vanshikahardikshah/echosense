import { bandPlan, designChirp, WIDE_BAND, Band } from '../src/dsp/chirp';
import { SonarFrame, SonarProcessor } from '../src/dsp/sonar';
import { Scenario } from '../src/sim/body';
import { defaultRoom, renderRoom, RoomConfig } from '../src/sim/room';

export const FS = 48000;

export function makeSonar(band: Band = WIDE_BAND) {
  return new SonarProcessor({ fs: FS, band });
}

export function simulate(
  scenario: Scenario,
  opts: { band?: Band; room?: Partial<RoomConfig>; sonar?: SonarProcessor } = {},
) {
  const sonar = opts.sonar ?? makeSonar(opts.band);
  const room = defaultRoom(FS, sonar.design, opts.room);
  const { mic, body } = renderRoom(room, scenario);
  const frames: SonarFrame[] = [];
  // Feed in irregular block sizes like a real audio callback.
  let i = 0;
  let k = 0;
  while (i < mic.length) {
    const len = [128, 480, 1024, 256][k++ % 4];
    sonar.pushSamples(mic.subarray(i, Math.min(mic.length, i + len)), (f) => frames.push(f));
    i += len;
  }
  return { frames, body, sonar, mic };
}

export { bandPlan, designChirp };
