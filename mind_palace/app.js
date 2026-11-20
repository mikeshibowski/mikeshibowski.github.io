import { Physics, FORCE_DEFAULTS, MEMORY_SLOTS, HALO_CLEAR, MEMORY_BREAK, socketAt } from "./physics.js";
import { Renderer, MARK_RR, LOOK_DEFAULTS } from "./render.js";
import { Drawer } from "./drawer.js";
import { taskStates, taskLine } from "./tasks.js";
import { paletteFor, currentHour, applyPalette, canvasAccent, scheduledTheme, nextSwitch, toHex } from "./palette.js";
import { parseCapture, parseList, KINDS } from "./parse.js";
import { Dictation, voiceSupported, voiceLanguages, loadLang, saveLang } from "./voice.js";
import { WARP, WARP_CALM, warpState } from "./wormhole.js";
import { Focus, canFocus, elapsed, remaining, progress, clock } from "./focus.js";
import { Music, SOUND_DEFAULTS, SOUND_MODES } from "./music.js";
import { Store, localDay } from "./store.js";
import { Storage } from "./storage.js";
import { config } from "./config.js";

const PRESS_MS = 450;
const CLICK_DELAY_MS = 220; // wait to tell a click from a double-click
const MOVE_TOLERANCE = 6;

const $ = (id) => document.getElementById(id);
const canvas = $("sky");
const renderer = new Renderer(canvas);
const physics = new Physics();
const focus = new Focus();
const music = new Music();

let items = new Map(); // id -> item (the store's truth)
let edges = [];
let canvases = { home: { name: "" } };
let lastState = null; // everything, for switching canvases
let states = new Map(); // task id -> { blocked, goal }
// The active memory: a few slots shared by every canvas (in the store), shown as
// a pool in the middle of the field when on (this browser).
let memory = Array(MEMORY_SLOTS).fill(null);
let memoryOn = false;
const pool = { show: 0 };

// The canvas on screen lives in the URL (#c=<id>; none means home), so the
// browser's Back and Forward travel through wormholes too.
const HOME = "home";
const canvasFromHash = () => new URLSearchParams(location.hash.slice(1)).get("c") || HOME;
let here = canvasFromHash();
const nodes = new Map(); // id -> physics/render node

// focusId: the clicked item; everything off its line (tasks.js) fades and
// its details open in the card. Nothing moves for it. line: the line of the
// dragged, hovered or focused item, whose arrows light up.
const view = {
  hoverId: null, dragId: null, selectedEdge: null, link: null, dropId: null, warp: null, focusId: null,
  line: null, pool: null, socket: null, tether: null,
};

// Lines are walked once per item per state, not every frame.
let lines = new Map();
const lineOf = (id) => {
  if (!id) return null;
  if (!lines.has(id)) lines.set(id, taskLine([...items.values()], edges, id));
  return lines.get(id);
};

// Ambient motion: the swell under the canvas and the lights floating on it.
// It sits below attention: a few px of drift over minutes-long loops. It
// pauses under the pointer and while you type, and is off for reduced motion.
// Waves, float and dust each run their own clock, so each has its own speed.
const ambient = {
  t: 0,        // swell (background waves) clock
  ft: 0,       // float clock the lights drift back into phase with
  flow: 1,     // eased clock rate; 0 freezes everything
  waves: 0.8, // background light strength
  drift: 5,   // px of float
  waveSpeed: 1,
  floatSpeed: 1,
  dustSpeed: 2,
};

// How things look, shared with the renderer (render.js LOOK_DEFAULTS).
const look = renderer.look;
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const AMBIENT_FPS = 30;
const EASE_MS = 500;
// The clicked item growing and the rest dimming; a task coming into focus or going out.
const FOCUS_MS = 400;
const LOOK_MS = 250;

// Handle for DevTools and browser tests.
let busy = false;
window.mindPalace = {
  nodes, physics, renderer, view, ambient, focus, music,
  edges: () => edges,
  // The store: `api` changes it (each call resolves once drawn), `state()` reads it.
  api: () => api,
  state: () => new Store(storage.load()).state,
  isIdle: () => !busy,
  travel: (c) => travel(c),
  kick: () => kick(),
  // What a click at a world point would hit (see nodeAt, edgeAt).
  hit: (x, y) => ({ node: nodeAt({ x, y })?.id ?? null, edge: edgeAt({ x, y })?.id ?? null }),
};

// ---- the store ------------------------------------------------------------
// The palace lives in this browser (storage.js); store.js holds the rules.

const storage = new Storage();

// Every change starts from what storage holds (another tab may have moved
// on), is saved, and is drawn at once.
function change(fn, redraw = true) {
  const store = new Store(storage.load());
  store.newDay();
  const out = fn(store);
  const saved = storage.save(store.state);
  if (redraw) applyState(store.state);
  if (!saved && !warnedUnsaved) {
    warnedUnsaved = true;
    alert("This browser is not letting Mind Palace save.\nWhat you add will be gone when this tab closes. Use Backup (in the ≈ panel) to keep it.");
  }
  return out;
}
let warnedUnsaved = false;

// Run after the handler that asked for it has finished, so a redraw never lands mid-gesture.
const later = (fn) => async (...args) => {
  await null;
  return fn(...args);
};

