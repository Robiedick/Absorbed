// public/js/game/audio.js — Procedural audio using Web Audio API
export class AudioManager {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this._init();
  }

  _init() {
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch { this.enabled = false; }
  }

  _resume() {
    if (this.ctx?.state === 'suspended') this.ctx.resume();
  }

  _tone(freq, type = 'sine', duration = 0.15, vol = 0.18, delay = 0) {
    if (!this.enabled || !this.ctx) return;
    this._resume();
    const osc  = this.ctx.createOscillator();
    const gain = this.ctx.createGain();
    osc.connect(gain);
    gain.connect(this.ctx.destination);
    osc.type      = type;
    osc.frequency.setValueAtTime(freq, this.ctx.currentTime + delay);
    gain.gain.setValueAtTime(0, this.ctx.currentTime + delay);
    gain.gain.linearRampToValueAtTime(vol, this.ctx.currentTime + delay + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, this.ctx.currentTime + delay + duration);
    osc.start(this.ctx.currentTime + delay);
    osc.stop(this.ctx.currentTime + delay + duration + 0.05);
  }

  click()  { this._tone(440, 'sine', 0.08, 0.12); }
  build()  {
    [261, 329, 392, 523].forEach((f, i) => this._tone(f, 'triangle', 0.15, 0.15, i * 0.1));
  }
  upgrade(){ [523, 659, 784].forEach((f, i) => this._tone(f, 'sine', 0.2, 0.2, i * 0.12)); }
  error()  { this._tone(180, 'sawtooth', 0.25, 0.15); }
  battle() {
    for (let i = 0; i < 6; i++) {
      const f = 80 + Math.random() * 120;
      this._tone(f, 'square', 0.1, 0.3, i * 0.07);
    }
  }
  victory()  {
    [523, 659, 784, 1047].forEach((f, i) => this._tone(f, 'triangle', 0.3, 0.2, i * 0.15));
  }
  defeat()   { [300, 250, 200].forEach((f, i) => this._tone(f, 'sawtooth', 0.3, 0.2, i * 0.2)); }
  notify()   { this._tone(880, 'sine', 0.1, 0.1); setTimeout(() => this._tone(1100, 'sine', 0.1, 0.1), 120); }
}
