// The palace's state and every rule for changing it. No I/O: storage.js
// keeps the state in the browser, app.js draws it. State holds `canvases`,
// `items` (each on a `canvas`; a wormhole has a `target` canvas), directed
// `edges` (a -> b, same canvas only), `memory` (the halo's slots) and `log`
// (focus sessions and done tasks, the long-term record).

export const KINDS = ["task", "thought", "question", "artifact"];
// Kinds you can run a focus session on.
const FOCUS_KINDS = ["task", "question"];
const ITEM_FIELDS = ["title", "notes", "importance", "kind", "done", "pinned", "pos"];
export const HOME = "home";
// Active memory: a few slots shared by every canvas.
export const MEMORY_SLOTS = 3;
// Every canvas, home too, gets its own accent hue (OKLCH degrees, see
// palette.js): the first one not yet taken, in this order, which keeps
// neighbours in the list far apart on the wheel.
const CANVAS_HUES = [200, 150, 65, 290, 20, 245, 335, 110];
// Left in old canvas.json files from when a server kept the palace.
const LEGACY_STATE_KEYS = ["pending_ops", "id_map"];
const LEGACY_ITEM_KEYS = ["todoist_id", "remote_updated", "due"];
const NOTE_INDENT = "  ";

const nowIso = () => new Date().toISOString().slice(0, 19) + "+00:00";
// The local date, YYYY-MM-DD.
export const localDay = (d = new Date()) => d.toLocaleDateString("sv");
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

