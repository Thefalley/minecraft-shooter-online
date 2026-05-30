const MIN_GAIN = 0.0001;

export class GameAudio {
  constructor(options = {}) {
    const AudioContextClass = globalThis.AudioContext ?? globalThis.webkitAudioContext ?? null;
    this.AudioContextClass = AudioContextClass;
    this.ctx = null;
    this.master = null;
    this.noiseBuffer = null;
    this.supported = Boolean(AudioContextClass);
    this.volume = options.volume ?? 0.65;
  }

  unlock() {
    const ctx = this._ensureContext();
    if (!ctx) return Promise.resolve(false);

    if (ctx.state === 'suspended') {
      return ctx.resume().then(() => true).catch(() => false);
    }

    return Promise.resolve(true);
  }

  shoot(kind = 'rifle') {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const name = String(kind).toLowerCase();
    if (name.includes('shotgun')) return this._shotgun(ctx);
    if (name.includes('blaster')) return this._blaster(ctx);
    return this._rifle(ctx);
  }

  reload() {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    this._click(now, 0.018, 1450, 0.16);
    this._click(now + 0.16, 0.024, 850, 0.2);
    this._click(now + 0.38, 0.03, 1250, 0.18);
    this._tone({
      type: 'triangle',
      start: now + 0.52,
      duration: 0.08,
      frequency: 260,
      endFrequency: 210,
      gain: 0.08,
    });
    return true;
  }

  roar() {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    this._tone({
      type: 'sawtooth',
      start: now,
      duration: 1.35,
      frequency: 92,
      endFrequency: 54,
      gain: 0.34,
      attack: 0.16,
      release: 0.42,
      filterType: 'lowpass',
      filterFrequency: 580,
      filterEndFrequency: 190,
    });
    this._tone({
      type: 'square',
      start: now + 0.05,
      duration: 1.1,
      frequency: 47,
      endFrequency: 38,
      gain: 0.16,
      attack: 0.12,
      release: 0.35,
      filterType: 'lowpass',
      filterFrequency: 240,
    });
    this._noise({
      start: now,
      duration: 1.15,
      gain: 0.22,
      attack: 0.12,
      release: 0.35,
      filterType: 'bandpass',
      filterFrequency: 430,
      filterQ: 0.65,
    });
    return true;
  }

  explosion() {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    this._noise({
      start: now,
      duration: 0.78,
      gain: 0.55,
      attack: 0.004,
      release: 0.62,
      filterType: 'lowpass',
      filterFrequency: 1500,
      filterEndFrequency: 90,
      filterQ: 0.7,
    });
    this._tone({
      type: 'sine',
      start: now,
      duration: 0.72,
      frequency: 72,
      endFrequency: 31,
      gain: 0.42,
      attack: 0.002,
      release: 0.5,
    });
    this._tone({
      type: 'triangle',
      start: now + 0.015,
      duration: 0.18,
      frequency: 34,
      gain: 0.28,
      attack: 0.001,
      release: 0.12,
    });
    return true;
  }

  pickup() {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    this._tone({ type: 'sine', start: now, duration: 0.11, frequency: 660, endFrequency: 880, gain: 0.13 });
    this._tone({ type: 'triangle', start: now + 0.09, duration: 0.16, frequency: 990, endFrequency: 1320, gain: 0.11 });
    return true;
  }

  damage() {
    const ctx = this._ensureRunningContext();
    if (!ctx) return false;

    const now = ctx.currentTime;
    this._tone({
      type: 'sawtooth',
      start: now,
      duration: 0.28,
      frequency: 190,
      endFrequency: 82,
      gain: 0.18,
      attack: 0.002,
      release: 0.18,
      filterType: 'bandpass',
      filterFrequency: 720,
      filterQ: 2.6,
    });
    this._noise({
      start: now,
      duration: 0.18,
      gain: 0.16,
      attack: 0.001,
      release: 0.12,
      filterType: 'highpass',
      filterFrequency: 900,
    });
    return true;
  }

  _rifle(ctx) {
    const now = ctx.currentTime;
    this._noise({
      start: now,
      duration: 0.08,
      gain: 0.16,
      attack: 0.001,
      release: 0.055,
      filterType: 'highpass',
      filterFrequency: 1700,
    });
    this._tone({
      type: 'square',
      start: now,
      duration: 0.075,
      frequency: 155,
      endFrequency: 78,
      gain: 0.22,
      attack: 0.001,
      release: 0.045,
    });
    return true;
  }