function download(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  Object.assign(document.createElement("a"), { href: url, download: filename }).click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const fileStamp = (d) => `${localDay(d)}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
// The last export stays here too, in case the download went wrong.
const LAST_EXPORT_KEY = "mindPalace.lastExport";

const api = {
  create: later(({ kind, title, ...rest }) => {
    storage.persist();
    return change((s) => s.create(kind, title, rest));
  }),
  patch: later((id, fields) =>
    change((s) => ("canvas" in fields ? s.moveItem(id, fields.canvas) : s.update(id, fields)))),
  remove: later((id) => {
    const went = change((s) => s.delete(id));
    if (typeof went === "string") alert("That canvas still has items.\nMove or delete them first.");
  }),
  unlink: later((id) => change((s) => s.removeEdgesOf(id))),
  createCanvas: later((name, pos) => change((s) => s.createCanvas(name, here, pos))),
  // A whole list (the ≡ box) in one save; no positions, they spread out
  // from the field's middle and the forces settle them.
  createMany: later((entries) => {
    storage.persist();
    return change((s) => {
      for (const { kind, title, importance } of entries) {
        if (kind === "wormhole") s.createCanvas(title, here, null);
        else s.create(kind, title, { importance, canvas: here });
      }
    });
  }),
  renameCanvas: later((id, name) => change((s) => s.renameCanvas(id, name))),
  edge: later((a, b) => change((s) => s.addEdge(a, b))),
  unedge: later((id) => change((s) => s.removeEdge(id))),
  memory: later((slots) => change((s) => s.setMemory(slots))),
  // Not redrawn: the layout on screen is the live one.
  positions: later((positions) => change((s) => s.savePositions(positions), false)),
  exportClear: later(() =>
    change((s) => {
      const now = new Date();
      const markdown = s.exportMarkdown(`${localDay(now)} ${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`);
      try {
        localStorage.setItem(LAST_EXPORT_KEY, markdown);
      } catch {}
      s.clearAll();
      return { filename: `mind-palace-${fileStamp(now)}.md`, markdown };
    })),
  backup: () => {
    const state = new Store(storage.load()).state;
    download(`mind-palace-backup-${fileStamp(new Date())}.json`, JSON.stringify(state, null, 1), "application/json");
  },
  // Merges a backup (or an old canvas.json) in; throws when the file isn't one.
  importState: (json) => change((s) => s.importState(json)),
  logFocus: later(({ itemId, started, ended, minutes }) => change((s) => s.logFocus(itemId, started, ended, minutes))),
  togglePin,
  focus: {
    state: focus,
    itemTitle: (id) => itemAnywhere(id)?.title ?? "",
    start: (id) => startFocus(id),
    pause: () => pauseFocus(),
    resume: () => resumeFocus(),
    stop: () => endFocus(false),
  },
  onClose: () => setFocus(null),
};

const drawer = new Drawer(api);

// ---- geometry -------------------------------------------------------------

// Labels hang to the right of each light, so the field is shifted left a bit
// and kept clear of the canvas name at the bottom.
function updateField() {
  const ax = Math.max(140, renderer.w / 2 - 190);
  const ay = Math.max(120, renderer.h / 2 - 95);
  physics.setField(ax, ay, -50, -10);
  physics.setView(renderer.w, renderer.h);
}
const fieldToWorld = (nx, ny) => {
  const { ax, ay, cx, cy } = physics.axes;
  return { x: cx + nx * ax, y: cy + ny * ay };
};
const toWorld = (e) => ({ x: e.clientX - renderer.w / 2, y: e.clientY - renderer.h / 2 });
const toScreen = (p) => ({ x: p.x + renderer.w / 2, y: p.y + renderer.h / 2 });

// What's under the pointer, in order: a light, then a line (lines often
// pass over labels, and a label is a big target), then a label.
function nodeAt(p) {
  const list = [...nodes.values()].filter((n) => !n.dying).reverse();
  for (const n of list) {
    if (Math.hypot((n.px ?? n.x) - p.x, (n.py ?? n.y) - p.y) < Math.max(n.r + 6, 14)) return n;
  }
  if (edgeAt(p)) return null;
  for (const n of list) {
    const b = n.labelBox;
    if (b && p.x >= b.x0 - 4 && p.x <= b.x1 + 4 && p.y >= b.y0 - 4 && p.y <= b.y1 + 4) return n;
  }
  return null;
}

function edgeAt(p) {
  let best = null;
  let bestD = 7;
  for (const e of edges) {
    const a = nodes.get(e.a);
    const b = nodes.get(e.b);
    if (!a || !b || a.dying || b.dying) continue;
    const c = renderer.edgePath(a, b);
    for (let t = 0; t <= 1; t += 0.02) {
      const u = 1 - t;
      const x = u * u * c.x0 + 2 * u * t * c.cx + t * t * c.x1;
      const y = u * u * c.y0 + 2 * u * t * c.cy + t * t * c.y1;
      const d = Math.hypot(x - p.x, y - p.y);
      if (d < bestD) {
        bestD = d;
        best = e;
      }
    }
  }
  return best;
}

// ---- state → nodes ----------------------------------------------------------

function refreshNode(n) {
  const st = states.get(n.id);
  n.blocked = st?.blocked ?? false;
  n.goal = st?.goal ?? false;
  n.r = MARK_RR * look.size * (1 + (look.selSize - 1) * (n.sel ?? 0));
  // New on screen: start at the resting look, no transition.
  n.fShown ??= n.blocked ? 0 : 1;
  n.doneShown ??= n.item.done ? 1 : 0;
  if (n.item.pinned && n.slot == null) [n.fx, n.fy] = physics.clamp(n, ...n.item.pinned);
  else if (view.dragId !== n.id && !n.held) n.fx = n.fy = null; // held: a door during a drag
}

function spawnPoint(item, slot) {
  if (slot != null) return socketAt(physics.memory, slot, physics.params.memoryRadius);
  if (item.pos) return { x: item.pos[0], y: item.pos[1] };
  const ang = Math.random() * Math.PI * 2;
  const r = 0.15 + 0.2 * Math.random();
  return fieldToWorld(Math.cos(ang) * r, Math.sin(ang) * r);
}

const onCanvas = (item) => (item.canvas ?? HOME) === here;

function wormholeLabel(item, all) {
  const name = canvases[item.target]?.name || (item.target === HOME ? "home" : "unnamed");
  const count = all.filter((i) => i.canvas === item.target && i.kind !== "wormhole").length;
  return count ? `${name} · ${count}` : name;
}

// `instant`: lights appear without fading in (the wormhole transition
// handles their arrival).
function applyState(state, instant = false) {
  const now = performance.now();
  lastState = state;
  canvases = state.canvases ?? canvases;
  if (!canvases[here]) {
    here = HOME;
    history.replaceState(null, "", location.pathname + location.search);
  }
  updatePalette(); // this canvas's hue, and its doors'

  memory = state.memory ?? memory;
  // Items in the pool from other canvases come along as guests.
  const slotOf = new Map(memoryOn ? memory.map((id, i) => [id, i]).filter(([id]) => id) : []);
  const shown = state.items.filter((i) => onCanvas(i) || slotOf.has(i.id));
  for (const item of shown) {
    if (item.kind !== "wormhole") continue;
    item.title = canvases[item.target]?.name ?? "";
    item.label = wormholeLabel(item, state.items);
  }
  items = new Map(shown.map((i) => [i.id, i]));
  edges = state.edges.filter((e) => items.has(e.a) && items.has(e.b));
  // Arrows never cross canvases, so a guest's state comes from its own.
  states = taskStates(state.items, state.edges);
  lines = new Map();
  if (view.focusId && !items.has(view.focusId)) view.focusId = null;
  // A pomodoro on something done or turned into a thought ends here; on
  // something deleted it is dropped, as there is nothing left to log it on.
  const focused = focus.session && itemAnywhere(focus.session.itemId);
  if (focus.session && !focused) {
    focus.set(null);
    music.setFocus(false);
    focusTick();
  } else if (focused && !canFocus(focused)) endFocus(false);

  for (const item of shown) {
    let n = nodes.get(item.id);
    const slot = slotOf.get(item.id) ?? null;
    if (!n) {
      const p = spawnPoint(item, slot);
      n = { id: item.id, x: p.x, y: p.y, vx: 0, vy: 0, born: instant ? now - 10_000 : now };
      nodes.set(item.id, n);
    } else if (n.dying) {
      n.dying = n.sink = null; // came back (e.g. un-done, or into the pool from a wormhole)
    }
    n.slot = slot;
    n.guest = !onCanvas(item);
    n.guestOf = n.guest ? canvases[item.canvas]?.name ?? "" : null;
    if (n.item && (n.item.importance !== item.importance || n.item.kind !== item.kind)) renderer.forget(item.id);
    n.item = item;
    refreshNode(n);
  }
  for (const n of nodes.values()) {
    if (!items.has(n.id) && !n.dying) n.dying = now;
  }

  physics.memory.on = memoryOn;
  syncNodes();
  physics.reheat(0.12);
  renderCanvasName();
  $("hint").classList.toggle("gone", items.size > 0 || !$("capture").hidden);

  if (drawer.isOpen) {
    const item = items.get(drawer.item.id);
    if (item) drawer.render(item, edgeCount(item.id));
    else drawer.close();
  }
  kick();
}

function syncNodes() {
  const alive = [...nodes.values()].filter((n) => !n.dying);
  physics.setNodes([...nodes.values()]);
  const ids = new Set(alive.map((n) => n.id));
  physics.setLinks(
    edges.filter((e) => ids.has(e.a) && ids.has(e.b)).map((e) => ({ source: e.a, target: e.b, id: e.id }))
  );
}

const edgeCount = (id) => edges.filter((e) => e.a === id || e.b === id).length;

// ---- render loop ------------------------------------------------------------

let raf = null;
let lastMoved = 0;
let lastFrame = 0;
let lastDraw = 0;

const approach = (v, target, dt) => v + (target - v) * Math.min(1, dt / EASE_MS);
const stepToward = (v, target, step) => (Math.abs(target - v) <= step ? target : v + Math.sign(target - v) * step);
const ambientOn = () => !reducedMotion.matches
  && (ambient.waveSpeed > 0 || ambient.floatSpeed > 0 || ambient.dustSpeed > 0 || (memoryOn && physics.params.memoryTurn > 0));

// Advance the ambient clocks. Each node keeps its own float (n.t) and dust
// (n.dustT) clocks so the one under the pointer can stand still; `calm`
// lets a dragged one settle onto the swell.
function advanceAmbient(dt) {
  const still = !ambientOn() || !capture.el.hidden;
  ambient.flow = approach(ambient.flow, still ? 0 : 1, dt);
  if (ambient.flow < 0.001) ambient.flow = 0;
  const step = (dt / 1000) * ambient.flow;
  ambient.t += step * ambient.waveSpeed;
  ambient.ft += step * ambient.floatSpeed;
  for (const n of nodes.values()) {
    const held = n.id === view.hoverId || n.id === view.dragId;
    n.flow = approach(n.flow ?? 1, held ? 0 : 1, dt);
    n.calm = approach(n.calm ?? 1, n.id === view.dragId ? 0 : 1, dt);
    n.t = (n.t ?? ambient.ft) + step * ambient.floatSpeed * n.flow;
    n.dustT = (n.dustT ?? 0) + step * ambient.dustSpeed * n.flow;
    // Drift back into phase with the others after being held.
    if (!held) n.t += (ambient.ft - n.t) * Math.min(1, dt / 4000);
  }
  return ambient.flow > 0;
}

// Ease each light's visibility toward what the focus asks. Returns true
// while anything is still easing.
function advanceFocus(dt) {
  const line = lineOf(view.focusId);
  let easing = false;
  let grew = false;
  for (const n of nodes.values()) {
    const want = !line || line.has(n.id) ? 1 : look.focusDim;
    n.vis = approach(n.vis ?? 1, want, dt * (EASE_MS / FOCUS_MS));
    if (Math.abs(n.vis - want) < 0.002) n.vis = want;
    else easing = true;
    // The clicked item grows and its neighbours make room (event motion).
    const sel = n.id === view.focusId ? 1 : 0;
    const before = n.sel ?? 0;
    n.sel = reducedMotion.matches ? sel : approach(before, sel, dt * (EASE_MS / FOCUS_MS));
    if (Math.abs(n.sel - sel) < 0.002) n.sel = sel;
    if (n.sel !== before) {
      n.r = MARK_RR * look.size * (1 + (look.selSize - 1) * n.sel);
      grew = true;
    }
    if (n.sel !== sel) easing = true;
    // A pomodoro's ring fades in and out.
    const ring = focus.on(n.id) ? 1 : 0;
    n.ring = reducedMotion.matches ? ring : approach(n.ring ?? 0, ring, dt);
    if (Math.abs(n.ring - ring) < 0.002) n.ring = ring;
    else easing = true;
    if (ring) {
      n.ringProgress = progress(focus.session, Date.now());
      n.ringPaused = !focus.running;
    }
  }
  if (grew) physics.reheat(0.05);
  return easing;
}

// Ease each task toward its focus and done state: a parent pulls into focus
// when its last sub-task closes, a done mark goes out. Event motion only, so
// reduced motion jumps straight there.
function advanceLooks(dt) {
  let easing = false;
  for (const n of nodes.values()) {
    if (n.item.kind !== "task") continue;
    const done = n.item.done ? 1 : 0;
    const focus = n.blocked ? 0 : 1;
    if (reducedMotion.matches) {
      n.fShown = focus;
      n.doneShown = done;
      continue;
    }
    const step = dt / LOOK_MS;
    n.fShown = stepToward(n.fShown, focus, step);
    n.doneShown = stepToward(n.doneShown, done, step);
    easing ||= n.fShown !== focus || n.doneShown !== done;
  }
  return easing;
}

// The pool fades in and out, and its sockets turn slowly with the ambient
// clock (so not for reduced motion or while typing), holding still while
// something is in hand or a slotted item is under the pointer.
function advancePool(dt) {
  const want = memoryOn ? 1 : 0;
  pool.show = reducedMotion.matches ? want : approach(pool.show, want, dt);
  if (Math.abs(pool.show - want) < 0.002) pool.show = want;
  const m = physics.memory;
  const turn = physics.params.memoryTurn;
  const held = view.dragId || nodes.get(view.hoverId)?.slot != null;
  if (memoryOn && turn > 0 && !held) m.angle += (dt / 1000) * ambient.flow * ((2 * Math.PI) / (turn * 60));
  const R = physics.params.memoryRadius;
  view.pool = pool.show > 0 ? {
    show: pool.show, cx: m.cx, cy: m.cy, R,
    sockets: memory.map((id, i) => ({ ...socketAt(m, i, R), filled: Boolean(id) })),
    open: view.socket, tether: view.tether,
  } : null;
  return pool.show !== want;
}

// Dragging onto the halo opens the nearest free socket (none when full: it
// stays out). A slotted item in hand is tethered to its socket; past the
// halo by MEMORY_BREAK it lets go, unless it is a guest, which always goes back.
function poolDrag(node, p) {
  view.socket = view.tether = null;
  press.release = false;
  if (!memoryOn || node.item.kind === "wormhole") return;
  const m = physics.memory;
  const R = physics.params.memoryRadius;
  if (node.slot != null) {
    const s = socketAt(m, node.slot, R);
    const stretch = (Math.hypot(p.x - m.cx, p.y - m.cy) - R - HALO_CLEAR) / MEMORY_BREAK;
    press.release = !node.guest && stretch > 1;
    if (!press.release) view.tether = { x0: s.x, y0: s.y, x1: p.x, y1: p.y, k: node.guest ? 1 : 1 - Math.max(0, stretch) };
    return;
  }
  if (Math.hypot(p.x - m.cx, p.y - m.cy) > R + HALO_CLEAR) return;
  let best = Infinity;
  memory.forEach((id, i) => {
    if (id) return;
    const s = socketAt(m, i, R);
    const d = Math.hypot(s.x - p.x, s.y - p.y);
    if (d < best) [best, view.socket] = [d, i];
  });
}

// Put an item in a socket (or empty it). Shown at once, saved behind.
function setSlot(i, id) {
  memory = memory.map((m, j) => (j === i ? id : id && m === id ? null : m));
  api.memory(memory);
  if (lastState) applyState({ ...lastState, memory });
}

function setFocus(id) {
  view.focusId = id;
  kick();
}

function openItem(id) {
  const item = items.get(id);
  if (!item) return;
  drawer.open(item, edgeCount(id));
  setFocus(id);
}

// ---- pomodoro ---------------------------------------------------------------------
// One at a time, on a task or question (focus.js). The focus track plays
// while it runs; at the end a soft chime, and the time goes to the
// log (store.js).

const itemAnywhere = (id) => items.get(id) ?? lastState?.items.find((i) => i.id === id);
const focusChip = $("focus-chip");
let openAfterTravel = null;
// ?focusMin=0.1 makes a short pomodoro, for trying it out.
const FOCUS_MIN = Number(new URLSearchParams(location.search).get("focusMin")) || null;
// The focus track's handovers follow the running pomodoro.
music.clock = () => {
  const s = focus.running && focus.session;
  return s ? { elapsed: elapsed(s, Date.now()), total: s.durationMs } : null;
};

function startFocus(id) {
  if (!canFocus(itemAnywhere(id))) return;
  if (focus.session) endFocus(false);
  music.unlock();
  focus.start(id, FOCUS_MIN ?? focus.minutes);
  music.setFocus(true);
  focusTick();
}

function pauseFocus() {
  focus.pause();
  music.setFocus(false);
  focusTick();
}

function resumeFocus() {
  music.unlock();
  focus.resume();
  music.setFocus(true);
  focusTick();
}

// `finished`: the countdown ran out (rather than Stop).
function endFocus(finished) {
  const log = focus.end();
  music.setFocus(false);
  if (finished) music.chime();
  if (log) api.logFocus(log);
  focusTick();
}

// Once a second: the countdown in the card and the chip, and the end.
function focusTick() {
  const s = focus.session;
  if (s && remaining(s, Date.now()) <= 0) return endFocus(true);
  focusChip.hidden = !s;
  if (s) {
    focusChip.textContent = clock(remaining(s, Date.now()));
    focusChip.classList.toggle("paused", !focus.running);
    focusChip.title = `${itemAnywhere(s.itemId)?.title ?? ""} — open it`;
  }
  if (drawer.isOpen) drawer.renderFocus();
  if (focus.running) music.update();
  kick();
}
setInterval(() => focus.session && focusTick(), 1000);

// The chip leads back to the item, through a wormhole if it is elsewhere.
focusChip.addEventListener("click", () => {
  const item = focus.session && itemAnywhere(focus.session.itemId);
  if (!item) return;
  const where = item.canvas ?? HOME;
  if (items.has(item.id)) openItem(item.id); // here, or a guest in the pool
  else {
    openAfterTravel = item.id;
    travel(where);
  }
});

function frame() {
  raf = null;
  const now = performance.now();
  if (view.warp) {
    const { phase } = warpState(view.warp, now);
    if (phase !== "out" && !view.warp.swapped) arrive();
    if (phase === "done") view.warp = null;
  }
  const dt = Math.min(100, lastFrame ? now - lastFrame : 16);
  lastFrame = now;
  const simActive = physics.active;
  physics.step();
  if (simActive) lastMoved = Date.now();
  // The important beat runs at the ambient rate, like the swell.
  renderer.pulseOn = !reducedMotion.matches && capture.el.hidden;
  const flowing = advanceAmbient(dt) || renderer.pulsing;
  const pooling = advancePool(dt);
  const focusing = advanceFocus(dt) || advanceLooks(dt) || pooling;

  // When only the swell moves, draw at a gentle rate to spare the battery.
  if (!simActive && !busy && !focusing && !view.warp && flowing && now - lastDraw < 1000 / AMBIENT_FPS) {
    kick();
    return;
  }
  lastDraw = now;
  view.line = lineOf(view.dragId || view.hoverId || view.focusId);
  const animating = renderer.draw([...nodes.values()], edges, view, now, ambient);
  busy = simActive || animating || focusing;

  let removed = false;
  for (const n of [...nodes.values()]) {
    if (n.dead) {
      nodes.delete(n.id);
      renderer.forget(n.id);
      removed = true;
    }
  }
  if (removed) syncNodes();

  if (busy || flowing) kick();
}

function kick() {
  if (!raf) raf = requestAnimationFrame(frame);
}

// ---- wormholes ------------------------------------------------------------------
// Travelling: dive into the wormhole, swap canvases at the darkest moment,
// then bloom out of the return wormhole on the other side.

function travel(target) {
  if (target === here || view.warp || !canvases[target]) return;
  history.pushState(null, "", target === HOME ? location.pathname + location.search : `#c=${target}`);
  startWarp(target);
}

function startWarp(target) {
  if (target === here) return;
  const door = [...nodes.values()].find((n) => !n.dying && n.item.target === target);
  if (drawer.isOpen) drawer.close();
  view.hoverId = view.selectedEdge = view.focusId = null;
  view.warp = {
    t0: performance.now(),
    params: reducedMotion.matches ? WARP_CALM : WARP,
    from: door ? { x: door.px ?? door.x, y: door.py ?? door.y } : { x: 0, y: 0 },
    to: { x: 0, y: 0 },
    target,
    swapped: false,
  };
  kick();
}

function arrive() {
  const prev = here;
  here = view.warp.target;
  view.warp.swapped = true;
  for (const id of nodes.keys()) renderer.forget(id);
  nodes.clear();
  if (lastState) applyState(lastState, true);
  const back = [...nodes.values()].find((n) => n.item.target === prev);
  if (back) view.warp.to = { x: back.x, y: back.y };
  if (openAfterTravel && items.has(openAfterTravel)) openItem(openAfterTravel);
  openAfterTravel = null;
}

window.addEventListener("popstate", () => {
  const target = canvasFromHash();
  if (view.warp) {
    // Arrived mid-flight: finish where the URL now says.
    view.warp.target = target;
    return;
  }
  startWarp(canvases[target] ? target : HOME);
});

// Persist where things settled, so a reload looks the same.
let lastSaved = 0;
setInterval(() => {
  if (lastMoved <= lastSaved || physics.active) return;
  lastSaved = Date.now();
  const positions = {};
  for (const n of nodes.values()) {
    // Pool items keep where they rest on their canvas.
    if (!n.dying && n.slot == null) positions[n.id] = [Math.round(n.x), Math.round(n.y)];
  }
  api.positions(positions);
}, 10_000);

// ---- palette ------------------------------------------------------------------

// Light or dark on a schedule (config.js theme: light from lightAt, dark from
// dark_at). The ◐ button (top left) picks the other one by hand, and that
// holds, in this browser, until the next switch time.
const THEME_KEY = "mindPalace.theme";
let themeOverride = null; // { theme, until (ms) }
try {
  const saved = JSON.parse(localStorage.getItem(THEME_KEY));
  if (saved?.theme && saved.until) themeOverride = saved;
} catch {}

// ?hour=21 pins the clock the schedule reads (browser checks).
const THEME_HOUR = new URLSearchParams(location.search).get("hour");

function themeClock() {
  const now = new Date();
  const hour = THEME_HOUR == null ? null : Number(THEME_HOUR);
  if (hour != null) now.setHours(Math.floor(hour), Math.round((hour % 1) * 60), 0, 0);
  return now;
}

function themeNow() {
  const now = themeClock();
  const { lightAt, darkAt } = config.theme;
  const scheduled = scheduledTheme(currentHour(now), lightAt, darkAt);
  if (themeOverride && now.getTime() >= themeOverride.until) themeOverride = null;
  return { theme: themeOverride?.theme ?? scheduled, scheduled, next: nextSwitch(now, lightAt, darkAt) };
}

// Each canvas wears its own hue, and a door glows in the colour of the
// canvas it leads to.
function updatePalette() {
  const { theme } = themeNow();
  const p = paletteFor(theme);
  const accentRgb = canvasAccent(canvases[here]?.hue, theme);
  applyPalette({ ...p, accent: toHex(accentRgb), accentRgb });
  renderer.setTheme(theme);
  renderer.doorRgb = (target) => canvasAccent(canvases[target]?.hue, theme).join(", ");
  renderer.setAccent(accentRgb);
  renderer.setBackground(p.bgRgb);
  showTheme?.();
  kick();
}
let showTheme = null;
setInterval(updatePalette, 60_000);
updatePalette(); // before boot, so a light page doesn't open dark

// ---- capture ------------------------------------------------------------------

// cycle: how many times Tab stepped the kind on (see parse.js).
const capture = { el: $("capture"), input: $("capture-input"), kind: $("capture-kind"), pos: null, cycle: 0 };

const captureKind = () => parseCapture(capture.input.value, capture.cycle).kind;

function renderCaptureKind() {
  if (dictation.listening) return;
  const kind = captureKind();
  capture.kind.className = "";
  const next = KINDS[(KINDS.indexOf(kind) + 1) % KINDS.length];
  capture.kind.textContent =
    kind === "wormhole" ? "wormhole to a new canvas · name is optional" : `${kind} · tab for ${next}`;
}

// ---- voice ----------------------------------------------------------------------
// Long-press and keep holding: the ring fills, the input opens, and it listens
// until you let go. The words land in the input for review; Enter saves.

const langButton = $("capture-lang");
let voiceLangs = [];
let voiceLang = null;

const dictation = new Dictation({
  onText(final, interim) {
    capture.input.value = (final + interim).replace(/\s+/g, " ").trimStart();
    capture.input.classList.toggle("interim", Boolean(interim));
  },
  onEnd(error) {
    capture.input.classList.remove("interim");
    capture.input.value = capture.input.value.trim();
    if (!capture.el.hidden) {
      capture.input.focus();
      capture.input.setSelectionRange(capture.input.value.length, capture.input.value.length);
    }
    renderCaptureKind();
    if (error) {
      capture.kind.className = "error";
      capture.kind.textContent = error;
    }
  },
});

function setupVoice(configured) {
  voiceLangs = voiceLanguages(configured);
  voiceLang = loadLang(voiceLangs);
  langButton.hidden = !voiceSupported;
  showLang();
  if (voiceSupported) $("hint").textContent = "hold anywhere to add a thought · keep holding to speak";
}

function startListening() {
  capture.kind.className = "listening";
  capture.kind.textContent = "listening… release to stop";
  ring.classList.add("listening");
  dictation.start(voiceLang);
}

// Keep focus in the input while switching, or the blur handler would save.
langButton.addEventListener("pointerdown", (e) => e.preventDefault());
langButton.addEventListener("click", nextLang);

// The capture's and the list box's language tags are one setting.
function showLang() {
  for (const b of document.querySelectorAll("button.lang")) b.textContent = voiceLang.slice(0, 2).toUpperCase();
}

function nextLang() {
  voiceLang = voiceLangs[(voiceLangs.indexOf(voiceLang) + 1) % voiceLangs.length];
  saveLang(voiceLang);
  showLang();
}

function openCapture(p) {
  capture.pos = p;
  capture.cycle = 0;
  capture.input.value = "";
  const s = toScreen(p);
  // Start just right of the press ring, so it never covers the words.
  capture.el.style.left = Math.min(s.x + 30, renderer.w - 320) + "px";
  capture.el.style.top = s.y + "px";
  capture.el.hidden = false;
  $("hint").classList.add("gone");
  renderCaptureKind();
  capture.input.focus();
}

function closeCapture() {
  capture.el.hidden = true;
  capture.input.blur();
  $("hint").classList.toggle("gone", items.size > 0);
  kick(); // the swell was frozen while typing
}

async function submitCapture() {
  const text = capture.input.value;
  const pos = capture.pos;
  const cycle = capture.cycle;
  closeCapture();
  const { kind, title, importance } = parseCapture(text, cycle);
  if (!title && kind !== "wormhole") return;
  if (kind === "wormhole") await api.createCanvas(title, [pos.x, pos.y]);
  else await api.create({ kind, title, importance, pos: [pos.x, pos.y], canvas: here });
}

capture.input.addEventListener("input", renderCaptureKind);
capture.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    submitCapture();
  } else if (e.key === "Escape") {
    closeCapture();
  } else if (e.key === "Tab") {
    e.preventDefault();
    capture.cycle += 1;
    renderCaptureKind();
  }
});
// Losing a typed thought is the worst outcome, so clicking away saves it.
capture.input.addEventListener("blur", () => {
  if (!capture.el.hidden && capture.input.value.trim()) submitCapture();
  else if (!capture.el.hidden) closeCapture();
});

