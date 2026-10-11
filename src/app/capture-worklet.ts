/// <reference lib="webworker" />
// AudioWorklet processor: collects microphone samples into fixed blocks and
// posts them to the main thread (which forwards them to the engine worker).

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: unknown): void;
declare class AudioWorkletProcessor {
  readonly port: MessagePort;
  constructor();
}

const BLOCK = 1024;

class CaptureProcessor extends AudioWorkletProcessor {
  private buf = new Float32Array(BLOCK);
  private fill = 0;

  process(inputs: Float32Array[][]): boolean {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(BLOCK - this.fill, ch.length - i);
      this.buf.set(ch.subarray(i, i + take), this.fill);
      this.fill += take;
      i += take;
      if (this.fill === BLOCK) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Float32Array(BLOCK);
        this.fill = 0;
      }
    }
    return true;
  }
}

registerProcessor('echosense-capture', CaptureProcessor);
export {};
void sampleRate;
