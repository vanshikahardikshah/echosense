import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ruleIntent, understand } from '../src/agents/intent';
import { pcm16ToFloat, SpeechToText } from '../src/server/stt';

describe('what the person meant', () => {
  const cases: [string, 'ok' | 'help' | 'unclear'][] = [
    ["I'm fine", 'ok'],
    ['yeah yeah I am okay', 'ok'],
    ['Nooo, I am hurt', 'help'],
    ['no', 'unclear'],
    ['No.', 'unclear'],
    ['no no', 'unclear'],
    ["No, I'm hurt", 'help'],
    ['No, I am fine.', 'ok'],
    ["I'm not okay", 'help'],
    ['I fell and I cannot get up', 'help'],
    ['I think I broke my hip', 'help'],
    ['help', 'help'],
    ["I'm okay but my back hurts", 'help'],
    ['no no I just dropped a pan, I am fine', 'ok'],
    ['call my daughter', 'help'],
    ['the weather tomorrow in San Francisco', 'unclear'],
    ['', 'unclear'],
    // A phone call or the TV in the background is not an answer.
    ["yeah okay I'll call you back later tonight after dinner", 'unclear'],
    ["okay so the meeting is at three and then we'll go get dinner", 'unclear'],
    ["I'll call the doctor tomorrow about my appointment okay", 'unclear'],
    ['can you help me move the couch this weekend when you come over', 'help'],
    ['and the patient was rushed to the hospital in critical condition last night', 'unclear'],
    ['yes', 'ok'],
    // The end of the phone's own question leaking into the recording.
    ['K or say help. I am okay.', 'ok'],
    ["Are you OK? Say I'm OK, or say help. No, I'm hurt.", 'help'],
    ['or say help. help me', 'help'],
    ["I'm about to call for help. Say I'm OK if you are OK. I'm fine", 'ok'],
    ['say help.', 'unclear'],
    ['fine thanks', 'ok'],
  ];
  for (const [text, want] of cases) it(`"${text}" -> ${want}`, () => expect(ruleIntent(text).answer).toBe(want));

  it('finds what hurts', () => expect(ruleIntent('I think I broke my hip').injury).toBe('my hip'));

  it('help wins even if Claude would say OK', async () => {
    const r = await understand('I am okay but I cannot get up', { apiKey: 'k', model: 'm', mode: 'agent', timeoutMs: 1000, baseUrl: 'http://127.0.0.1:9' }, true);
    expect(r.answer).toBe('help');
  });
});

const model = 'models/speech/sherpa-onnx-moonshine-tiny-en-int8/tokens.txt';
describe.skipIf(!existsSync(model))('speech to text on the hub (real recordings)', () => {
  it('turns spoken answers into the right meaning', async () => {
    const stt = new SpeechToText(process.cwd(), () => {});
    stt.start();
    expect(stt.ready).toBe(true);
    const clips = JSON.parse(readFileSync('test/fixtures/spoken-answers.json', 'utf8')) as Record<string, string>;
    const want: Record<string, string> = { hurt: 'help', fine: 'ok', okay: 'ok', hip: 'help', dropped: 'ok', help: 'help', tv: 'unclear' };
    const got: Record<string, string> = {};
    for (const [k, b64] of Object.entries(clips)) {
      const text = stt.transcribe(pcm16ToFloat(b64));
      got[k] = `${(await understand(text, null, false)).answer} | ${text}`;
    }
    for (const k of Object.keys(want)) expect(got[k].split(' | ')[0], `${k}: ${got[k]}`).toBe(want[k]);
  }, 60000);
});