// ---- pointer --------------------------------------------------------------------

const ring = $("press-ring");
ring.style.setProperty("--press-ms", PRESS_MS + "ms");
let press = null; // { mode, start, node, timer }
let clickTimer = null;
let lastPointer = { x: 0, y: 0 };

function showRing(e) {
  ring.style.left = e.clientX + "px";
  ring.style.top = e.clientY + "px";
  ring.hidden = false;
  ring.classList.remove("filling");
  void ring.offsetWidth; // restart the transition
  ring.classList.add("filling");
}

function hideRing() {
  ring.hidden = true;
  ring.classList.remove("filling", "listening");
}

canvas.addEventListener("pointerdown", (e) => {
  if (e.button !== 0 || view.warp) return;
  if (!capture.el.hidden) return; // the blur handler is saving it
  const p = toWorld(e);
  const hit = nodeAt(p);
  canvas.setPointerCapture(e.pointerId);

  if (hit && e.shiftKey) {
    press = { mode: "link", start: p, node: hit };
    view.link = { from: hit, x: p.x, y: p.y };
  } else if (hit) {
    // Held where it was grabbed (its label, say), so it doesn't jump.
    const grab = { x: (hit.px ?? hit.x) - p.x, y: (hit.py ?? hit.y) - p.y };
    press = { mode: "node", start: p, node: hit, grab };
  } else {
    press = { mode: "empty", start: p, edge: edgeAt(p) };
    showRing(e);
    press.timer = setTimeout(() => {
      if (drawer.isOpen) drawer.close();
      openCapture(p);
      if (voiceSupported) {
        press.mode = "voice"; // still holding: listen until release
        startListening();
      } else {
        hideRing();
        press = null;
      }
    }, PRESS_MS);
  }
  kick();
});

