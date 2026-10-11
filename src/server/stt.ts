import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Speech to text on the hub, so "No, I'm hurt" is understood as words and not
 * just "someone talked". Runs fully on this computer (Moonshine tiny through
 * sherpa-onnx, about 120 MB, downloaded once from the sherpa-onnx releases).
 * Audio never leaves the home; only the words go on to the agents.
 */

const MODEL = 'sherpa-onnx-moonshine-tiny-en-int8';
const URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL}.tar.bz2`;

type Recognizer = {
  createStream(): { acceptWaveform(w: { sampleRate: number; samples: Float32Array }): void };
  decode(s: unknown): void;
  getResult(s: unknown): { text: string };
};

export class SpeechToText {
  status = 'not started';
  private rec: Recognizer | null = null;
  readonly dir: string;

  constructor(
    root: string,
    private readonly log: (s: string) => void,
    private readonly onReady: () => void = () => {},
  ) {
    this.dir = path.join(root, 'models', 'speech');
  }

  get ready(): boolean {
    return !!this.rec;
  }

  start(): void {
    if (process.env.ECHOSENSE_STT === '0') {
      this.status = 'off (ECHOSENSE_STT=0)';
      return;
    }
    let sherpa: unknown;
    try {
      sherpa = createRequire(__filename)('sherpa-onnx-node');
    } catch (e) {
      this.status = `off: run npm install (sherpa-onnx-node missing: ${(e as Error).message.split('\n')[0]})`;
      this.log(`speech understanding ${this.status}`);
      return;
    }
    const model = path.join(this.dir, MODEL);
    if (existsSync(path.join(model, 'tokens.txt'))) this.load(sherpa, model);
    else this.download(sherpa, model);
  }

  private download(sherpa: unknown, model: string): void {
    this.status = 'downloading the speech model (about 110 MB, once)';
    this.log(`speech understanding: ${this.status}...`);
    mkdirSync(this.dir, { recursive: true });
    const tar = path.join(this.dir, `${MODEL}.tar.bz2`);
    const p = spawn('sh', ['-c', `curl -fsSL -o "${tar}" "${URL}" && tar xjf "${tar}" -C "${this.dir}" && rm -f "${tar}"`], { stdio: 'ignore' });
    p.on('exit', (code) => {
      if (code === 0 && existsSync(path.join(model, 'tokens.txt'))) this.load(sherpa, model);
      else {
        rmSync(tar, { force: true });
        this.status = `off: could not download the speech model (exit ${code}); check the internet and restart the hub`;
        this.log(`speech understanding ${this.status}`);
      }
    });
    p.on('error', (e) => {
      this.status = `off: ${e.message}`;
      this.log(`speech understanding ${this.status}`);
    });
  }

  private load(sherpa: unknown, model: string): void {
    try {
      const S = sherpa as { OfflineRecognizer: new (cfg: unknown) => Recognizer };
      this.rec = new S.OfflineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          moonshine: {
            preprocessor: path.join(model, 'preprocess.onnx'),
            encoder: path.join(model, 'encode.int8.onnx'),
            uncachedDecoder: path.join(model, 'uncached_decode.int8.onnx'),
            cachedDecoder: path.join(model, 'cached_decode.int8.onnx'),
          },
          tokens: path.join(model, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
          debug: 0,
        },
      });
      this.status = 'on (Moonshine, on this computer)';
      this.log(`speech understanding ${this.status}`);
      this.onReady();
    } catch (e) {
      this.status = `off: the speech model did not load (${(e as Error).message})`;
      this.log(`speech understanding ${this.status}`);
    }
  }

  /** 16 kHz mono samples to text. */
  transcribe(samples: Float32Array): string {
    if (!this.rec) return '';
    const s = this.rec.createStream();
    s.acceptWaveform({ sampleRate: 16000, samples });
    this.rec.decode(s);
    return this.rec.getResult(s).text.trim();
  }
}

export function pcm16ToFloat(b64: string): Float32Array {
  const buf = Buffer.from(b64, 'base64');
  const n = Math.floor(buf.length / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768;
  return out;
}
