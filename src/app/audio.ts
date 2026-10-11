/**
 * Browser audio I/O for the sonar: plays the looped ultrasonic waveform through
 * the loudspeaker and streams raw microphone samples, with every voice-call
 * processing stage (echo cancellation, noise suppression, automatic gain)
 * switched off, because those stages are built to erase exactly the signal
 * the sonar listens for.
 */
export interface AudioStartResult {
  fs: number;
  echoCancellation: boolean | null;
  noiseSuppression: boolean | null;
  autoGainControl: boolean | null;
  deviceLabel: string;
  worklet: boolean;
}

type WebkitWindow = Window & { webkitAudioContext?: typeof AudioContext };

export class AudioIO {
  ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private txSource: AudioBufferSourceNode | null = null;
  private txGain: GainNode | null = null;
  private sink: GainNode | null = null;
  private level = 0.5;
  private requested = 0;
  onAudio: (block: Float32Array) => void = () => {};

  /** Must be called from a user gesture (tap). */
  createContext(): AudioContext {
    const w = window as WebkitWindow;
    const Ctor = window.AudioContext ?? w.webkitAudioContext!;
    try {
      this.ctx = new Ctor({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch {
      this.ctx = new Ctor();
    }
    // Safari 16.4+: ask for a play-and-record session up front.
    try {
      const nav = navigator as Navigator & { audioSession?: { type: string } };
      if (nav.audioSession) nav.audioSession.type = 'play-and-record';
    } catch {
      /* not supported */
    }
    void this.ctx.resume();
    return this.ctx;
  }

  async start(): Promise<AudioStartResult> {
    const ctx = this.ctx ?? this.createContext();
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
        sampleRate: ctx.sampleRate,
      } as MediaTrackConstraints,
      video: false,
    });
    await ctx.resume();
    const track = this.stream.getAudioTracks()[0];
    const settings = (track.getSettings?.() ?? {}) as MediaTrackSettings;
    const src = ctx.createMediaStreamSource(this.stream);
    this.sink = ctx.createGain();
    this.sink.gain.value = 0;
    this.sink.connect(ctx.destination);

    let worklet = false;
    if (ctx.audioWorklet) {
      try {
        await ctx.audioWorklet.addModule('dist/capture-worklet.js');
        const node = new AudioWorkletNode(ctx, 'echosense-capture', {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          channelCount: 1,
          channelCountMode: 'explicit',
        });
        node.port.onmessage = (e: MessageEvent<Float32Array>) => this.onAudio(e.data);
        src.connect(node);
        node.connect(this.sink);
        worklet = true;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back', err);
      }
    }
    if (!worklet) {
      const sp = ctx.createScriptProcessor(1024, 1, 1);
      sp.onaudioprocess = (e) => this.onAudio(new Float32Array(e.inputBuffer.getChannelData(0)));
      src.connect(sp);
      sp.connect(this.sink);
    }
    return {
      fs: ctx.sampleRate,
      echoCancellation: typeof settings.echoCancellation === 'boolean' ? settings.echoCancellation : null,
      noiseSuppression: typeof settings.noiseSuppression === 'boolean' ? settings.noiseSuppression : null,
      autoGainControl: typeof settings.autoGainControl === 'boolean' ? settings.autoGainControl : null,
      deviceLabel: track.label || 'Microphone',
      worklet,
    };
  }

  /** Install the transmit waveform (one period) and start looping it, muted. */
  setTxPeriod(period: Float32Array): void {
    const ctx = this.ctx;
    if (!ctx) return;
    this.txSource?.stop();
    this.txSource?.disconnect();
    // Tile several periods so the loop seam is rare (it is seamless anyway).
    const reps = 16;
    const buf = ctx.createBuffer(1, period.length * reps, ctx.sampleRate);
    const ch = buf.getChannelData(0);
    for (let r = 0; r < reps; r++) ch.set(period, r * period.length);
    this.txSource = ctx.createBufferSource();
    this.txSource.buffer = buf;
    this.txSource.loop = true;
    if (!this.txGain) {
      this.txGain = ctx.createGain();
      this.txGain.gain.value = 0;
      this.txGain.connect(ctx.destination);
    }
    this.txSource.connect(this.txGain);
    this.txSource.start();
    this.applyGain();
  }

  /** Requested on/off from the engine (0 while measuring ambient noise). */
  setTxEnabled(on: number): void {
    this.requested = on;
    this.applyGain();
  }

  /** Output level, 0..1 of full scale. */
  setLevel(level: number): void {
    this.level = Math.max(0, Math.min(1, level));
    this.applyGain();
  }

  private applyGain(): void {
    if (!this.ctx || !this.txGain) return;
    const g = this.txGain.gain;
    const now = this.ctx.currentTime;
    g.cancelScheduledValues(now);
    g.setValueAtTime(g.value, now);
    // Smooth ramps keep the speaker from clicking.
    g.setTargetAtTime(this.requested * this.level, now, 0.05);
  }

  stop(): void {
    this.txSource?.stop();
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.ctx = null;
  }
}