canvas.addEventListener("pointermove", (e) => {
  const p = toWorld(e);
  lastPointer = p;
  if (!press) {
    const hit = nodeAt(p);
    const id = hit ? hit.id : null;
    canvas.style.cursor = hit ? "pointer" : edgeAt(p) ? "pointer" : "default";
    if (id !== view.hoverId) {
      view.hoverId = id;
      kick();
    }
    return;
  }
  const moved = Math.hypot(p.x - press.start.x, p.y - press.start.y);
  if (press.mode === "empty" && moved > MOVE_TOLERANCE) {
    clearTimeout(press.timer);
    hideRing();
    press = null;
  } else if (press.mode === "node" && moved > MOVE_TOLERANCE) {
    press.mode = "drag";
    view.dragId = press.node.id;
    physics.dragging(true, press.node);
  }
  if (press?.mode === "drag") {
    const q = grabbed(p, press);
    [q.x, q.y] = physics.clamp(press.node, q.x, q.y); // the pointer may leave, the item stays in
    press.node.fx = q.x;
    press.node.fy = q.y;
    poolDrag(press.node, q);
    // Over a wormhole: its ring opens to take the item (not a guest's: it
    // can only leave the pool on its own canvas).
    const under = press.node.item.kind === "wormhole" || press.node.guest || view.socket != null ? null : wormholeAt(q, press.node);
    view.dropId = under ? under.id : null;
    kick();
  } else if (press?.mode === "link") {
    view.link.x = p.x;
    view.link.y = p.y;
    const hit = nodeAt(p);
    view.hoverId = hit && hit !== press.node ? hit.id : null;
    kick();
  }
});

