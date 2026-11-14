// Sound: a base track you can leave on under the canvas (♪), a focus track
// that takes over during a pomodoro, and one soft chime when a pomodoro ends.
// The tracks are files or URLs from config.js `music`; when none is set
// they are made right here: brown noise for base, and for focus a soft pad
// with a gentle 16 Hz wobble (issue #9, after Woods et al. 2024). Browsers
// only allow sound after a click, so nothing plays until the first one.
//
// The default pomodoro goes noise -> pad -> noise: the base noise carries on
// unchanged and only eases down as the pad comes in, and the pad hands back
// to it before the end. A second, different noise would be heard as the
// noise changing character.

export const SOUND_DEFAULTS = {
  base: 0.15, // base noise volume
  focus: 0.35, // pad volume during a pomodoro
  chime: 0.35, // end-of-pomodoro chime; 0 = silent
  colour: 0, // noise: 0 brown, 1 pink, 2 white
  baseTone: 800, // noise low-pass, Hz
  padTone: 1600, // the pad's low-pass once it is in, Hz
  rate: 16, // pad wobble, Hz
  depth: 0.2, // how far the wobble dips the pad
  padIn: 60, // s for the pad to come in
  padOut: 60, // s before the end that it hands back to noise
};

// What plays during a pomodoro; the sliders tune each of them.
export const SOUND_MODES = [
  ["journey", "noise → pad", "The noise carries on; a pad comes in, and hands back to the noise before the end."],
  ["pad", "pad", "The pad comes in and stays, over the noise."],
  ["noise", "noise", "Just the base noise, no pad."],
  ["silence", "silence", "Nothing during a pomodoro. Noise can hurt focus for people without ADHD."],
];

const FADE_S = 2;
const COLOURS = ["brown", "pink", "white"];
// Noise loops of lengths that never line up, layered: the mix doesn't
// repeat for hours, so the ear finds no cycle to lock on to.
const LAYERS_S = [7.3, 11.9, 17.1];
// The wobble only touches this band, as in the study; below and above stay steady.
const BAND = [200, 1000];

export class Music {
  constructor(sources = {}) {
    this.sources = sources;
    this.levels = { ...SOUND_DEFAULTS };
    this.mode = "journey";
    this.on = false; // ♪: every sound but the chime
    this.focusing = false;
    // () => {elapsed, total} in ms of the running pomodoro, or null.
    this.clock = () => null;
    this.ctx = null;
  }

  // Call from a user gesture; later calls are cheap.
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      // A limiter for safety only; set lower, it pumps on noise peaks.
      this.out = this.ctx.createDynamicsCompressor();
      this.out.threshold.value = -2;
      this.out.knee.value = 0;
      this.out.ratio.value = 20;
      this.out.connect(this.ctx.destination);
      this.base = this.sources.base ? fileTrack(this.sources.base) : noiseTrack(this.ctx, this.out);
      this.pad = this.sources.focus ? fileTrack(this.sources.focus) : padTrack(this.ctx, this.out);
    }
    if (this.ctx.state === "suspended") this.ctx.resume();
    this.update();
  }

  setOn(on) {
    this.on = on;
    this.update();
  }

  setFocus(on) {
    this.focusing = on;
    this.update();
  }

  // Where the pad stands: 0 = noise alone, 1 = pad fully in.
  padShare() {
    if (!this.focusing || this.mode === "noise" || this.mode === "silence") return 0;
    if (this.mode === "pad") return 1;
    const c = this.clock();
    if (!c) return 1;
    const half = c.total / 2000;
    const into = c.elapsed / 1000, left = (c.total - c.elapsed) / 1000;
    const up = Math.min(this.levels.padIn, half), down = Math.min(this.levels.padOut, half);
    return Math.max(0, Math.min(1, up > 0 ? into / up : 1, down > 0 ? left / down : 1));
  }

  // Fade to what should be playing now; called again every second of a
  // pomodoro, so the handovers move along with it.
  update() {
    if (!this.ctx) return;
    const L = this.levels;
    const k = this.padShare();
    // ♪ off silences a pomodoro too. Equal-power, so a handover doesn't dip in the middle.
    const on = this.on ? 1 : 0;
    const noise = on * (!this.focusing ? 1 : this.mode === "silence" ? 0 : this.mode === "journey" ? Math.sqrt(1 - k) : 1);
    this.base.set?.({ colour: COLOURS[L.colour] ?? "brown", tone: L.baseTone });
    this.pad.set?.({ tone: L.baseTone + (L.padTone - L.baseTone) * (this.mode === "journey" ? k : 1),
                     rate: L.rate, depth: L.depth });
    this.base.fade(L.base * noise);
    this.pad.fade(L.focus * Math.sqrt(k) * on);
  }

  chime() {
    const v = this.levels.chime;
    if (!this.ctx || v <= 0) return;
    const t = this.ctx.currentTime;
    // Two soft partials, a fast swell and a long fall: a bowl, not a bell.
    for (const [hz, k] of [[528, 1], [792, 0.4]]) {
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.frequency.value = hz;
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(0.25 * v * k, t + 0.04);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.5);
      osc.connect(g).connect(this.ctx.destination);
      osc.start(t);
      osc.stop(t + 3.6);
    }
  }
}

