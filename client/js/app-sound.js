/* eslint-disable no-undef */
// Tiny WebAudio sound effects. No audio files — everything is synthesized so
// the PWA stays fully self-contained and the latency is zero.
//
// iOS Safari requires the FIRST AudioContext.resume() to happen synchronously
// inside a user gesture handler; we do that in unlock().
window.LESSERPAY_SOUND = (function () {
  const STORAGE_KEY = 'lesserpay_muted';

  let ctx = null;
  let masterGain = null;
  let unlocked = false;
  let muted = readMuted();

  function readMuted() {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1';
    } catch (_) {
      return false;
    }
  }

  function writeMuted(value) {
    try {
      localStorage.setItem(STORAGE_KEY, value ? '1' : '0');
    } catch (_) { /* ignore */ }
  }

  function ensureCtx() {
    if (ctx) return ctx;
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
    masterGain = ctx.createGain();
    masterGain.gain.value = 0.35;
    masterGain.connect(ctx.destination);
    return ctx;
  }

  // Must be called from inside a user-gesture handler (e.g. click) the first
  // time, otherwise iOS keeps the context suspended forever.
  function unlock() {
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') c.resume().catch(() => {});
    if (!unlocked) {
      // A 1-sample silent buffer gets iOS over the line on some versions.
      try {
        const buf = c.createBuffer(1, 1, 22050);
        const src = c.createBufferSource();
        src.buffer = buf;
        src.connect(c.destination);
        src.start(0);
      } catch (_) { /* ignore */ }
      unlocked = true;
    }
  }

  function isMuted() { return muted; }

  function setMuted(value) {
    muted = !!value;
    writeMuted(muted);
  }

  function toggleMuted() {
    setMuted(!muted);
    return muted;
  }

  // Single oscillator beep with an exponential gain envelope.
  function beep(opts) {
    if (muted) return;
    const c = ensureCtx();
    if (!c || c.state === 'suspended') return;
    const o = c.createOscillator();
    const g = c.createGain();
    const now = c.currentTime;
    const start = now + (opts.delay || 0);
    const dur = opts.duration || 0.18;
    o.type = opts.type || 'sine';
    o.frequency.setValueAtTime(opts.from || 440, start);
    if (opts.to && opts.to !== opts.from) {
      o.frequency.exponentialRampToValueAtTime(opts.to, start + dur);
    }
    const peak = opts.gain != null ? opts.gain : 0.6;
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(peak, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g);
    g.connect(masterGain);
    o.start(start);
    o.stop(start + dur + 0.02);
  }

  // Built-in palette. Each entry is one or more layered beeps.
  function play(name) {
    if (muted) return;
    const c = ensureCtx();
    if (!c) return;
    if (c.state === 'suspended') {
      // Best-effort resume — only works if we're still inside a gesture.
      c.resume().catch(() => {});
    }
    const palette = {
      tap:     [{ type: 'sine',   from: 660, duration: 0.06, gain: 0.25 }],
      toggle:  [{ type: 'square', from: 520, to: 880, duration: 0.10, gain: 0.20 }],
      apply:   [
        { type: 'triangle', from: 660, to: 990, duration: 0.12, gain: 0.30 },
        { type: 'triangle', from: 990, to: 1320, duration: 0.10, gain: 0.25, delay: 0.10 },
      ],
      approve: [
        { type: 'sine', from: 880,  to: 1175, duration: 0.10, gain: 0.30 },
        { type: 'sine', from: 1175, to: 1568, duration: 0.10, gain: 0.30, delay: 0.10 },
        { type: 'sine', from: 1568, to: 2093, duration: 0.16, gain: 0.30, delay: 0.20 },
      ],
      reject:  [
        { type: 'square', from: 330, to: 220, duration: 0.18, gain: 0.20 },
      ],
      cashout: [
        { type: 'triangle', from: 1318, to: 1318, duration: 0.06, gain: 0.30 },
        { type: 'triangle', from: 1568, to: 1568, duration: 0.06, gain: 0.30, delay: 0.06 },
        { type: 'triangle', from: 2093, to: 2093, duration: 0.18, gain: 0.30, delay: 0.12 },
      ],
      error:   [
        { type: 'sawtooth', from: 220, to: 165, duration: 0.20, gain: 0.20 },
      ],
    };
    const seq = palette[name] || palette.tap;
    seq.forEach(beep);
  }

  return { unlock, play, isMuted, setMuted, toggleMuted };
})();