// Where a dragged item's mark is: the pointer plus where it was grabbed.
const grabbed = (p, pr) => (pr.grab ? { x: p.x + pr.grab.x, y: p.y + pr.grab.y } : p);

function endPress(e) {
  if (!press) return;
  const { mode, node, release } = press;
  let p = toWorld(e);
  if (mode === "drag") {
    p = grabbed(p, press);
    [p.x, p.y] = physics.clamp(node, p.x, p.y);
  }
  clearTimeout(press.timer);
  hideRing();
  press = null;

  if (mode === "voice") {
    dictation.stop();
  } else if (mode === "empty") {
    view.selectedEdge = e.type === "pointerup" ? edgeAt(p)?.id ?? null : null;
    if (!view.selectedEdge) {
      if (drawer.isOpen) drawer.close();
      setFocus(null);
    }
  } else if (mode === "node" && node.item.kind === "wormhole") {
    travel(node.item.target);
  } else if (mode === "node") {
    clearTimeout(clickTimer);
    // A click focuses the item and opens its details card.
    clickTimer = setTimeout(() => {
      view.selectedEdge = null;
      openItem(node.id);
    }, CLICK_DELAY_MS);
  } else if (mode === "drag") {
    physics.dragging(false);
    view.dragId = null;
    const door = view.dropId && nodes.get(view.dropId);
    const socket = view.socket;
    view.dropId = view.socket = view.tether = null;
    if (door) {
      // Into the wormhole: it swirls away and lands on that canvas.
      node.fx = node.fy = null;
      node.sink = { x: door.px, y: door.py };
      node.dying = performance.now();
      items.delete(node.id);
      api.patch(node.id, { canvas: door.item.target });
    } else if (socket != null) {
      node.fx = node.fy = null;
      setSlot(socket, node.id);
    } else if (node.slot != null && !release) {
      node.fx = node.fy = null; // springs back into its socket
    } else if (node.slot != null && node.item.pinned) {
      setSlot(node.slot, null);
      node.item.pinned = [p.x, p.y];
      api.patch(node.id, { pinned: [Math.round(p.x), Math.round(p.y)] });
    } else if (node.item.pinned) {
      // Moving is not an edit, so `touched` stays.
      node.item.pinned = [p.x, p.y];
      api.patch(node.id, { pinned: [Math.round(p.x), Math.round(p.y)] });
    } else {
      if (node.slot != null) setSlot(node.slot, null);
      node.fx = node.fy = null;
      api.patch(node.id, { pos: [Math.round(p.x), Math.round(p.y)] });
    }
  } else if (mode === "link") {
    const target = nodeAt(p);
    view.link = null;
    view.hoverId = null;
    if (target && target !== node) api.edge(node.id, target.id);
  }
  kick();
}

canvas.addEventListener("pointerup", endPress);
canvas.addEventListener("pointercancel", endPress);
canvas.addEventListener("pointerleave", () => {
  if (view.hoverId && !press) {
    view.hoverId = null;
    kick();
  }
});

function wormholeAt(p, except) {
  for (const n of nodes.values()) {
    if (n === except || n.dying || n.item.kind !== "wormhole") continue;
    if (Math.hypot(n.px - p.x, n.py - p.y) < Math.max(n.r + 8, 22)) return n;
  }
  return null;
}

// Right-click a wormhole to rename (its canvas) or delete it.
canvas.addEventListener("contextmenu", (e) => {
  const hit = nodeAt(toWorld(e));
  if (!hit || hit.item.kind !== "wormhole") return;
  e.preventDefault();
  clearTimeout(clickTimer);
  drawer.open(hit.item, edgeCount(hit.id));
});

canvas.addEventListener("dblclick", (e) => {
  const hit = nodeAt(toWorld(e));
  if (!hit || hit.item.kind === "wormhole") return;
  clearTimeout(clickTimer);
  togglePin(hit.id);
});

function toggleDone(id) {
  const item = id && items.get(id);
  if (!item || item.kind !== "task") return; // only tasks can be done
  api.patch(id, { done: !item.done });
}

function togglePin(id) {
  const n = nodes.get(id);
  if (!n) return;
  if (n.item.pinned) {
    n.item.pinned = null;
    n.fx = n.fy = null;
    api.patch(id, { pinned: null });
  } else {
    n.item.pinned = [n.x, n.y];
    n.fx = n.x;
    n.fy = n.y;
    api.patch(id, { pinned: [Math.round(n.x), Math.round(n.y)] });
  }
  physics.reheat(0.05);
  kick();
}

// ---- keyboard ---------------------------------------------------------------------

window.addEventListener("keydown", (e) => {
  const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
  if (e.key === "Escape") {
    if (drawer.isOpen) drawer.close();
    view.focusId = view.selectedEdge = null;
    kick();
    return;
  }
  if (typing) return;
  // The focused item, as its details card shows it.
  const open = drawer.isOpen && drawer.item.id === view.focusId ? drawer.item : null;
  if ((e.key === "Delete" || e.key === "Backspace") && view.selectedEdge) {
    api.unedge(view.selectedEdge);
    view.selectedEdge = null;
  } else if (e.key === "Delete" && open) {
    // Like the card's button: the first press asks, the second deletes.
    $("d-delete").click();
  } else if (e.key === "Tab" && open && open.kind !== "wormhole") {
    // The same steps as Tab while typing; Shift goes back.
    e.preventDefault();
    const step = e.shiftKey ? KINDS.length - 1 : 1;
    drawer.save({ kind: KINDS[(KINDS.indexOf(open.kind) + step) % KINDS.length] });
  } else if (e.key === "n" && !e.metaKey && !e.ctrlKey) {
    e.preventDefault();
    openCapture(lastPointer);
  } else if (e.key === "x" && !e.metaKey && !e.ctrlKey) {
    toggleDone(view.focusId ?? view.hoverId);
  }
});

// ---- canvas name ------------------------------------------------------------------
// The name of the canvas on screen, at the bottom; click to edit it.

const nameEl = $("canvas-name");

function renderCanvasName() {
  if (document.activeElement === nameEl) return;
  nameEl.value = canvases[here]?.name ?? "";
  nameEl.placeholder = here === HOME ? "home" : "unnamed canvas";
}

function saveCanvasName() {
  const name = nameEl.value.trim();
  if (name === (canvases[here]?.name ?? "")) return;
  // On failure show the name that is really saved, not the typed one.
  api.renameCanvas(here, name).catch((err) => {
    console.warn(err);
    renderCanvasName();
  });
}

nameEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter") nameEl.blur();
  else if (e.key === "Escape") {
    nameEl.value = canvases[here]?.name ?? "";
    nameEl.blur();
  }
  e.stopPropagation();
});
nameEl.addEventListener("blur", () => {
  saveCanvasName();
  renderCanvasName();
});

// ---- start -------------------------------------------------------------------------

// A new day lets go of the tasks done before it.
setInterval(() => {
  const store = new Store(storage.load());
  if (!store.newDay()) return;
  storage.save(store.state);
  applyState(store.state);
}, 60_000);

function boot() {
  music.sources = config.music;
  setupVoice(config.voiceLangs);
  setupMusic();
  updatePalette();
  change(() => {});
  // Another tab changed the palace: follow it.
  storage.onChange((state) => applyState(state));
}

