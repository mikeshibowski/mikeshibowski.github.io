// Renderer. Every item is a small mark of the same size, and only what you
// can do now is in focus: a doable task is a lit disc with a bright centre,
// a question a "?", an artifact a tiny satellite, a thought a few grains of
// dust, a wormhole a small hollow light. A task with any open sub-task is
// out of focus instead (one or many look the same) and pulls back into
// focus when they close. A goal, the top of its tree, wears a small peak
// above its mark.
// The clicked item grows, wears four still corner ticks and an accent
// title; a task or question in a pomodoro wears a thin ring that fills as it
// runs, a small bead at its head (focus.js).
// Important (!1) tasks pulse; a done task's mark goes out. Every
// strength lives in `look` (LOOK_DEFAULTS), tuned from the ≈ panel.
// In light mode the marks are ink on paper in daylight, not the dark look
// inverted: a doable task is a crisp dot of ink with a paper-white centre,
// a blocked one a pale wash, and the swell is light and shade on the paper
// with a faint grain (setTheme, theme.ink).
// Under everything lies the swell (surface.js), rendered at low resolution
// and smoothed up, and each item floats on it; wormhole.js has the
// transition maths. Over the swell, the active memory halo when on: a barely
// there ring of soft light with dashed empty sockets, quieter than any
// mark, staying put through a wormhole warp.

import { swellAt, swellLight } from "./surface.js";
import { warpState, warpPoint, warpZoom } from "./wormhole.js";

// Per theme: label text, a mark's core, how marks meet the background, how
// much to lift thin lines (arrows, the halo): a faint accent line on
// near-black is lost long before the same line on paper, and whether marks
// are ink rather than light.
const THEMES = {
  dark: { text: "232, 235, 241", core: "255, 255, 255", blend: "lighter", lines: 1.8, ink: false },
  light: { text: "31, 35, 41", core: "24, 28, 34", blend: "source-over", lines: 1, ink: true },
};
const INK = [31, 35, 41];
const SHADE = [70, 58, 46]; // the swell's shade on paper: warm, never black
const LABEL_MAX_W = 170;
const MARK_R = 5.5; // every kind's mark, px
export const MARK_RR = 7; // where a mark's label and arrows start
const WORMHOLE_R = 11; // its hollow ring sits at about MARK_R
const SWELL_CELL = 10; // px per background sample; the upscale does the blurring
const SINK_MS = 700; // an item dropped into a wormhole
const DONE_MARK = 0.25; // what's left of a done task's mark
const RING_R = MARK_R + 4.5; // a pomodoro's ring
const EDGE_EASE_MS = 250; // an arrow lighting up or going quiet
const TICK_H = 13; // the clicked item's corner ticks, px from its centre (unscaled)
// The halo: soft layers of one ring, wide and faint to thin and clear.
const HALO_LAYERS = [[16, 0.03], [9, 0.05], [4, 0.09], [1, 0.32]];
const HALO_LIGHT = 0.13;
const LABEL_FONT = "450 14px Inter, system-ui, sans-serif";

export const FADE_IN_MS = 400;

// The ≈ panel's look sliders (see app.js for what each one says).
export const LOOK_DEFAULTS = {
  size: 1.8, // every mark's scale
  selSize: 1.8, // the clicked item
  selTicks: 2, // its corner ticks
  focusRing: 1, // a pomodoro's ring
  glow: 1.5, // halo around a doable task
  blur: 2, // how soft a blocked task is
  blockedLight: 1,
  cross: 1.8, // a goal's peak
  question: 1.3,
  dustLight: 1.3,
  wormhole: 1.8,
  pool: 1.8, // the active memory halo and its empty sockets
  pulse: 0.9, // important (!1) tasks
  pulseSec: 3.3,
  doneLabel: 0.2,
  focusDim: 0.25, // how visible the rest stays while one item has focus
  labels: 0.8,
  edges: 0.2,
  grain: 0.4, // light mode: the paper's grain
  shade: 1, // light mode: the swell's shaded side
};

export const DISSOLVE_MS = 800;

const mixRgb = (from, to, t) =>
  from.split(", ").map((v, i) => Math.round(+v + (to[i] - v) * t)).join(", ");

const easeOut = (t) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

