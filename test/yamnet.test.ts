import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Yamnet } from '../src/audio/yamnet';

describe('YAMNet port', () => {
  const buf = readFileSync('public/models/yamnet.bin');
  const model = Yamnet.fromBuffer(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const vec = JSON.parse(readFileSync('test/fixtures-yamnet.json', 'utf8')) as Record<string, { wav: number[]; scores: number[] }>;
  for (const [name, v] of Object.entries(vec)) {
    it(`matches the TFLite model on ${name}`, () => {
      const t = performance.now();
      const s = model.run(Float32Array.from(v.wav));
      const ms = performance.now() - t;
      let maxDiff = 0;
      for (let i = 0; i < 521; i++) maxDiff = Math.max(maxDiff, Math.abs(s[i] - v.scores[i]));
      const top = (a: ArrayLike<number>) => Array.from(a).map((x, i) => [x, i]).sort((p, q) => q[0] - p[0]).slice(0, 3).map((p) => p[1]);
      expect(top(s)).toContain(top(v.scores)[0]);
      expect(maxDiff).toBeLessThan(0.1);
      console.log(name, 'max diff', maxDiff.toFixed(4), `${ms.toFixed(0)} ms`);
    });
  }
});