// Sliders for the sound, the look, the ambient motion and the physics,
// behind the faint ≈ button (top left), in groups that open one at a time.
// Each group shows the sliders worth reaching for; the rest wait behind
// its "more" fold. Pointing at a row explains it in the line at the
// bottom. Values are remembered in this browser; ?tune opens the panel
// and e.g. ?waves=0.2&repel=200 sets values from the link.
const TUNE_KEY = "mindPalace.ambient";
const TUNE_OPEN_KEY = "mindPalace.tuneOpen";
const LEGACY_DUST = 1.2;
const MOTION = (({ waves, drift, waveSpeed, floatSpeed, dustSpeed }) => ({ waves, drift, waveSpeed, floatSpeed, dustSpeed }))(ambient);
// Where each slider's value lives, and its default.
const TUNE_TARGETS = [[ambient, MOTION], [look, LOOK_DEFAULTS], [physics.params, FORCE_DEFAULTS], [music.levels, SOUND_DEFAULTS]];
const tuneTarget = (key) => TUNE_TARGETS.find(([, defaults]) => key in defaults);
// [id, title, sliders always shown, sliders behind "more"]; a slider is
// [key, label, min, max, step, unit, hint].
const TUNE_GROUPS = [
  ["sound", "Sound", [
    ["base", "base", 0, 1, 0.05, "", "Volume of the base noise (♪, top left). It carries on into a pomodoro."],
    ["focus", "focus", 0, 1, 0.05, "", "Volume of the pad that comes in during a pomodoro."],
    ["chime", "chime", 0, 1, 0.05, "", "Volume of the soft chime when a pomodoro ends. 0 = silent."],
  ], [
    ["colour", "noise colour", 0, 2, 1, "", "0 brown (deepest), 1 pink, 2 white (hiss)."],
    ["baseTone", "noise tone", 200, 4000, 50, "Hz", "The noise's low-pass. Lower is darker and softer."],
    ["padTone", "pad tone", 200, 4000, 50, "Hz", "The pad's low-pass once it is in; it rises there from the noise tone. Above 1000 lets the whole wobbling band through."],
    ["rate", "wobble", 4, 30, 1, "Hz", "How fast the pad's volume wobbles. 16 Hz (beta) helped listeners with ADHD symptoms in Woods 2024."],
    ["depth", "wobble depth", 0, 1, 0.05, "", "How far the wobble dips the pad, only between 200 Hz and 1 kHz. 0 = off. High starts to buzz."],
    ["padIn", "pad in", 0, 180, 5, "s", "Time for the pad to come in at the start of a pomodoro."],
    ["padOut", "pad out", 0, 300, 5, "s", "Time before the end that the pad starts handing back to the noise."],
  ]],
  ["look", "Look", [
    ["size", "size", 0.6, 2, 0.05, "", "Size of every mark. All kinds stay the same size."],
    ["labels", "labels", 0.2, 1, 0.05, "", "How bright the labels are."],
    ["edges", "arrows", 0, 0.6, 0.01, "", "How bright the arrows are (the hovered one is always clear)."],
    ["glow", "task glow", 0, 2.5, 0.05, "", "The halo around a doable task, the brightest thing on the canvas."],
  ], [
    ["blur", "blocked blur", 0, 2, 0.05, "", "How soft a task with open sub-tasks is."],
    ["blockedLight", "blocked light", 0, 2, 0.05, "", "How bright a task with open sub-tasks is."],
    ["cross", "goal peak", 0, 2.5, 0.05, "", "The small peak above a goal, a task at the top of its tree."],
    ["question", "question", 0, 2, 0.05, "", "How bright a question's \"?\" is."],
    ["dustLight", "dust", 0, 2.5, 0.05, "", "How bright a thought's dust is."],
    ["wormhole", "wormhole", 0, 3, 0.05, "", "How bright a wormhole's hollow light is."],
  ]],
  ["motion", "Motion", [
    ["waves", "waves", 0, 1, 0.01, "", "How bright the faint waves under the canvas are."],
    ["drift", "drift", 0, 24, 0.5, "px", "How far the lights float on the waves."],
  ], [
    ["waveSpeed", "wave speed", 0, 20, 0.1, "", "How fast the faint waves under the canvas roll. 0 holds them still."],
    ["floatSpeed", "float speed", 0, 20, 0.1, "", "How fast the lights float in their small loops. 0 holds them still."],
    ["dustSpeed", "dust speed", 0, 30, 0.1, "", "How fast a thought's dust drifts. 0 holds it still."],
  ]],
  ["selection", "Selection", [
    ["selSize", "clicked size", 1, 2.5, 0.05, "×", "How much bigger the clicked item grows."],
    ["focusDim", "dim the rest", 0, 1, 0.05, "", "How visible everything else stays while one item is open."],
  ], [
    ["selTicks", "corner ticks", 0, 2, 0.05, "", "Brightness of the four corner ticks around the clicked item. 0 hides them."],
  ]],
  ["signals", "Signals", [
    ["pulse", "pulse", 0, 2, 0.05, "", "Strength of the pulse on important (!1) tasks. 0 turns it off."],
    ["focusRing", "pomodoro ring", 0, 2, 0.05, "", "The ring that fills around an item during a pomodoro, and the bead at its head. 0 hides them."],
  ], [
    ["pulseSec", "pulse length", 0.6, 6, 0.1, "s", "Length of one beat. Longer is calmer."],
    ["doneLabel", "done label", 0, 1, 0.05, "", "How bright a done task's label stays."],
  ]],
  ["memory", "Active memory", [
    ["pool", "halo light", 0, 4, 0.05, "", "How visible the active memory halo and its empty sockets are (◎, top left)."],
    ["memoryRadius", "halo size", 40, 200, 5, "px", "Radius of the halo, where its items ride."],
    ["memoryTurn", "halo turn", 0, 10, 0.1, "min", "Time for the halo to go round once. 0 holds it still."],
  ], [
    ["memoryPush", "halo push", 0, 3, 0.05, "", "How hard the halo keeps other items (and their labels) out."],
  ]],
  ["layout", "Layout", [
    ["linkDistance", "link length", 40, 320, 5, "px", "Rest length of an arrow's spring."],
    ["repel", "repel", 0, 500, 5, "", "How hard every item pushes the others away."],
    ["spacing", "spacing", 0, 40, 1, "px", "Empty space kept around every item."],
  ], [
    ["center", "centre pull", 0, 3, 0.05, "", "Pull toward the middle, so the graph holds together."],
    ["linkStrength", "link pull", 0, 2, 0.05, "", "How hard arrows pull their two items together."],
    ["tilt", "arrow tilt", 0, 2, 0.05, "", "How hard arrows lift goals above their sub-tasks."],
    ["labelPush", "label push", 0, 3, 0.05, "", "How hard labels push other lights and labels off their text (arrows may pass under)."],
    ["edgeRoom", "edge room", 0, 80, 1, "px", "Space kept clear inside the window's edges. Items, labels and arrows stay within."],
  ]],
  // Only on paper: the stylesheet hides it in dark mode, where it does nothing.
  ["paper", "Paper", [
    ["grain", "grain", 0, 2, 0.05, "", "The paper's faint grain. 0 is smooth paper."],
  ], [
    ["shade", "wave shade", 0, 2, 0.05, "", "The shaded side of the waves on paper. 0 leaves only their light."],
  ]],
];

const tuneValue = (value, step, unit) => {
  const digits = String(step).split(".")[1]?.length ?? 0;
  const text = String(+Number(value).toFixed(digits));
  return unit ? `${text} ${unit}` : text;
};