function randomId() {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  let id = "";
  for (let i = 0; i < 5; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

const emptyState = (day) => ({
  day,
  items: [],
  edges: [],
  canvases: { [HOME]: { name: "", created: nowIso(), hue: CANVAS_HUES[0] } },
  memory: Array(MEMORY_SLOTS).fill(null),
  log: { focus: [], done: [] },
});

export class Store {
  // `state`: what storage held (or an old canvas.json); null starts empty.
  constructor(state = null, today = localDay()) {
    if (state != null && (typeof state !== "object" || !Array.isArray(state.items))) {
      throw new Error("not a Mind Palace file");
    }
    const fresh = emptyState(today);
    this.state = state ?? fresh;
    for (const [key, value] of Object.entries(fresh)) this.state[key] ??= value;
    this.state.log.focus ??= [];
    this.state.log.done ??= [];
    this.canvases[HOME] ??= fresh.canvases[HOME];
    // The tray is long gone: anything still waiting there goes back onto its canvas.
    for (const item of this.state.tray ?? []) this.state.items.push({ ...item, pos: null, pinned: null });
    delete this.state.tray;
    for (const key of LEGACY_STATE_KEYS) delete this.state[key];
    for (const item of this.items) {
      if (!this.canvases[item.canvas]) item.canvas = HOME;
      for (const key of LEGACY_ITEM_KEYS) delete item[key];
    }
    for (const canvas of Object.values(this.canvases)) canvas.hue ??= this.freeHue();
    this.ensureDoors();
    this.pruneEdges();
    this.pruneMemory();
  }

  get items() {
    return this.state.items;
  }

  get canvases() {
    return this.state.canvases;
  }

  get(id) {
    return this.items.find((i) => i.id === id) ?? null;
  }

  newId() {
    let id = randomId();
    while (this.get(id) || this.canvases[id] || this.state.edges.some((e) => e.id === id)) id = randomId();
    return id;
  }

  // ---- days ----------------------------------------------------------------

  // Note the date for new items, and let go of tasks done on an earlier day.
  newDay(today = localDay()) {
    if (this.state.day === today) return false;
    this.state.day = today;
    for (const item of this.items.filter((i) => i.kind === "task" && i.done && i.done_day !== today)) {
      this.logDone(item);
      this.drop(item.id);
    }
    return true;
  }

  // Written when a done task leaves, not when it is ticked, so un-ticking leaves no stale line.
  logDone(item) {
    this.state.log.done.push({ day: item.done_day ?? this.state.day, title: item.title, id: item.id });
  }

  markDone(item, done) {
    item.done = done;
    if (done) item.done_day ??= this.state.day;
    else delete item.done_day;
  }

  pruneEdges() {
    const where = new Map(this.items.map((i) => [i.id, i.canvas]));
    this.state.edges = this.state.edges.filter(
      (e) => where.has(e.a) && where.has(e.b) && where.get(e.a) === where.get(e.b),
    );
  }

  // ---- canvases and wormholes ----------------------------------------------

  // A new canvas, with its door here where it was made, and doors between
  // it and every other canvas.
  createCanvas(name, from = HOME, pos = null) {
    if (!this.canvases[from]) from = HOME;
    const canvas = this.newId();
    this.canvases[canvas] = { name: name.trim(), created: nowIso(), hue: this.freeHue() };
    const there = this.wormhole(from, canvas, pos);
    this.ensureDoors();
    return there;
  }

  freeHue() {
    const taken = Object.values(this.canvases).map((c) => c.hue);
    return CANVAS_HUES.find((h) => !taken.includes(h)) ?? CANVAS_HUES[taken.length % CANVAS_HUES.length];
  }

  // Every canvas has a door to every other canvas, so any is one step away.
  ensureDoors() {
    const doors = new Set(this.items.filter((i) => i.kind === "wormhole").map((i) => `${i.canvas}>${i.target}`));
    for (const on of Object.keys(this.canvases)) {
      for (const target of Object.keys(this.canvases)) {
        if (on !== target && !doors.has(`${on}>${target}`)) this.wormhole(on, target, null);
      }
    }
  }

  wormhole(on, target, pos) {
    const item = this.create("wormhole", "", { pos, canvas: on });
    item.target = target;
    return item;
  }

  renameCanvas(canvas, name) {
    if (this.canvases[canvas]) this.canvases[canvas].name = name.trim();
  }

  // Dropped into a wormhole.
  moveItem(id, canvas) {
    const item = this.get(id);
    if (!item || !this.canvases[canvas] || item.kind === "wormhole") return null;
    if (item.canvas === canvas) return item;
    Object.assign(item, { canvas, pos: null, pinned: null, touched: nowIso() });
    this.pruneEdges();
    return item;
  }

  // Why this door can't go: deleting a door deletes its canvas, which must
  // be empty first; home stays.
  wormholeBlocked(item) {
    if (item.kind !== "wormhole") return null;
    if (item.target === HOME) return "home always keeps its doors";
    if (this.items.some((i) => i.canvas === item.target && i.kind !== "wormhole")) {
      return "the canvas behind this wormhole still has items";
    }
    return null;
  }

  // An empty canvas goes, with every door to it.
  forgetCanvas(canvas) {
    if (!canvas || canvas === HOME || !this.canvases[canvas]) return;
    this.state.items = this.items.filter((i) => i.canvas !== canvas && i.target !== canvas);
    delete this.canvases[canvas];
    this.pruneEdges();
    this.pruneMemory();
  }

  // ---- item operations -----------------------------------------------------

  create(kind, title, { importance = 4, pos = null, notes = "", canvas = HOME } = {}) {
    const ts = nowIso();
    const item = {
      id: this.newId(),
      kind,
      title,
      notes,
      importance: Math.max(1, Math.min(4, importance)),
      created: ts,
      touched: ts,
      day: this.state.day,
      done: false,
      pinned: null,
      pos,
      canvas: this.canvases[canvas] ? canvas : HOME,
    };
    this.items.push(item);
    return item;
  }

  update(id, fields) {
    const item = this.get(id);
    if (!item) return null;
    const explicitTouch = Boolean(fields.touch);
    fields = Object.fromEntries(Object.entries(fields).filter(([k]) => ITEM_FIELDS.includes(k)));
    if (fields.kind != null && !KINDS.includes(fields.kind)) delete fields.kind;
    if (item.kind === "wormhole") {
      // A wormhole's title is its canvas's name.
      if ("title" in fields) this.renameCanvas(item.target, fields.title);
      for (const k of ["pos", "pinned", "importance"]) if (k in fields) item[k] = fields[k];
      if (explicitTouch) item.touched = nowIso();
      return item;
    }
    Object.assign(item, fields);
    // Ticking done or moving is not an edit, so `touched` stays.
    if (explicitTouch || Object.keys(fields).some((k) => !["pos", "pinned", "done"].includes(k))) {
      item.touched = nowIso();
    }
    if (item.kind !== "task") item.done = false; // only tasks can be done
    // Done tasks stay on the canvas, dimmed, until the next day.
    this.markDone(item, Boolean(item.done));
    return item;
  }

  // True when it went; a string says why a wormhole can't go.
  delete(id) {
    const item = this.get(id);
    if (!item) return false;
    const blocked = this.wormholeBlocked(item);
    if (blocked) return blocked;
    this.drop(id);
    if (item.kind === "wormhole") this.forgetCanvas(item.target);
    return true;
  }

  savePositions(positions) {
    for (const item of this.items) if (positions[item.id]) item.pos = positions[item.id];
  }

  drop(id) {
    this.state.items = this.items.filter((i) => i.id !== id);
    this.pruneEdges();
    this.pruneMemory();
  }

  // ---- active memory -------------------------------------------------------

  // Fill the slots; unknown ids, wormholes and repeats leave a slot empty.
  setMemory(slots) {
    const known = new Set(this.items.filter((i) => i.kind !== "wormhole").map((i) => i.id));
    const memory = [];
    for (const slot of [...slots].slice(0, MEMORY_SLOTS)) {
      memory.push(known.has(slot) && !memory.includes(slot) ? slot : null);
    }
    while (memory.length < MEMORY_SLOTS) memory.push(null);
    this.state.memory = memory;
    return memory;
  }

  pruneMemory() {
    const known = new Set(this.items.map((i) => i.id));
    const memory = this.state.memory.map((m) => (known.has(m) ? m : null)).slice(0, MEMORY_SLOTS);
    while (memory.length < MEMORY_SLOTS) memory.push(null);
    this.state.memory = memory;
  }

  // ---- focus sessions ------------------------------------------------------

  // A finished pomodoro: a running total on the item and a line in the log.
  logFocus(id, started, ended, minutes) {
    const item = this.get(id);
    if (!item || !FOCUS_KINDS.includes(item.kind) || minutes < 1) return null;
    item.focus_minutes = (item.focus_minutes || 0) + minutes;
    const start = new Date(started);
    this.state.log.focus.push({
      day: localDay(start), span: `${hhmm(start)}–${hhmm(new Date(ended))}`, minutes, title: item.title, id,
    });
    return item;
  }

  // ---- edges ---------------------------------------------------------------

  // Connect a -> b. Linking an existing pair the other way reverses it.
  addEdge(a, b) {
    const [ia, ib] = [this.get(a), this.get(b)];
    if (a === b || !ia || !ib || ia.canvas !== ib.canvas) return null;
    for (const e of this.state.edges) {
      if ((e.a === a && e.b === b) || (e.a === b && e.b === a)) {
        Object.assign(e, { a, b });
        return e;
      }
    }
    const edge = { id: this.newId(), a, b };
    this.state.edges.push(edge);
    return edge;
  }

  removeEdge(id) {
    this.state.edges = this.state.edges.filter((e) => e.id !== id);
  }

  removeEdgesOf(id) {
    this.state.edges = this.state.edges.filter((e) => e.a !== id && e.b !== id);
  }

  // ---- export, clear, import -----------------------------------------------

  // Everything on every canvas as one markdown document, home first, then
  // the log by day.
  exportMarkdown(stamp) {
    const titles = new Map(this.items.map((i) => [i.id, i.title]));
    const out = [`# Mind Palace, ${stamp}`];
    const canvases = Object.keys(this.canvases).sort((a, b) => (a !== HOME) - (b !== HOME));
    for (const canvas of canvases) {
      const here = this.items.filter((i) => i.canvas === canvas && i.kind !== "wormhole");
      if (!here.length) continue;
      out.push("", `## ${this.canvases[canvas].name || (canvas === HOME ? "Home" : canvas)}`);
      for (const kind of ["task", "question", "thought", "artifact"]) {
        const group = here.filter((i) => i.kind === kind);
        if (!group.length) continue;
        out.push("", `### ${kind[0].toUpperCase()}${kind.slice(1)}s`, "");
        for (const item of group) {
          let line = "- ";
          if (kind === "task") line += item.done ? "[x] " : "[ ] ";
          line += item.title;
          if ((item.importance ?? 4) !== 4) line += ` !${item.importance}`;
          if (item.focus_minutes) line += ` · ${item.focus_minutes} min focused`;
          for (const e of this.state.edges) if (e.a === item.id) line += ` → ${titles.get(e.b) ?? ""}`;
          out.push(line);
          if (item.notes) out.push(...item.notes.split("\n").map((n) => (n ? NOTE_INDENT + n : "")));
        }
      }
    }
    const { focus, done } = this.state.log;
    const days = [...new Set([...focus, ...done].map((l) => l.day))].sort();
    if (days.length) out.push("", "## Log");
    for (const day of days) {
      out.push("", `### ${day}`, "");
      for (const l of focus) if (l.day === day) out.push(`- ${l.span} · ${l.minutes} min · ${l.title}`);
      for (const l of done) if (l.day === day) out.push(`- done · ${l.title}`);
    }
    return out.join("\n") + "\n";
  }

  // Empty every canvas and the log (the export has them). Canvases and
  // their doors stay.
  clearAll() {
    this.state.items = this.items.filter((i) => i.kind === "wormhole");
    this.state.edges = [];
    this.state.memory = Array(MEMORY_SLOTS).fill(null);
    this.state.log = { focus: [], done: [] };
  }

  // Merge a backup (or an old canvas.json) in: whatever is new is added,
  // nothing here is overwritten or removed. Returns how many items came in.
  importState(json) {
    const other = new Store(structuredClone(json), this.state.day);
    for (const [id, canvas] of Object.entries(other.canvases)) {
      if (this.canvases[id]) {
        if (!this.canvases[id].name) this.canvases[id].name = canvas.name ?? "";
        continue;
      }
      const taken = Object.values(this.canvases).some((c) => c.hue === canvas.hue);
      this.canvases[id] = { ...canvas, hue: taken ? this.freeHue() : canvas.hue };
    }
    const doors = new Set(this.items.filter((i) => i.kind === "wormhole").map((i) => `${i.canvas}>${i.target}`));
    let added = 0;
    for (const item of other.items) {
      if (this.get(item.id)) continue;
      if (item.kind === "wormhole") {
        if (doors.has(`${item.canvas}>${item.target}`)) continue;
      } else added++;
      this.items.push(item);
    }
    for (const edge of other.state.edges) {
      const linked = this.state.edges.some(
        (e) => e.id === edge.id || (e.a === edge.a && e.b === edge.b) || (e.a === edge.b && e.b === edge.a),
      );
      if (!linked) this.state.edges.push(edge);
    }
    this.state.memory = this.state.memory.map((m, i) => m ?? other.state.memory[i] ?? null);
    for (const kind of ["focus", "done"]) {
      const seen = new Set(this.state.log[kind].map((l) => JSON.stringify(l)));
      for (const l of other.state.log[kind]) if (!seen.has(JSON.stringify(l))) this.state.log[kind].push(l);
    }
    this.ensureDoors();
    this.pruneEdges();
    this.setMemory(this.state.memory);
    return added;
  }
}
