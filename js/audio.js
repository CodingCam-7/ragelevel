'use strict';

/* Tiny square-wave synth. No assets, no loading, appropriately crunchy. */

const Sfx = {
  ctx: null,
  master: null,
  muted: false,

  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); } catch (e) { return; }
      // Everything routes through one gain node so the volume setting is a
      // single value to change, rather than a multiplier threaded through
      // every call site.
      this.master = this.ctx.createGain();
      this.master.gain.value = Options.volume;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  },

  /** Where every voice connects. Falls back to the raw output pre-unlock. */
  out() {
    return this.master || (this.ctx && this.ctx.destination);
  },

  setVolume(v) {
    Options.volume = clamp(v, 0, 1);
    if (this.master) this.master.gain.value = Options.volume;
    return Options.volume;
  },

  toggleMute() {
    this.muted = !this.muted;
    return this.muted;
  },

  /**
   * @param freq  starting frequency
   * @param dur   seconds
   * @param type  oscillator type
   * @param vol   peak gain
   * @param to    frequency to glide to (defaults to freq)
   */
  tone(freq, dur, type, vol, to) {
    if (this.muted || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const osc = c.createOscillator();
    const gain = c.createGain();

    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t);
    if (to && to !== freq) osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t + dur);

    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(vol || 0.05, t + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + dur);

    osc.connect(gain).connect(this.out());
    osc.start(t);
    osc.stop(t + dur + 0.02);
  },

  noise(dur, vol) {
    if (this.muted || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    }
    const src = c.createBufferSource();
    const gain = c.createGain();
    src.buffer = buf;
    gain.gain.value = vol || 0.06;
    src.connect(gain).connect(this.out());
    src.start(t);
  },

  /** Low-passed noise: a thud with weight, rather than a hiss of sand. */
  thud(dur, vol, cutoff) {
    if (this.muted || !this.ctx) return;
    const c = this.ctx;
    const t = c.currentTime;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      const k = 1 - i / len;
      data[i] = (Math.random() * 2 - 1) * k * k;   // sharp decay
    }
    const src = c.createBufferSource();
    const lp = c.createBiquadFilter();
    const gain = c.createGain();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(cutoff || 200, t);
    gain.gain.value = vol || 0.09;
    src.buffer = buf;
    src.connect(lp).connect(gain).connect(this.out());
    src.start(t);
  },

  jump()    { this.tone(320, 0.10, 'square', 0.045, 620); },
  land()    { this.tone(160, 0.05, 'square', 0.025, 110); },
  bonk()    { this.tone(120, 0.07, 'square', 0.04, 70); },
  trap()    { this.tone(180, 0.14, 'sawtooth', 0.05, 60); this.noise(0.12, 0.05); },
  spike()   { this.tone(700, 0.08, 'square', 0.035, 240); },
  crumble() { this.noise(0.16, 0.05); },
  // A heavy thing hitting the ground once: sub-bass drop + filtered impact.
  slam() {
    this.tone(80, 0.36, 'sine', 0.17, 24);       // the weight you feel
    this.tone(150, 0.14, 'square', 0.04, 46);    // body, so it cuts through
    this.thud(0.24, 0.11, 170);                  // the impact itself
  },
  teleport(){ this.tone(500, 0.13, 'triangle', 0.05, 1400); },
  laugh()   { this.tone(420, 0.07, 'square', 0.04, 300);
              setTimeout(() => this.tone(360, 0.07, 'square', 0.04, 260), 90);
              setTimeout(() => this.tone(300, 0.10, 'square', 0.04, 200), 180); },

  death() {
    this.tone(300, 0.32, 'sawtooth', 0.06, 50);
    this.noise(0.22, 0.06);
  },

  win() {
    const notes = [523, 659, 784, 1047];
    notes.forEach((f, i) => setTimeout(() => this.tone(f, 0.13, 'square', 0.05), i * 80));
  },

  fanfare() {
    const notes = [523, 659, 784, 1047, 784, 1047, 1319];
    notes.forEach((f, i) => setTimeout(() => this.tone(f, 0.18, 'square', 0.055), i * 110));
  }
};