function setupTuning() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(TUNE_KEY)) || {};
  } catch {}
  // Saved before the speeds were split: one `speed` scaled every clock.
  if (typeof saved.speed === "number") {
    const { speed, dust = LEGACY_DUST } = saved;
    Object.assign(saved, { waveSpeed: speed, floatSpeed: speed, dustSpeed: speed * dust });
    if (typeof saved.memoryTurn === "number" && speed > 0) saved.memoryTurn /= speed;
  }
  // Saved before the focus pad: those base and focus volumes were for other sounds.
  if (typeof saved.base === "number" && typeof saved.padTone !== "number") delete saved.base, delete saved.focus;
  const params = new URLSearchParams(location.search);
  for (const [target, defaults] of TUNE_TARGETS) {
    for (const key of Object.keys(defaults)) {
      if (params.has(key)) target[key] = Number(params.get(key)) || 0;
      else if (typeof saved[key] === "number") target[key] = saved[key];
    }
  }
  physics.setParams({});
  const save = () => {
    const all = {};
    for (const [target, defaults] of TUNE_TARGETS) for (const key of Object.keys(defaults)) all[key] = target[key];
    try {
      localStorage.setItem(TUNE_KEY, JSON.stringify(all));
    } catch {}
  };
  const resize = () => {
    for (const n of nodes.values()) if (!n.dying) refreshNode(n);
    physics.reheat(0.2);
  };
  const changed = (targets) => {
    if (targets.has(physics.params)) physics.setParams({});
    if (targets.has(look)) resize();
    if (targets.has(music.levels)) music.update();
    save();
    kick();
  };

  const toggle = Object.assign(document.createElement("button"), {
    id: "tune-toggle", className: "ghost", textContent: "≈", title: "Sound, look, motion and layout",
  });
  toggle.setAttribute("aria-label", "Sound, look, motion and layout");
  const panel = document.createElement("div");
  panel.id = "tune";
  panel.hidden = !params.has("tune");

  // One quiet line at the bottom says what the row under the pointer (or
  // keyboard focus) does; works on touch, unlike title tooltips.
  const IDLE_HINT = "Point at a slider to see what it does. Double-click a value to reset it.";
  const hint = Object.assign(document.createElement("div"), { className: "tune-hint", textContent: IDLE_HINT });
  const showHint = (text) => () => (hint.textContent = text || IDLE_HINT);
  // Back to idle only on leaving the panel, so the text doesn't flicker
  // through the idle line in the gaps between rows.
  panel.addEventListener("pointerleave", showHint(""));

  // The open group is remembered in this browser; none at first.
  let openId = null;
  try {
    openId = localStorage.getItem(TUNE_OPEN_KEY);
  } catch {}
  const groups = [];
  // A changed slider and its group wear a small accent dot; the group's ↺
  // shows only then.
  const refresh = () => {
    for (const g of groups) {
      let any = false;
      for (const s of g.sliders) {
        const [target, defaults] = tuneTarget(s.key);
        s.input.value = target[s.key];
        s.out.textContent = tuneValue(target[s.key], s.step, s.unit);
        const off = target[s.key] !== defaults[s.key];
        s.row.classList.toggle("changed", off);
        any ||= off;
      }
      g.el.classList.toggle("changed", any);
      g.reset.hidden = !any;
    }
  };
  const setOpen = (id) => {
    openId = id;
    for (const g of groups) {
      const open = g.id === id;
      g.el.classList.toggle("open", open);
      g.head.setAttribute("aria-expanded", String(open));
      g.body.hidden = !open;
    }
    try {
      if (id) localStorage.setItem(TUNE_OPEN_KEY, id);
      else localStorage.removeItem(TUNE_OPEN_KEY);
    } catch {}
  };
  const resetKeys = (keys) => {
    const targets = new Set();
    for (const key of keys) {
      const [target, defaults] = tuneTarget(key);
      target[key] = defaults[key];
      targets.add(target);
    }
    changed(targets);
    refresh();
  };

  const sliderRow = (g, [key, label, min, max, step, unit, about]) => {
    const [target] = tuneTarget(key);
    const row = Object.assign(document.createElement("label"), { className: "tune-row" });
    row.addEventListener("pointerenter", showHint(about));
    const name = Object.assign(document.createElement("span"), { className: "tune-name", textContent: label });
    const input = Object.assign(document.createElement("input"), { type: "range", min, max, step });
    const out = Object.assign(document.createElement("output"), { title: "Double-click to reset" });
    input.addEventListener("input", () => {
      target[key] = Number(input.value);
      changed(new Set([target]));
      refresh();
    });
    out.addEventListener("dblclick", (e) => {
      e.preventDefault();
      resetKeys([key]);
    });
    input.addEventListener("focus", showHint(about));
    input.addEventListener("blur", showHint(""));
    input.setAttribute("aria-description", about);
    row.append(name, input, out);
    g.sliders.push({ key, step, unit, row, input, out });
    return row;
  };

  for (const [id, title, shown, more] of TUNE_GROUPS) {
    const el = Object.assign(document.createElement("section"), { className: "tune-group", id: `tune-${id}` });
    const top = Object.assign(document.createElement("div"), { className: "tune-top" });
    const head = Object.assign(document.createElement("button"), { className: "tune-head", type: "button" });
    head.append(
      Object.assign(document.createElement("span"), { className: "tune-chev", textContent: "›" }),
      Object.assign(document.createElement("span"), { className: "tune-title", textContent: title }),
      Object.assign(document.createElement("span"), { className: "tune-dot" }),
    );
    const reset = Object.assign(document.createElement("button"), { className: "tune-reset", type: "button", textContent: "↺", hidden: true });
    reset.title = `Reset ${title.toLowerCase()}`;
    reset.setAttribute("aria-label", reset.title);
    reset.addEventListener("pointerenter", showHint(`Back to the defaults for ${title.toLowerCase()}.`));
    top.append(head, reset);
    const body = Object.assign(document.createElement("div"), { className: "tune-body" });
    const g = { id, el, head, reset, body, sliders: [] };
    head.addEventListener("click", () => setOpen(openId === id ? null : id));
    reset.addEventListener("click", () => resetKeys(g.sliders.map((s) => s.key)));
    if (id === "sound") body.append(soundModes(showHint));
    for (const s of shown) body.append(sliderRow(g, s));
    if (more.length) {
      const extra = Object.assign(document.createElement("div"), { className: "tune-extra", hidden: true });
      for (const s of more) extra.append(sliderRow(g, s));
      const fold = Object.assign(document.createElement("button"), { className: "tune-fold", type: "button" });
      const label = () => (fold.textContent = extra.hidden ? `${more.length} more` : "fewer");
      fold.setAttribute("aria-expanded", "false");
      fold.addEventListener("click", () => {
        extra.hidden = !extra.hidden;
        fold.setAttribute("aria-expanded", String(!extra.hidden));
        label();
      });
      label();
      body.append(extra, fold);
    }
    el.append(top, body);
    groups.push(g);
    panel.append(el);
  }

  const foot = Object.assign(document.createElement("div"), { className: "tune-foot" });
  const resetAll = Object.assign(document.createElement("button"), { className: "ghost", type: "button", textContent: "Reset all" });
  resetAll.addEventListener("click", () => {
    for (const [target, defaults] of TUNE_TARGETS) Object.assign(target, defaults);
    try {
      localStorage.removeItem(TUNE_KEY);
    } catch {}
    physics.setParams({});
    setSoundMode(SOUND_MODES[0][0]);
    resize();
    kick();
    refresh();
  });
  // The palace lives in this browser: Backup saves it all as a file, Import
  // merges such a file (or an old canvas.json) in, to move between browsers.
  const backup = Object.assign(document.createElement("button"), {
    id: "backup", className: "ghost", type: "button", textContent: "Backup", title: "Save the whole palace as a file; nothing is cleared",
  });
  backup.addEventListener("click", () => api.backup());
  const picker = Object.assign(document.createElement("input"), { id: "import-file", type: "file", accept: ".json,application/json", hidden: true });
  const importer = Object.assign(document.createElement("button"), {
    id: "import", className: "ghost", type: "button", textContent: "Import", title: "Add a backup file to this palace; nothing here is replaced",
  });
  importer.addEventListener("click", () => picker.click());
  picker.addEventListener("change", async () => {
    const file = picker.files[0];
    picker.value = "";
    if (!file) return;
    try {
      const added = api.importState(JSON.parse(await file.text()));
      importer.textContent = `Imported ${added}`;
      physics.reheat(0.3);
    } catch (err) {
      console.warn(err);
      importer.textContent = "Not a backup";
    }
    setTimeout(() => (importer.textContent = "Import"), ARM_MS);
  });
  foot.append(backup, importer, picker, resetAll);
  const bottom = Object.assign(document.createElement("div"), { className: "tune-bottom" });
  bottom.append(hint, foot);
  panel.append(bottom);
  setOpen(openId);
  refresh();

  toggle.addEventListener("click", () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) closeBulk?.(); // one panel at a time, they share the corner
  });
  document.body.append(toggle, panel);
}

// What plays during a pomodoro (music.js SOUND_MODES): a row of small
// buttons at the top of the Sound section; remembered in this browser.
const SOUND_KEY = "mindPalace.sound";
try {
  const mode = localStorage.getItem(SOUND_KEY);
  if (SOUND_MODES.some(([m]) => m === mode)) music.mode = mode;
} catch {}
const modeButtons = new Map();

function setSoundMode(mode) {
  music.mode = mode;
  try {
    localStorage.setItem(SOUND_KEY, mode);
  } catch {}
  for (const [m, b] of modeButtons) b.setAttribute("aria-pressed", String(m === mode));
  music.update();
}

function soundModes(showHint) {
  const row = Object.assign(document.createElement("div"), { className: "tune-modes" });
  row.setAttribute("role", "group");
  row.setAttribute("aria-label", "During a pomodoro");
  for (const [mode, label, about] of SOUND_MODES) {
    const b = Object.assign(document.createElement("button"), { className: "ghost", textContent: label });
    b.setAttribute("aria-pressed", String(music.mode === mode));
    b.setAttribute("aria-description", about);
    b.addEventListener("pointerenter", showHint(`During a pomodoro: ${about}`));
    b.addEventListener("click", () => setSoundMode(mode));
    modeButtons.set(mode, b);
    row.append(b);
  }
  return row;
}

// ♪ (top left) turns all music on and off, a pomodoro's too (not its
// chime); remembered. Sound may only start after a click, so a remembered
// "on" waits for the first one.
const MUSIC_KEY = "mindPalace.music";

function setupMusic() {
  const button = Object.assign(document.createElement("button"), {
    id: "music-toggle", className: "ghost", textContent: "♪", title: "Music",
  });
  button.setAttribute("aria-label", "Music");
  let on = false;
  try {
    on = localStorage.getItem(MUSIC_KEY) === "on";
  } catch {}
  const show = () => {
    button.classList.toggle("on", on);
    button.setAttribute("aria-pressed", String(on));
  };
  button.addEventListener("click", () => {
    on = !on;
    try {
      localStorage.setItem(MUSIC_KEY, on ? "on" : "off");
    } catch {}
    music.setOn(on);
    music.unlock();
    show();
  });
  music.setOn(on);
  // A pomodoro left running across a reload brings its track back too.
  music.setFocus(focus.running);
  if (on) window.addEventListener("pointerdown", () => music.unlock(), { once: true });
  show();
  document.body.append(button);
}

