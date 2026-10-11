import { getFFT } from '../dsp/fft';

/**
 * YAMNet (Google, trained on AudioSet: 2 million YouTube clips, 521 sound
 * classes) running in plain TypeScript, so it works in any browser worker
 * with no ML runtime. Weights come from the published int8 TFLite model and
 * are dequantised per channel on load; the output matches the TFLite model to
 * within a few percent (see test/yamnet.test.ts).
 *
 * Input: 15600 samples (0.975 s) of 16 kHz mono audio in [-1, 1].
 * Output: 521 class probabilities.
 */

interface TensorMeta {
  name: string;
  dtype: 'float32' | 'int8' | 'int32';
  shape: number[];
  offset: number;
}

interface Layer {
  op: 'CONV_2D' | 'DEPTHWISE_CONV_2D' | 'FULLY_CONNECTED';
  out: number[];
  w: Float32Array;
  b: Float32Array;
  shape: number[];
}

export const YAMNET_SAMPLES = 15600;
export const YAMNET_RATE = 16000;

export class Yamnet {
  private window!: Float32Array;
  private mel!: Float32Array;
  private melb!: Float32Array;
  private frames!: Int32Array;
  private layers: Layer[] = [];
  private fft = getFFT(512);
  private re = new Float64Array(512);
  private im = new Float64Array(512);

  static fromBuffer(buf: ArrayBuffer): Yamnet {
    const y = new Yamnet();
    const dv = new DataView(buf);
    const hlen = dv.getUint32(0, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 4, hlen))) as {
      layers: { op: Layer['op']; out: number[] }[];
      tensors: TensorMeta[];
    };
    const base = 4 + hlen;
    const t = new Map<string, TensorMeta>(header.tensors.map((m) => [m.name, m]));
    const count = (m: TensorMeta) => m.shape.reduce((a, b) => a * b, 1);
    const f32 = (n: string) => new Float32Array(buf, base + t.get(n)!.offset, count(t.get(n)!));
    y.window = f32('window');
    y.mel = f32('mel');
    y.melb = f32('melb');
    y.frames = new Int32Array(buf, base + t.get('frames')!.offset, count(t.get('frames')!));
    header.layers.forEach((l, k) => {
      const wm = t.get(`w${k}`)!;
      const q = new Int8Array(buf, base + wm.offset, count(wm));
      const s = f32(`s${k}`);
      const w = new Float32Array(q.length);
      if (l.op === 'DEPTHWISE_CONV_2D') {
        const C = wm.shape[2];
        for (let i = 0; i < q.length; i++) w[i] = q[i] * s[i % C];
      } else {
        const per = q.length / s.length;
        for (let i = 0; i < q.length; i++) w[i] = q[i] * s[Math.floor(i / per)];
      }
      y.layers.push({ op: l.op, out: l.out, w, b: Float32Array.from(f32(`b${k}`)), shape: wm.shape });
    });
    return y;
  }

  /** Log mel patch [96 frames x 64 bands], as YAMNet's own front end computes it. */
  logMel(wav: Float32Array): Float32Array {
    const out = new Float32Array(96 * 64);
    const mag = new Float32Array(257);
    for (let f = 0; f < 96; f++) {
      this.re.fill(0);
      this.im.fill(0);
      for (let k = 0; k < 5; k++) {
        const row = this.frames[f * 5 + k];
        for (let j = 0; j < 80; j++) this.re[k * 80 + j] = wav[row * 80 + j] * this.window[k * 80 + j];
      }
      this.fft.forward(this.re, this.im);
      for (let b = 0; b < 257; b++) mag[b] = Math.hypot(this.re[b], this.im[b]);
      for (let m = 0; m < 64; m++) {
        let acc = this.melb[m];
        const row = m * 257;
        for (let b = 0; b < 257; b++) acc += mag[b] * this.mel[row + b];
        out[f * 64 + m] = Math.log(acc);
      }
    }
    return out;
  }

  run(wav: Float32Array): Float32Array {
    let H = 96;
    let W = 64;
    let C = 1;
    let x = this.logMel(wav);
    for (const l of this.layers) {
      if (l.op === 'FULLY_CONNECTED') {
        const v = new Float32Array(C);
        const n = H * W;
        for (let p = 0; p < n; p++) for (let c = 0; c < C; c++) v[c] += x[p * C + c];
        for (let c = 0; c < C; c++) v[c] /= n;
        const K = l.b.length;
        const out = new Float32Array(K);
        for (let k = 0; k < K; k++) {
          let acc = l.b[k];
          const row = k * C;
          for (let c = 0; c < C; c++) acc += l.w[row + c] * v[c];
          out[k] = 1 / (1 + Math.exp(-acc));
        }
        return out;
      }
      const oh = l.out[1];
      const ow = l.out[2];
      const stride = oh < H ? 2 : 1;
      if (l.op === 'CONV_2D') {
        const [Co, kh, kw, Ci] = l.shape;
        x = kh === 1 ? pointwise(x, H * W, Ci, l.w, l.b, Co) : conv3(x, H, W, Ci, l.w, l.b, Co, kh, kw, stride, oh, ow);
        C = Co;
      } else {
        x = depthwise(x, H, W, C, l.w, l.b, stride, oh, ow);
      }
      H = oh;
      W = ow;
    }
    throw new Error('YAMNet: missing classifier layer');
  }
}