  _shotgun(ctx) {
    const now = ctx.currentTime;
    this._noise({
      start: now,
      duration: 0.24,
      gain: 0.32,
      attack: 0.002,
      release: 0.18,
      filterType: 'lowpass',
      filterFrequency: 2100,
      filterEndFrequency: 450,
    });
    this._tone({
      type: 'triangle',
      start: now,
      duration: 0.18,
      frequency: 120,
      endFrequency: 48,
      gain: 0.25,
      attack: 0.001,
      release: 0.12,
    });
    return true;
  }

  _blaster(ctx) {
    const now = ctx.currentTime;
    this._tone({
      type: 'sawtooth',
      start: now,
      duration: 0.16,
      frequency: 760,
      endFrequency: 1180,
      gain: 0.17,
      attack: 0.002,
      release: 0.08,
      filterType: 'bandpass',
      filterFrequency: 1400,
      filterQ: 3.5,
    });
    this._tone({
      type: 'sine',
      start: now,
      duration: 0.2,
      frequency: 180,
      endFrequency: 95,
      gain: 0.12,
      attack: 0.001,
      release: 0.1,
    });
    return true;
  }

  _ensureContext() {
    if (!this.supported) return null;
    if (this.ctx) return this.ctx;

    try {
      this.ctx = new this.AudioContextClass();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;

      const compressor = this.ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 18;
      compressor.ratio.value = 8;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.18;

      this.master.connect(compressor);
      compressor.connect(this.ctx.destination);
      return this.ctx;
    } catch {
      this.supported = false;
      this.ctx = null;
      this.master = null;
      return null;
    }
  }

  _ensureRunningContext() {
    const ctx = this._ensureContext();
    if (!ctx) return null;

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }

    return ctx;
  }

  _tone({
    type,
    start,
    duration,
    frequency,
    endFrequency = frequency,
    gain,
    attack = 0.006,
    release = 0.06,
    filterType = null,
    filterFrequency = 1200,
    filterEndFrequency = filterFrequency,
    filterQ = 1,
  }) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const oscillator = ctx.createOscillator();
    const envelope = ctx.createGain();
    const output = filterType ? ctx.createBiquadFilter() : envelope;
    const stopAt = start + duration;

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, start);
    oscillator.frequency.exponentialRampToValueAtTime(Math.max(MIN_GAIN, endFrequency), stopAt);

    envelope.gain.setValueAtTime(MIN_GAIN, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, gain), start + attack);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, Math.max(start + attack, stopAt - release));

    oscillator.connect(envelope);

    if (filterType) {
      output.type = filterType;
      output.Q.value = filterQ;
      output.frequency.setValueAtTime(filterFrequency, start);
      output.frequency.exponentialRampToValueAtTime(Math.max(MIN_GAIN, filterEndFrequency), stopAt);
      envelope.connect(output);
    }

    output.connect(this.master);
    oscillator.start(start);
    oscillator.stop(stopAt + 0.03);
    oscillator.addEventListener('ended', () => output.disconnect());
  }

  _noise({
    start,
    duration,
    gain,
    attack = 0.005,
    release = 0.08,
    filterType = 'lowpass',
    filterFrequency = 1200,
    filterEndFrequency = filterFrequency,
    filterQ = 1,
  }) {
    const ctx = this.ctx;
    if (!ctx || !this.master) return;

    const source = ctx.createBufferSource();
    const envelope = ctx.createGain();
    const filter = ctx.createBiquadFilter();
    const stopAt = start + duration;

    source.buffer = this._getNoiseBuffer(ctx);
    filter.type = filterType;
    filter.Q.value = filterQ;
    filter.frequency.setValueAtTime(filterFrequency, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(MIN_GAIN, filterEndFrequency), stopAt);

    envelope.gain.setValueAtTime(MIN_GAIN, start);
    envelope.gain.exponentialRampToValueAtTime(Math.max(MIN_GAIN, gain), start + attack);
    envelope.gain.exponentialRampToValueAtTime(MIN_GAIN, Math.max(start + attack, stopAt - release));

    source.connect(filter);
    filter.connect(envelope);
    envelope.connect(this.master);
    source.start(start);
    source.stop(stopAt + 0.03);
    source.addEventListener('ended', () => filter.disconnect());
  }

  _click(start, duration, frequency, gain) {
    this._tone({
      type: 'square',
      start,
      duration,
      frequency,
      endFrequency: frequency * 0.72,
      gain,
      attack: 0.001,
      release: duration * 0.5,
      filterType: 'bandpass',
      filterFrequency: frequency,
      filterQ: 5,
    });
  }

  _getNoiseBuffer(ctx) {
    if (this.noiseBuffer) return this.noiseBuffer;

    const length = ctx.sampleRate * 2;
    const buffer = ctx.createBuffer(1, length, ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index += 1) {
      data[index] = Math.random() * 2 - 1;
    }

    this.noiseBuffer = buffer;
    return buffer;
  }
}

export default GameAudio;