function hash(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

// Paper grain: one seeded tile of light and dark specks, used as a pattern.
function grainTile() {
  const size = 160;
  const c = document.createElement("canvas");
  c.width = c.height = size;
  const g = c.getContext("2d");
  const img = g.createImageData(size, size);
  const rand = rng(7);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = rand();
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v < 0.5 ? 60 : 255;
    img.data[i + 3] = Math.round(Math.abs(v - 0.5) * 80);
  }
  g.putImageData(img, 0, 0);
  return c;
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Renderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.sprites = new Map();
    this.accent = [163, 226, 212];
    this.bg = [11, 13, 18];
    this.look = { ...LOOK_DEFAULTS };
    this.theme = THEMES.dark;
    this.pulseOn = true; // off for reduced motion and while typing
    this.pulsing = false; // a task beat in the last frame
    this.resize();
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.dpr = dpr;
    this.w = window.innerWidth;
    this.h = window.innerHeight;
    this.canvas.width = Math.round(this.w * dpr);
    this.canvas.height = Math.round(this.h * dpr);
    this.swell = null;
  }

  setAccent(rgb) {
    if (rgb.join() === this.accent.join()) return;
    this.accent = rgb;
    this.sprites.clear();
    this.swell = null;
  }

  setBackground(rgb) {
    if (rgb.join() === this.bg.join()) return;
    this.bg = rgb;
    this.swell = null; // the paper's shade is mixed from it
  }

  setTheme(name) {
    const theme = THEMES[name] ?? THEMES.dark;
    if (theme === this.theme) return;
    this.theme = theme;
    this.sprites.clear();
    this.swell = null;
  }

  get rgb() {
    return this.accent.join(", ");
  }

  // Ink: the accent run darker, for dust, "?" and arrows on paper.
  get inkRgb() {
    return this.theme.ink ? mixRgb(this.rgb, INK, 0.35) : this.rgb;
  }

  // ---- wormhole sprite ------------------------------------------------------

  // A wormhole's light is a band around nothing: a few seeded radial
  // gradients pre-rendered once, drawn additively.
  sprite(node) {
    // In the colour of the canvas it leads to (doorRgb, set by app.js).
    const rgb = this.doorRgb?.(node.item.target) ?? this.rgb;
    const key = `${node.id} ${rgb}`;
    let s = this.sprites.get(key);
    if (s) return s;
    const pad = 1.25;
    const size = Math.ceil(WORMHOLE_R * 2 * pad * this.dpr);
    s = document.createElement("canvas");
    s.width = s.height = size;
    const g = s.getContext("2d");
    const c = size / 2;
    const R = WORMHOLE_R * this.dpr;
    const rand = rng(hash(node.id));
    g.globalCompositeOperation = "lighter";
    // A soft fall into the hollow, so it reads as a light, not a ring.
    const stops = [[0, 0.03], [0.22, 0.08], [0.58, 0.75], [0.8, 0.3], [1, 0]];
    const blob = (x, y, r, a) => {
      const grad = g.createRadialGradient(x, y, 0, x, y, r);
      for (const [at, k] of stops) grad.addColorStop(at, `rgba(${rgb}, ${a * k})`);
      g.fillStyle = grad;
      g.fillRect(0, 0, size, size);
    };
    blob(c, c, R, 0.3);
    for (let i = 0; i < 2; i++) {
      const ang = rand() * Math.PI * 2;
      const off = R * (0.12 + rand() * 0.14) * 0.35;
      blob(c + Math.cos(ang) * off, c + Math.sin(ang) * off, R * (0.9 + rand() * 0.08), 0.14);
    }
    s = { canvas: s, half: WORMHOLE_R * pad };
    this.sprites.set(key, s);
    return s;
  }

  forget(id) {
    this.sprites.delete(id);
  }

  // ---- marks --------------------------------------------------------------------
  // Drawn about (0, 0), additively (multiplied in light mode); `a` is the
  // item's opacity.

  blob(r, a, stops, rgb = this.rgb) {
    const ctx = this.ctx;
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
    for (const [at, k] of stops) grad.addColorStop(at, `rgba(${rgb}, ${a * k})`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
  }

  glow(r, a, rgb = this.theme.core) {
    this.blob(r, a, [[0, 1], [1, 0]], rgb);
  }

  // The doable task: a small, evenly lit disc with a sharp edge. On paper,
  // a crisp dot of ink whose centre stays paper-white; `out` (0..1) is a
  // done task's dot going out to a thin outline.
  taskMark(a, out = 0) {
    if (this.theme.ink) {
      const ctx = this.ctx;
      this.glow(12, 0.032 * a * (1 - out) * this.look.glow, this.rgb);
      ctx.fillStyle = `rgba(${this.rgb}, ${0.95 * a * (1 - out)})`;
      ctx.beginPath();
      ctx.arc(0, 0, MARK_R, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = `rgba(${this.bg.join(", ")}, ${0.95 * a * (1 - out)})`;
      ctx.beginPath();
      ctx.arc(0, 0, 1.9, 0, Math.PI * 2);
      ctx.fill();
      if (out > 0) {
        ctx.strokeStyle = `rgba(${this.rgb}, ${0.35 * a * out})`;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(0, 0, MARK_R - 0.5, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    this.glow(11, 0.28 * a * this.look.glow, this.rgb);
    this.blob(MARK_R, 0.9 * a, [[0, 1], [0.75, 0.9], [1, 0]]);
    this.glow(2.5, 0.8 * a);
  }

  // Just a "?": open, waiting for an answer. Kept under the task's light.
  questionMark(a) {
    const ctx = this.ctx;
    const k = a * this.look.question;
    this.glow(8, 0.06 * k, this.rgb);
    ctx.font = "600 14px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = `rgba(${this.inkRgb}, ${(this.theme.ink ? 0.65 : 0.6) * k})`;
    ctx.fillText("?", 0, 0.5);
  }

  // A tiny satellite: a made thing, in the same footprint as the others.
  artifactMark(a) {
    const ctx = this.ctx;
    this.glow(8, 0.1 * a, this.rgb);
    ctx.fillStyle = `rgba(${this.theme.core}, ${0.6 * a})`;
    ctx.fillRect(-1.5, -1.5, 3, 3);
    ctx.fillStyle = `rgba(${this.rgb}, ${0.6 * a})`;
    ctx.fillRect(-6, -0.9, 3.5, 1.8);
    ctx.fillRect(2.5, -0.9, 3.5, 1.8);
  }

  // A few grains of dust drifting slowly inside the mark, like dust in a
  // sunbeam: asks for nothing. They run on the item's dust clock (n.dustT),
  // so they stop under the pointer, while typing and for reduced motion.
  thoughtMark(n, a) {
    const ctx = this.ctx;
    const rand = rng(hash(n.id));
    const t = n.dustT ?? 0;
    ctx.fillStyle = `rgba(${this.inkRgb}, ${(this.theme.ink ? 0.58 : 0.55) * a * this.look.dustLight})`;
    for (let i = 0; i < 11; i++) {
      const spin = (0.12 + rand() * 0.2) * (rand() < 0.5 ? -1 : 1); // rad/s: a turn in 20-50 s
      const ang = rand() * Math.PI * 2 + spin * t;
      const d0 = Math.sqrt(rand()) * (MARK_R - 1);
      const d = Math.min(MARK_R, Math.max(0, d0 + 1.2 * Math.sin(t * (0.3 + rand() * 0.3) + rand() * 6.3)));
      ctx.fillRect(Math.cos(ang) * d - 0.6, Math.sin(ang) * d - 0.6, 1.2, 1.2);
    }
  }

  // One item at the origin. Returns rr, where its label starts (unscaled).
  drawItem(n, a, now) {
    const L = this.look;
    const kind = n.item.kind;
    if (kind === "wormhole" && this.theme.ink) {
      // On paper, a thin clean ring in the colour of the canvas it leads to.
      const rgb = this.doorRgb?.(n.item.target) ?? this.rgb;
      const k = a * L.wormhole / 1.8;
      this.blob(9, 0.1 * k, [[0, 0.2], [0.75, 1], [1, 0]], rgb);
      this.ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, 0.85 * k)})`;
      this.ctx.lineWidth = 1.4;
      this.ctx.beginPath();
      this.ctx.arc(0, 0, 6.8, 0, Math.PI * 2);
      this.ctx.stroke();
      return MARK_RR;
    }
    if (kind === "wormhole") {
      const sp = this.sprite(n);
      // Past 1 the light is drawn again on top (additive).
      for (let k = a * L.wormhole; k > 0.003; k -= 1) {
        this.ctx.globalAlpha = Math.min(1, k);
        this.ctx.drawImage(sp.canvas, -sp.half, -sp.half, sp.half * 2, sp.half * 2);
      }
      this.ctx.globalAlpha = 1;
      return MARK_RR;
    }
    if (kind === "question") this.questionMark(a);
    else if (kind === "artifact") this.artifactMark(a);
    else if (kind === "thought") this.thoughtMark(n, a);
    if (kind !== "task") return MARK_RR;

    // f: 1 in focus (doable), 0 blocked; eased by app.js.
    const f = n.fShown ?? 1;
    const ink = this.theme.ink;
    const lit = ink ? a : a * (1 - (1 - DONE_MARK) * (n.doneShown ?? 0));
    if (f < 1 && ink) {
      // A pale wash with no edge.
      this.blob(MARK_R + 1.25 * L.blur, 0.32 * L.blockedLight * lit * (1 - f), [[0, 1], [0.6, 0.85], [1, 0]]);
    } else if (f < 1) {
      const soft = Math.min(0.95, 0.25 + 0.35 * L.blur);
      this.blob(MARK_R + 2.5 * L.blur, 0.45 * L.blockedLight * lit * (1 - f), [[0, 1], [1 - soft, 0.8], [1, 0]]);
    }
    if (f > 0) this.taskMark(lit * f, ink ? n.doneShown ?? 0 : 0);
    if (n.item.done) return MARK_RR;

    if (n.goal) {
      // The top of a tree: one small chevron above, the summit its arrows
      // climb to. Quieter than a frame, and clear of the label on the right.
      const ctx = this.ctx;
      ctx.strokeStyle = `rgba(${this.theme.core}, ${Math.min(1, (ink ? 0.33 : 0.45) * L.cross * a)})`;
      ctx.lineWidth = ink ? 1.2 : 1;
      ctx.lineJoin = "round";
      ctx.beginPath();
      ctx.moveTo(-4, -9);
      ctx.lineTo(0, -12.5);
      ctx.lineTo(4, -9);
      ctx.stroke();
    }
    // The only beats on the canvas, on important tasks;
    // held still for reduced motion and typing.
    if (L.pulse > 0 && n.item.importance === 1) {
      const b = this.pulseOn ? (1 - Math.cos((now / (L.pulseSec * 1000)) * Math.PI * 2)) / 2 : 0.6;
      // On paper a soft wash ring breathes instead of a glow.
      if (ink) this.blob(MARK_RR + 10, 0.22 * b * a * L.pulse, [[0, 0], [0.5, 0.2], [0.8, 1], [1, 0]]);
      else this.glow(MARK_RR + 9, 0.5 * b * a * L.pulse, this.rgb);
      this.pulsing ||= this.pulseOn;
    }
    return MARK_RR;
  }

  // A pomodoro under way: a faint full circle and, over it, an arc that
  // fills clockwise from the top. Still, so it never competes with a pulse.
  // Returns where the label starts.
  focusRingMark(n, a) {
    const ctx = this.ctx;
    const R = RING_R;
    const k = Math.min(1, a * this.look.focusRing * (n.ringPaused ? 0.5 : 1));
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${this.rgb}, ${0.12 * k})`;
    ctx.beginPath();
    ctx.arc(0, 0, R, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = `rgba(${this.rgb}, ${0.6 * k})`;
    ctx.beginPath();
    const end = -Math.PI / 2 + Math.PI * 2 * (n.ringProgress ?? 0);
    ctx.arc(0, 0, R, -Math.PI / 2, end);
    ctx.stroke();
    // A bead where the arc has got to: you find the time without tracing it.
    const bead = Math.min(1, 0.6 * k);
    if (bead > 0.004) {
      ctx.save();
      ctx.translate(Math.cos(end) * R, Math.sin(end) * R);
      this.glow(3.2, 0.9 * bead);
      ctx.restore();
    }
    return R + 2;
  }

  // Four still corner ticks around the clicked item, like a camera's focus
  // frame: clear at a glance, and nothing moves. Unscaled, about (0, 0).
  selTicksMark(n, scale) {
    const k = (n.sel ?? 0) * this.look.selTicks * (n.drawAlpha ?? 1);
    if (k < 0.004) return;
    const ctx = this.ctx;
    const h = TICK_H * scale;
    const t = 4.5;
    ctx.strokeStyle = `rgba(${this.rgb}, ${Math.min(1, 0.55 * k)})`;
    ctx.lineWidth = 1;
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.beginPath();
      ctx.moveTo(sx * (h - t), sy * h);
      ctx.lineTo(sx * h, sy * h);
      ctx.lineTo(sx * h, sy * (h - t));
      ctx.stroke();
    }
  }

  // ---- labels -----------------------------------------------------------

  labelLines(node, full) {
    // A guest in the pool, from another canvas, says where it lives.
    const title = (node.item.label ?? node.item.title ?? "") + (node.guestOf != null ? ` · ${node.guestOf || "home"}` : "");
    const font = LABEL_FONT;
    const size = 14;
    const key = `${title}|${full}`;
    if (node.labelKey === key) return node.labelCache;

    const ctx = this.ctx;
    ctx.font = font;
    const maxLines = full ? 4 : 2;
    let lines = [];
    let line = "";
    const words = title.split(/\s+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const test = line ? line + " " + words[i] : words[i];
      if (ctx.measureText(test).width <= LABEL_MAX_W || !line) {
        line = test;
      } else {
        lines.push(line);
        line = words[i];
        if (lines.length === maxLines) {
          line = "";
          const last = lines[maxLines - 1];
          lines[maxLines - 1] = last + (i < words.length ? "…" : "");
          break;
        }
      }
    }
    if (line) lines.push(line);
    lines = lines.map((l) => {
      while (ctx.measureText(l).width > LABEL_MAX_W && l.length > 2) l = l.slice(0, -2) + "…";
      return l;
    });
    const width = Math.max(0, ...lines.map((l) => ctx.measureText(l).width));
    node.labelKey = key;
    node.labelCache = { lines, font, size, width, lineH: Math.round(size * 1.3) };
    if (!full) {
      // The resting label is what the layout keeps clear (physics.js boxes).
      node.labelW = width;
      node.labelH = lines.length * node.labelCache.lineH;
    }
    return node.labelCache;
  }

  // ---- frame ------------------------------------------------------------

  // ambient: { t, ft, waves, drift } (see app.js). Each node may carry its own
  // float clock n.t (frozen while hovered) and n.calm (0..1, how much it floats).
  // view.warp, while set, is a wormhole transition (see wormhole.js).
  draw(nodes, edges, view, now, ambient) {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, (w / 2) * dpr, (h / 2) * dpr);
    this.drawSwell(ambient);
    this.drawGrain();
    if (view.pool) this.drawPool(view.pool);

    const warp = view.warp ? warpState(view.warp, now) : null;
    const origin = warp && (warp.phase === "out" ? view.warp.from : view.warp.to);
    if (warp && warp.k > 0) {
      // Dive toward the wormhole: zoom the scene about it.
      const z = warpZoom(warp.k, warp.zoom);
      ctx.translate(origin.x, origin.y);
      ctx.scale(z, z);
      ctx.translate(-origin.x, -origin.y);
    }

    // Float every light on the swell. Faded items barely move.
    const sw = {};
    for (const n of nodes) {
      swellAt(n.x, n.y, n.t ?? ambient.ft, sw);
      const calm = n.calm ?? 1;
      const amp = ambient.drift * calm;
      // The float offset, kept for the physics: labels clear each other
      // where they are drawn, not only where they rest.
      n.floatX = sw.ox * amp;
      n.floatY = sw.oy * amp;
      n.px = n.x + n.floatX;
      n.py = n.y + n.floatY;
      n.lift = sw.h * calm * Math.min(1, ambient.drift / 6);
      if (warp && warp.k > 0) {
        warpPoint(n.px, n.py, origin.x, origin.y, warp.k, warp.swirl, sw);
        n.px = sw.x;
        n.py = sw.y;
      }
    }

    let animating = Boolean(warp);
    for (const n of nodes) {
      const age = now - n.born;
      let alpha = easeOut(age / FADE_IN_MS);
      let scale = 0.2 + 0.8 * alpha;
      let glow = 1;
      if (age < FADE_IN_MS) animating = true;
      if (n.dying && n.sink) {
        // Dropped into a wormhole: swirl into it and vanish.
        const t = (now - n.dying) / SINK_MS;
        const k = easeOut(t);
        animating = true;
        warpPoint(n.px, n.py, n.sink.x, n.sink.y, k, 2.2, sw);
        n.px = sw.x;
        n.py = sw.y;
        scale *= 1 - 0.8 * k;
        alpha *= 1 - k;
        n.dead = t >= 1;
      } else if (n.dying) {
        const t = (now - n.dying) / DISSOLVE_MS;
        animating = true;
        if (t < 0.25) {
          glow = 1 + 0.6 * easeOut(t / 0.25);
        } else {
          const u = easeOut((t - 0.25) / 0.75);
          glow = 1.6 * (1 - u);
          scale *= 1 + 0.3 * u;
          alpha *= 1 - u;
        }
        n.dead = t >= 1;
      }
      if (warp) {
        alpha *= 1 - warp.k;
        scale *= 1 - 0.6 * warp.k;
      }
      // The clicked item grows (n.sel is eased by app.js).
      scale *= 1 + (this.look.selSize - 1) * (n.sel ?? 0);
      // An item dragged over a wormhole: the door opens to take it.
      if (n.id === view.dropId) {
        scale *= 1.15;
        glow *= 1.5;
      }
      // Words go first in a warp: zoomed text looms and piles up.
      n.labelFade = warp ? Math.pow(1 - warp.k, 3) : 1;
      n.drawAlpha = alpha;
      n.drawScale = scale * (1 + 0.05 * n.lift);
      n.glow = glow;
      // Focus dims the others (a done task's mark goes out by itself).
      n.fade = n.vis ?? 1;
    }

    // The tunnel goes under the lights, so they visibly swirl into the dark
    // and bloom out of it. The zoom is about the origin, so it stays put.
    if (warp && warp.cover > 0) {
      ctx.save();
      this.drawTunnel(warp, origin, now - view.warp.t0);
      ctx.restore();
    }

    // Labels are placed first: hit testing reads their boxes.
    for (const n of nodes) {
      if (n.drawAlpha > 0.01) this.placeLabel(n, n.rr ?? MARK_RR, view.hoverId === n.id || view.focusId === n.id);
      else n.labelBox = null;
    }
    if (this.drawEdges(nodes, edges, view, now)) animating = true;

    // Marks, additively, then labels on top.
    this.pulsing = false;
    ctx.globalCompositeOperation = this.theme.blend;
    for (const n of nodes) {
      const a = Math.min(1, n.drawAlpha * n.fade * n.glow * (1 + 0.1 * n.lift));
      const scale = n.drawScale * this.look.size;
      ctx.save();
      ctx.translate(n.px, n.py);
      ctx.scale(scale, scale);
      if (a > 0.004) this.drawItem(n, a, now);
      if (n.ring > 0.004 && a > 0.004) this.focusRingMark(n, a * n.ring);
      ctx.restore();
      // Where arrows stop (n.er) and labels start (n.rr). Both follow the
      // same eased values as the marks, so nothing jumps when a ring or a
      // selection comes or goes. Arrows stop at the light (and its pomodoro
      // ring) and may run in between the corner ticks; labels clear them.
      const ring = this.look.focusRing > 0 ? n.ring ?? 0 : 0;
      n.er = scale * (MARK_RR + (RING_R + 2 - MARK_RR) * ring);
      // Labels clear the ticks whenever they show; the slider is only
      // their brightness, so it never moves the label.
      const ticks = this.look.selTicks > 0 ? n.sel ?? 0 : 0;
      n.rr = Math.max(n.er, scale * (MARK_RR + (TICK_H + 1 - MARK_RR) * ticks));
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    for (const n of nodes) {
      if (!n.sel || n.drawAlpha <= 0.01) continue;
      ctx.save();
      ctx.translate(n.px, n.py);
      this.selTicksMark(n, n.drawScale * this.look.size);
      ctx.restore();
    }

    for (const n of nodes) {
      if (n.drawAlpha <= 0.01) continue;
      if (n.item.pinned) {
        ctx.fillStyle = `rgba(${this.theme.text}, ${0.35 * n.drawAlpha * n.fade})`;
        ctx.beginPath();
        ctx.arc(n.px, n.py + n.rr + 5, 1.3, 0, Math.PI * 2);
        ctx.fill();
      }
      this.drawLabel(n, n.rr, view.hoverId === n.id || view.focusId === n.id);
    }

    if (view.link) {
      const { from, x, y } = view.link;
      ctx.strokeStyle = `rgba(${this.rgb}, 0.45)`;
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(from.px, from.py);
      ctx.lineTo(x, y);
      ctx.stroke();
      ctx.setLineDash([]);
      this.arrowHead(from.px, from.py, x, y, 0, `rgba(${this.rgb}, 0.45)`);
    }
    return animating;
  }

  // The active memory halo (app.js): { show, cx, cy, R, sockets: [{x, y,
  // filled}], open, tether: {x0, y0, x1, y1, k} }. `open` is the socket a
  // dragged item would land in; the tether, a slotted item in hand, fading
  // as it stretches toward letting go.
  drawPool(pool) {
    const ctx = this.ctx;
    const k = pool.show * this.look.pool * this.theme.lines;
    if (k <= 0.004) return;
    const rgb = this.rgb;
    ctx.save();
    for (const [width, alpha] of HALO_LAYERS) {
      ctx.lineWidth = width;
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, alpha * HALO_LIGHT * k)})`;
      ctx.beginPath();
      ctx.arc(pool.cx, pool.cy, pool.R, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.lineWidth = 1;
    pool.sockets.forEach((s, i) => {
      if (s.filled) return;
      const open = i === pool.open;
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, (open ? 0.7 : 0.35) * k)})`;
      ctx.setLineDash(open ? [] : [2, 3]);
      ctx.beginPath();
      ctx.arc(s.x, s.y, open ? MARK_R + 6 : MARK_R + 3, 0, Math.PI * 2);
      ctx.stroke();
    });
    ctx.setLineDash([]);
    const t = pool.tether;
    if (t && t.k > 0) {
      ctx.strokeStyle = `rgba(${rgb}, ${Math.min(1, 0.4 * t.k * k)})`;
      ctx.beginPath();
      ctx.moveTo(t.x0, t.y0);
      ctx.lineTo(t.x1, t.y1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // The tunnel: darkness spreading from the wormhole on the way out and
  // opening up from the return wormhole on the way in, with faint rings
  // rushing outward to give the sense of flying through.
  drawTunnel(warp, origin, elapsed) {
    const { ctx, dpr, w, h } = this;
    ctx.setTransform(dpr, 0, 0, dpr, (w / 2) * dpr, (h / 2) * dpr);
    const [br, bg, bb] = this.bg;
    const dark = (alpha) => `rgba(${Math.max(0, br - 6)}, ${Math.max(0, bg - 6)}, ${Math.max(0, bb - 6)}, ${alpha})`;
    const far = Math.hypot(w, h) * 1.1;
    const edge = 0.18; // soft edge, as a share of the radius
    let grad;
    if (warp.phase === "out") {
      const rr = Math.max(1, warp.cover * far);
      grad = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, rr);
      grad.addColorStop(0, dark(0.98));
      grad.addColorStop(1 - edge, dark(0.98));
      grad.addColorStop(1, dark(0));
    } else {
      const rr = Math.max(1, (1 - warp.cover) * far);
      grad = ctx.createRadialGradient(origin.x, origin.y, 0, origin.x, origin.y, rr);
      grad.addColorStop(0, dark(0));
      grad.addColorStop(1 - edge, dark(0));
      grad.addColorStop(1, dark(0.98));
    }
    ctx.fillStyle = grad;
    ctx.fillRect(-w / 2, -h / 2, w, h);

    // Rings rushing past, strongest mid-dive.
    const rings = 7;
    const strength = Math.sin(Math.PI * Math.min(1, warp.cover)) * 0.5 + 0.5 * warp.cover;
    ctx.lineWidth = 1;
    for (let i = 0; i < rings; i++) {
      const u = (i / rings + elapsed / 900) % 1;
      const rr = far * u * u;
      const alpha = 0.16 * strength * Math.sin(Math.PI * u);
      if (alpha < 0.005) continue;
      ctx.strokeStyle = `rgba(${this.rgb}, ${alpha})`;
      ctx.beginPath();
      ctx.arc(origin.x, origin.y, rr, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  // ---- swell ------------------------------------------------------------

  drawSwell(ambient) {
    if (ambient.waves <= 0) return;
    const cols = Math.ceil(this.w / SWELL_CELL) + 1;
    const rows = Math.ceil(this.h / SWELL_CELL) + 1;
    let sw = this.swell;
    if (!sw || sw.cols !== cols || sw.rows !== rows) {
      const c = document.createElement("canvas");
      c.width = cols;
      c.height = rows;
      const g = c.getContext("2d");
      sw = this.swell = { canvas: c, g, img: g.createImageData(cols, rows), cols, rows, t: null, waves: null };
    }
    // Recompute only when the surface moved (it is frozen during capture).
    if (sw.t !== ambient.t || sw.waves !== ambient.waves || sw.shade !== this.look.shade) {
      const accent = this.accent;
      // Paper: daylight lifts the lit slopes towards white and the shaded
      // ones dip into a warm shade; no accent in it.
      const ink = this.theme.ink;
      const white = [255, 255, 255];
      const shadeRgb = this.bg.map((v, k) => Math.round(v + (SHADE[k] - v) * 0.9));
      const shadeK = 0.5 * this.look.shade;
      const data = sw.img.data;
      const p = {};
      const x0 = -this.w / 2;
      const y0 = -this.h / 2;
      let i = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          swellAt(x0 + col * SWELL_CELL, y0 + row * SWELL_CELL, ambient.t, p);
          let rgb = accent;
          let alpha = ambient.waves * swellLight(p);
          if (ink) {
            const s = 0.35 * p.shade + 0.15 * p.h;
            rgb = s > 0 ? white : shadeRgb;
            alpha = ambient.waves * (s > 0 ? 1.1 * s : -s * shadeK);
          }
          data[i++] = rgb[0];
          data[i++] = rgb[1];
          data[i++] = rgb[2];
          data[i++] = Math.round(255 * Math.min(1, alpha));
        }
      }
      sw.g.putImageData(sw.img, 0, 0);
      sw.t = ambient.t;
      sw.waves = ambient.waves;
      sw.shade = this.look.shade;
    }
    const ctx = this.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(sw.canvas, -this.w / 2, -this.h / 2, cols * SWELL_CELL, rows * SWELL_CELL);
  }

  // The paper's grain, still under everything (light mode only).
  drawGrain() {
    if (!this.theme.ink || this.look.grain <= 0) return;
    const ctx = this.ctx;
    this.grain ??= ctx.createPattern(grainTile(), "repeat");
    ctx.globalAlpha = Math.min(1, 0.6 * this.look.grain);
    ctx.fillStyle = this.grain;
    ctx.fillRect(-this.w / 2, -this.h / 2, this.w, this.h);
    ctx.globalAlpha = 1;
  }

  // An edge is a straight line that starts and ends at the lights' rings
  // rather than their centres. Shared by drawing and hit-testing:
  // { x0, y0, cx, cy, x1, y1 }, with (cx, cy) the midpoint, so it is also a
  // (straight) quadratic for app.js's edgeAt.
  edgePath(a, b) {
    const dx = b.px - a.px;
    const dy = b.py - a.py;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d;
    const uy = dy / d;
    const ring = (n) => (n.er ?? n.r ?? MARK_RR) + 3;
    const x0 = a.px + ux * ring(a);
    const y0 = a.py + uy * ring(a);
    const x1 = b.px - ux * ring(b);
    const y1 = b.py - uy * ring(b);
    return { x0, y0, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, x1, y1 };
  }

  // Arrows go under the labels; text is drawn on top of them. Returns true
  // while an arrow is still easing between quiet and lit.
  drawEdges(nodes, edges, view, now) {
    const ctx = this.ctx;
    const heads = [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const focus = view.dragId || view.hoverId || view.focusId;
    const line = view.line; // the focused task's line, see tasks.js
    // Lit arrows ease in and out rather than switch, like the lights they join.
    this.edgeLit ??= new Map();
    const step = Math.min(1, (now - (this.edgeT ?? now)) / EDGE_EASE_MS);
    this.edgeT = now;
    const seen = new Set();
    let easing = false;
    // On paper, arrows are ink: the accent a little darker.
    const lineRgb = this.theme.ink ? mixRgb(this.rgb, INK, 0.2) : this.rgb;
    ctx.lineWidth = 1;
    for (const e of edges) {
      const a = byId.get(e.a);
      const b = byId.get(e.b);
      if (!a || !b) continue;
      seen.add(e.id);
      const want = e.id === view.selectedEdge || (focus && (e.a === focus || e.b === focus)) ||
        (line?.has(e.a) && line.has(e.b)) ? 1 : 0;
      const before = this.edgeLit.get(e.id) ?? want;
      let lit = before + Math.sign(want - before) * Math.min(step, Math.abs(want - before));
      if (!this.pulseOn) lit = want; // held still with the pulses (reduced motion, typing)
      this.edgeLit.set(e.id, lit);
      easing ||= lit !== want;
      // Long connections would slice across everything; let them recede.
      const len = Math.hypot(b.px - a.px, b.py - a.py);
      const quiet = Math.min(0.45, this.look.edges * this.theme.lines * Math.min(1, Math.max(0.35, 260 / len)));
      // Lights close together: the arrow shrinks to nothing, then fades.
      const room = Math.min(1, Math.max(0, (len - (a.er ?? 7) - (b.er ?? 7) - 8) / 12));
      const alpha = (quiet + (0.5 - quiet) * lit) * room * Math.min(a.drawAlpha * a.fade, b.drawAlpha * b.fade);
      if (alpha < 0.01) continue;
      const p = this.edgePath(a, b);
      // Edges point a -> b: the line fades in from a, so the direction reads
      // even before the small head at b's ring.
      const grad = ctx.createLinearGradient(p.x0, p.y0, p.x1, p.y1);
      grad.addColorStop(0, `rgba(${lineRgb}, 0)`);
      grad.addColorStop(0.6, `rgba(${lineRgb}, ${alpha})`);
      grad.addColorStop(1, `rgba(${lineRgb}, ${alpha})`);
      ctx.strokeStyle = grad;
      ctx.beginPath();
      ctx.moveTo(p.x0, p.y0);
      ctx.lineTo(p.x1, p.y1);
      ctx.stroke();
      heads.push([p.x0, p.y0, p.x1, p.y1, `rgba(${lineRgb}, ${Math.min(0.8, alpha * 2.5)})`]);
    }
    for (const id of this.edgeLit.keys()) if (!seen.has(id)) this.edgeLit.delete(id);
    for (const h of heads) this.arrowHead(...h.slice(0, 4), 0, h[4]);
    return easing;
  }

  // A small filled head pointing from (fx, fy) toward (tx, ty), its tip
  // `back` px short of the target.
  arrowHead(fx, fy, tx, ty, back, fill) {
    const dx = tx - fx;
    const dy = ty - fy;
    const d = Math.hypot(dx, dy);
    if (d < back + 8) return;
    const ux = dx / d;
    const uy = dy / d;
    const x = tx - ux * back;
    const y = ty - uy * back;
    const len = 7;
    const half = 3.2;
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x, y);
    ctx.lineTo(x - ux * len - uy * half, y - uy * len + ux * half);
    ctx.lineTo(x - ux * len + uy * half, y - uy * len - ux * half);
    ctx.closePath();
    ctx.fill();
  }

  // Where a label goes (right of its mark, left near the screen edge);
  // sets n.labelBox (for hit testing). Null if it has no text.
  placeLabel(n, r, full) {
    const L = this.labelLines(n, full);
    if (!L.lines.length || !L.lines[0]) return (n.labelBox = null);
    const gap = r + 8;
    let left = n.px + gap > this.w / 2 - L.width - 12 ? false : true;
    if (!left && n.px - gap - L.width < -this.w / 2 + 12) left = true;
    const x = left ? n.px + gap : n.px - gap;
    const total = L.lines.length * L.lineH;
    n.labelBox = {
      x0: left ? x : x - L.width,
      x1: left ? x + L.width : x,
      y0: n.py - total / 2,
      y1: n.py + total / 2,
    };
    return { L, x, left, total };
  }

  drawLabel(n, r, full) {
    const ctx = this.ctx;
    const place = this.placeLabel(n, r, full);
    if (!place) return;
    const { L, x, left, total } = place;
    let y = n.py - total / 2 + L.lineH / 2;
    // Done labels stay readable, just quiet; focus dims labels like lights.
    const fade = (n.vis ?? 1) * (n.item.done ? this.look.doneLabel : 1);
    const alpha = (full ? 0.95 : this.look.labels) * n.drawAlpha * (n.labelFade ?? 1) * fade;

    ctx.font = L.font;
    ctx.textAlign = left ? "left" : "right";
    ctx.textBaseline = "middle";
    // The clicked item's title leans into the accent colour.
    const accent = Math.min(1, n.sel ?? 0);
    const text = this.theme.text;
    const rgb = accent > 0 ? mixRgb(text, this.accent, accent) : text;
    if (accent > 0.5) ctx.font = L.font.replace("450", "550");
    ctx.fillStyle = `rgba(${rgb}, ${alpha * (n.item.kind === "thought" ? 0.9 : 1)})`;
    const struck = n.item.done ? n.doneShown ?? 1 : 0;
    for (const line of L.lines) {
      ctx.fillText(line, x, y);
      if (struck > 0) {
        // Struck through left to right as the mark goes out.
        const w = ctx.measureText(line).width * struck;
        ctx.fillRect(left ? x : x - ctx.measureText(line).width, y, w, 1);
      }
      y += L.lineH;
    }
  }
}