function relu6(v: number): number {
  return v < 0 ? 0 : v > 6 ? 6 : v;
}

/** TensorFlow SAME padding offsets. */
function padStart(inSize: number, outSize: number, k: number, s: number): number {
  const total = Math.max((outSize - 1) * s + k - inSize, 0);
  return Math.floor(total / 2);
}

function conv3(x: Float32Array, H: number, W: number, Ci: number, w: Float32Array, b: Float32Array, Co: number, kh: number, kw: number, s: number, oh: number, ow: number): Float32Array {
  const out = new Float32Array(oh * ow * Co);
  const ph = padStart(H, oh, kh, s);
  const pw = padStart(W, ow, kw, s);
  for (let i = 0; i < oh; i++) {
    for (let j = 0; j < ow; j++) {
      const o = (i * ow + j) * Co;
      for (let co = 0; co < Co; co++) {
        let acc = b[co];
        for (let a = 0; a < kh; a++) {
          const y = i * s + a - ph;
          if (y < 0 || y >= H) continue;
          for (let c = 0; c < kw; c++) {
            const xx = j * s + c - pw;
            if (xx < 0 || xx >= W) continue;
            const xi = (y * W + xx) * Ci;
            const wi = ((co * kh + a) * kw + c) * Ci;
            for (let ci = 0; ci < Ci; ci++) acc += x[xi + ci] * w[wi + ci];
          }
        }
        out[o + co] = relu6(acc);
      }
    }
  }
  return out;
}

function depthwise(x: Float32Array, H: number, W: number, C: number, w: Float32Array, b: Float32Array, s: number, oh: number, ow: number): Float32Array {
  const out = new Float32Array(oh * ow * C);
  const ph = padStart(H, oh, 3, s);
  const pw = padStart(W, ow, 3, s);
  for (let i = 0; i < oh; i++) {
    for (let j = 0; j < ow; j++) {
      const o = (i * ow + j) * C;
      for (let c = 0; c < C; c++) out[o + c] = b[c];
      for (let a = 0; a < 3; a++) {
        const y = i * s + a - ph;
        if (y < 0 || y >= H) continue;
        for (let d = 0; d < 3; d++) {
          const xx = j * s + d - pw;
          if (xx < 0 || xx >= W) continue;
          const xi = (y * W + xx) * C;
          const wi = (a * 3 + d) * C;
          for (let c = 0; c < C; c++) out[o + c] += x[xi + c] * w[wi + c];
        }
      }
      for (let c = 0; c < C; c++) out[o + c] = relu6(out[o + c]);
    }
  }
  return out;
}

function pointwise(x: Float32Array, P: number, Ci: number, w: Float32Array, b: Float32Array, Co: number): Float32Array {
  const out = new Float32Array(P * Co);
  for (let p = 0; p < P; p++) {
    const xi = p * Ci;
    const o = p * Co;
    for (let co = 0; co < Co; co++) {
      let acc = b[co];
      const wi = co * Ci;
      for (let ci = 0; ci < Ci; ci++) acc += x[xi + ci] * w[wi + ci];
      out[o + co] = relu6(acc);
    }
  }
  return out;
}