// ◎ (top left) shows the active memory pool; remembered in this browser.
// What's in it is in the store, so it is all still there next time.
const MEMORY_KEY = "mindPalace.memory";

function setupMemory() {
  const button = Object.assign(document.createElement("button"), {
    id: "memory-toggle", className: "ghost", textContent: "◎", title: "Active memory",
  });
  button.setAttribute("aria-label", "Active memory");
  try {
    memoryOn = localStorage.getItem(MEMORY_KEY) === "on";
  } catch {}
  const show = () => {
    button.classList.toggle("on", memoryOn);
    button.setAttribute("aria-pressed", String(memoryOn));
  };
  button.addEventListener("click", () => {
    memoryOn = !memoryOn;
    try {
      localStorage.setItem(MEMORY_KEY, memoryOn ? "on" : "off");
    } catch {}
    if (lastState) applyState(lastState);
    physics.reheat(0.3);
    show();
  });
  show();
  document.body.append(button);
}

// ≡ (top left) opens a box for a whole list at once: one item per line, in
// the capture syntax, typed, pasted or spoken (each pause a new line).
// Ctrl+Enter adds them all. Closing it adds nothing, but the draft stays
// for next time: typed words are never lost.
const BULK_DRAFT_KEY = "mindPalace.bulkDraft";
let closeBulk = null;

function setupBulk() {
  const label = "Add a list";
  const button = Object.assign(document.createElement("button"), {
    id: "bulk-toggle", className: "ghost", textContent: "≡", title: label,
  });
  button.setAttribute("aria-label", label);
  const panel = Object.assign(document.createElement("div"), { id: "bulk", hidden: true });
  const box = Object.assign(document.createElement("textarea"), {
    rows: 8,
    spellcheck: false,
    placeholder: "one per line\nt task · ? question · a: artifact · !1 important",
  });
  box.setAttribute("aria-label", "Items, one per line");
  const status = Object.assign(document.createElement("span"), { className: "bulk-status" });
  const mic = Object.assign(document.createElement("button"), {
    className: "ghost bulk-mic", type: "button", textContent: "speak", title: "Dictate: each pause starts a new line",
  });
  const lang = Object.assign(document.createElement("button"), {
    className: "lang", type: "button", title: "Dictation language — click to switch",
  });
  const add = Object.assign(document.createElement("button"), { type: "button", textContent: "Add" });
  const cancel = Object.assign(document.createElement("button"), { className: "ghost", type: "button", textContent: "Close" });
  const meta = Object.assign(document.createElement("div"), { className: "bulk-meta" });
  const actions = Object.assign(document.createElement("div"), { className: "bulk-actions" });
  actions.append(mic, lang, add, cancel);
  meta.append(status);
  panel.append(box, meta, actions);

  let cycle = 0; // Tab steps the kind of every plain line, as in capture
  let base = ""; // what was there before dictation started

  const saveDraft = () => {
    try {
      if (box.value.trim()) localStorage.setItem(BULK_DRAFT_KEY, box.value);
      else localStorage.removeItem(BULK_DRAFT_KEY);
    } catch {}
  };

  const showCount = () => {
    if (dictation.listening) return;
    status.className = "bulk-status";
    const entries = parseList(box.value, cycle);
    if (!entries.length) {
      status.textContent = "Ctrl+Enter adds · Tab steps the kind";
      return;
    }
    const counts = new Map();
    for (const e of entries) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
    const kinds = [...counts].map(([k, n]) => `${n} ${n === 1 ? k : k + "s"}`).join(", ");
    status.textContent = `${kinds} · Ctrl+Enter adds`;
  };

  const dictation = new Dictation({
    onText(final, interim, phrases) {
      const lines = [...phrases];
      if (interim.trim()) lines.push(interim.trim());
      box.value = base + lines.join("\n");
      box.classList.toggle("interim", Boolean(interim.trim()));
      box.scrollTop = box.scrollHeight;
    },
    onEnd(error) {
      box.classList.remove("interim");
      mic.classList.remove("on");
      mic.textContent = "speak";
      saveDraft();
      showCount();
      if (error) {
        status.className = "bulk-status error";
        status.textContent = error;
      }
      if (!panel.hidden) box.focus();
    },
  });

  const open = () => {
    if (drawer.isOpen) drawer.close();
    $("tune").hidden = true;
    try {
      box.value = localStorage.getItem(BULK_DRAFT_KEY) ?? "";
    } catch {}
    cycle = 0;
    mic.hidden = lang.hidden = !voiceSupported;
    showLang();
    panel.hidden = false;
    showCount();
    box.focus();
    box.setSelectionRange(box.value.length, box.value.length);
  };
  closeBulk = () => {
    if (panel.hidden) return;
    dictation.stop();
    saveDraft();
    panel.hidden = true;
    box.blur();
    kick(); // the swell was frozen while typing
  };
  const submit = () => {
    dictation.stop();
    const entries = parseList(box.value, cycle);
    if (!entries.length) return;
    box.value = "";
    saveDraft();
    closeBulk();
    api.createMany(entries);
  };

  button.addEventListener("click", () => (panel.hidden ? open() : closeBulk()));
  cancel.addEventListener("click", closeBulk);
  add.addEventListener("click", submit);
  lang.addEventListener("click", nextLang);
  mic.addEventListener("click", () => {
    if (dictation.listening) {
      dictation.stop();
      return;
    }
    // Spoken lines go after what is there, each on its own line.
    base = box.value.replace(/\s+$/, "");
    if (base) base += "\n";
    mic.classList.add("on");
    mic.textContent = "stop";
    status.className = "bulk-status listening";
    status.textContent = "listening… each pause is a new line";
    dictation.start(voiceLang);
  });
  box.addEventListener("input", () => {
    saveDraft();
    showCount();
  });
  box.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      e.stopPropagation();
      closeBulk();
    } else if (e.key === "Tab") {
      e.preventDefault();
      cycle += e.shiftKey ? KINDS.length - 1 : 1;
      showCount();
    }
  });
  document.body.append(button, panel);
}

// ⤓ (top left) downloads everything, every canvas, as one markdown file
// and then empties the canvases (their names and doors stay). It can't be
// undone, so it arms first, like the card's Delete.
const ARM_MS = 2500;

function setupExport() {
  const label = "Export to markdown and clear";
  const button = Object.assign(document.createElement("button"), {
    id: "export-toggle", className: "ghost", textContent: "⤓", title: label,
  });
  button.setAttribute("aria-label", label);
  let timer = null;
  const disarm = () => {
    clearTimeout(timer);
    button.classList.remove("armed");
    button.textContent = "⤓";
  };
  button.addEventListener("click", async () => {
    if (!button.classList.contains("armed")) {
      button.classList.add("armed");
      button.textContent = "clear all?";
      timer = setTimeout(disarm, ARM_MS);
      return;
    }
    disarm();
    if (drawer.isOpen) drawer.close();
    // A running pomodoro's minutes are logged before its item goes.
    if (focus.session) {
      const log = focus.end();
      music.setFocus(false);
      focusTick();
      if (log) await api.logFocus(log);
    }
    try {
      const { filename, markdown } = await api.exportClear();
      download(filename, markdown, "text/markdown");
    } catch (err) {
      console.warn(err);
      alert("Export failed, nothing was cleared.");
    }
  });
  document.body.append(button);
}

function setupTheme() {
  const button = Object.assign(document.createElement("button"), { id: "theme-toggle", className: "ghost", textContent: "◐" });
  const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  showTheme = () => {
    const { theme, next } = themeNow();
    const label = themeOverride
      ? `Theme: ${theme}, picked by hand until ${hhmm(next)}`
      : `Theme: ${theme} until ${hhmm(next)}`;
    button.title = label;
    button.setAttribute("aria-label", label);
  };
  button.addEventListener("click", () => {
    const { theme, scheduled, next } = themeNow();
    const want = theme === "dark" ? "light" : "dark";
    // Back to what the schedule says: no override left to hold.
    themeOverride = want === scheduled ? null : { theme: want, until: next.getTime() };
    try {
      localStorage.setItem(THEME_KEY, JSON.stringify(themeOverride));
    } catch {}
    updatePalette();
  });
  document.body.append(button);
  showTheme();
}

updateField();
setupTuning();
setupTheme();
setupMemory();
setupBulk();
setupExport();
reducedMotion.addEventListener?.("change", kick);
window.addEventListener("resize", () => {
  renderer.resize();
  updateField();
  for (const n of nodes.values()) refreshNode(n);
  physics.reheat(0.1);
  kick();
});
document.fonts?.ready.then(() => {
  for (const n of nodes.values()) n.labelKey = null;
  kick();
});

boot();
