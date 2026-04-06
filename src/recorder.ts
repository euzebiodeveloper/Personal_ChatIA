// VAD thresholds
const THRESHOLD_RMS = 0.030; // RMS level to consider as voice (higher = ignores quieter background)
const SILENCE_MS    = 1200;  // ms of silence before finalising a speech clip
const MIN_SPEECH_MS = 600;   // clips shorter than this are discarded (filters accidental triggers)

export class VadRecorder {
  private stream: MediaStream | null = null;
  private audioCtx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private _enabled   = false;
  private speaking   = false;
  private speechStart = 0;
  private silenceTimer: ReturnType<typeof setTimeout> | null = null;
  private pollId: ReturnType<typeof setInterval> | null = null;

  private speechCb: ((blob: Blob) => void) | null = null;
  private errorCb:  ((err: Error)  => void) | null = null;

  onSpeech(cb: (blob: Blob) => void): this { this.speechCb = cb; return this; }
  onError (cb: (err: Error)  => void): this { this.errorCb  = cb; return this; }

  get isEnabled(): boolean { return this._enabled; }

  async enable(): Promise<void> {
    if (this._enabled) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
    audio: { sampleRate: 16000, channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.audioCtx = new AudioContext({ sampleRate: 16000 });
    const source = this.audioCtx.createMediaStreamSource(this.stream);
    this.analyser = this.audioCtx.createAnalyser();
    this.analyser.fftSize = 512;
    source.connect(this.analyser);
    this._enabled = true;
    this.pollId = setInterval(() => this._tick(), 50);
  }

  disable(): void {
    if (!this._enabled) return;
    this._enabled = false;
    if (this.pollId)     { clearInterval(this.pollId);     this.pollId     = null; }
    if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream   = null;
    this.audioCtx?.close();
    this.audioCtx = null;
    this.speaking = false;
    this.chunks   = [];
  }

  private _tick(): void {
    if (!this.analyser || !this._enabled) return;
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    const rms = Math.sqrt(sum / buf.length);

    if (!this.speaking && rms > THRESHOLD_RMS) {
      this._startSpeech();
    } else if (this.speaking) {
      if (rms >= THRESHOLD_RMS) {
        // still talking — cancel any pending silence timer
        if (this.silenceTimer) { clearTimeout(this.silenceTimer); this.silenceTimer = null; }
      } else if (!this.silenceTimer) {
        // went quiet — start silence countdown
        this.silenceTimer = setTimeout(() => this._endSpeech(), SILENCE_MS);
      }
    }
  }

  private _startSpeech(): void {
    if (!this.stream) return;
    this.speaking    = true;
    this.speechStart = Date.now();
    this.chunks      = [];
    this.mediaRecorder = new MediaRecorder(this.stream, { mimeType: 'audio/webm;codecs=opus' });
    this.mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.mediaRecorder.start(200);
  }

  private _endSpeech(): void {
    this.silenceTimer = null;
    this.speaking     = false;
    const duration    = Date.now() - this.speechStart;
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;

    this.mediaRecorder.onstop = () => {
      if (duration < MIN_SPEECH_MS) return; // too short — ignore
      const blob = new Blob(this.chunks, { type: 'audio/webm' });
      this.chunks = [];
      if (blob.size >= 1000) this.speechCb?.(blob);
    };
    this.mediaRecorder.stop();
  }
}