// A looping file. It plays through a plain <audio>, so URLs from any host
// work without CORS; volume is faded by hand.
function fileTrack(src) {
  const audio = Object.assign(new Audio(src), { loop: true, volume: 0 });
  let timer = null, target = 0;
  return {
    fade(to) {
      if (to === target) return;
      target = to;
      clearInterval(timer);
      if (to > 0 && audio.paused) audio.play().catch(() => {});
      const from = audio.volume;
      const t0 = performance.now();
      timer = setInterval(() => {
        const k = Math.min(1, (performance.now() - t0) / (FADE_S * 1000));
        audio.volume = Math.min(1, Math.max(0, from + (to - from) * k));
        if (k < 1) return;
        clearInterval(timer);
        if (to === 0) audio.pause();
      }, 50);
    },
  };
}

// Glide a param to a value; a short time constant for settings, the
// crossfade length for volumes.
function glide(ctx, param, v, seconds = 0.3) {
  const t = ctx.currentTime;
  param.cancelScheduledValues(t);
  param.setTargetAtTime(v, t, seconds / 3);
}

// Generated noise: one set of layered loops per colour, made on first use,
// behind one low-pass. Changing colour crossfades.
function noiseTrack(ctx, dest) {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(dest);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.connect(out);
  const colours = {};
  let current = null;
  return {
    set({ colour, tone }) {
      glide(ctx, lp.frequency, tone);
      if (colour === current) return;
      current = colour;
      if (!colours[colour]) {
        colours[colour] = ctx.createGain();
        colours[colour].gain.value = 0;
        colours[colour].connect(lp);
        for (const s of LAYERS_S) {
          const src = ctx.createBufferSource();
          src.buffer = noiseBuffer(ctx, colour, s);
          src.loop = true;
          src.connect(colours[colour]);
          src.start();
        }
      }
      for (const [c, g] of Object.entries(colours)) glide(ctx, g.gain, c === colour ? 1 : 0);
    },
    fade(to) {
      glide(ctx, out.gain, to, FADE_S);
    },
  };
}

// The pad: a soft open chord, each note a detuned pair of triangles so it
// breathes on its own. Its 200 Hz–1 kHz band runs through the wobble.
function padTrack(ctx, dest) {
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(dest);
  const filter = (type, hz, to) => {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = hz;
    f.Q.value = Math.SQRT1_2;
    f.connect(to);
    return f;
  };
  const mod = ctx.createGain();
  mod.connect(out);
  const lfo = ctx.createOscillator();
  const lfoAmt = ctx.createGain();
  lfoAmt.gain.value = 0;
  lfo.connect(lfoAmt).connect(mod.gain);
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.connect(filter("highpass", BAND[0], filter("lowpass", BAND[1], mod)));
  lp.connect(filter("lowpass", BAND[0], out));
  lp.connect(filter("highpass", BAND[1], out));
  let started = false;
  const start = () => {
    started = true;
    lfo.start();
    for (const [hz, v] of [[110, 0.09], [164.8, 0.06], [220, 0.05], [277.2, 0.035], [329.6, 0.03]]) {
      for (const detune of [-4, 4]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "triangle";
        osc.frequency.value = hz;
        osc.detune.value = detune;
        g.gain.value = v;
        osc.connect(g).connect(lp);
        osc.start();
      }
    }
  };
  return {
    set({ tone, rate, depth }) {
      glide(ctx, lp.frequency, tone);
      glide(ctx, lfo.frequency, rate, 0.05);
      // The average stays 1 - depth/2, so the wobble doesn't change loudness.
      glide(ctx, mod.gain, 1 - depth / 2, 0.05);
      glide(ctx, lfoAmt.gain, depth / 2, 0.05);
    },
    fade(to) {
      if (to > 0 && !started) start();
      glide(ctx, out.gain, to, FADE_S);
    },
  };
}

function noiseBuffer(ctx, colour, seconds) {
  // Whole samples: 48000 × 7.3 isn't an integer, and a fractional index
  // reads undefined, which turns the whole mix to NaN.
  const len = Math.round(ctx.sampleRate * seconds);
  const seam = Math.round(ctx.sampleRate * 0.5);
  const data = new Float32Array(len + seam);
  let last = 0, b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < data.length; i++) {
    const w = Math.random() * 2 - 1;
    if (colour === "white") data[i] = w;
    else if (colour === "pink") { // Paul Kellet's economy filter
      b0 = 0.99765 * b0 + w * 0.099046;
      b1 = 0.963 * b1 + w * 0.2965164;
      b2 = 0.57 * b2 + w * 1.0526913;
      data[i] = b0 + b1 + b2 + w * 0.1848;
    } else {
      last = (last + 0.02 * w) / 1.02;
      data[i] = last;
    }
  }
  // The same loudness for every colour, shared between the layers.
  let sum = 0;
  for (let i = 0; i < len; i++) sum += data[i] * data[i];
  const norm = 0.2 / Math.sqrt(sum / len) / Math.sqrt(LAYERS_S.length);
  for (let i = 0; i < data.length; i++) data[i] *= norm;
  // Crossfade the extra tail into the start, so the loop runs on from the
  // last sample into the first without a click. Equal-power: a linear
  // crossfade of two unrelated noises dips 3 dB mid-seam, heard as a gap.
  for (let i = 0; i < seam; i++) {
    const k = i / seam;
    data[i] = data[i] * Math.sqrt(k) + data[len + i] * Math.sqrt(1 - k);
  }
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  buf.copyToChannel(data.subarray(0, len), 0);
  return buf;
}
