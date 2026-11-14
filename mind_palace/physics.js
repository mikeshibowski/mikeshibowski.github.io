// Force layout on d3-force, like a classic force-directed graph:
//   link     - each connection is a spring pulling its two items together
//   charge   - every light pushes the others away
//   collide  - lights never overlap
//   labels   - a push so label text doesn't sit on other lights or labels
//              (arrows may run under text)
//   centre   - a gentle pull towards the middle of the field's ellipse, so
//              the graph holds together; nothing drifts out with time
//   tilt     - a faint pull putting an arrow's target above its source:
//              arrows run sub-task -> goal, so goals tend to rise to the top
//              without chains being forced into rows
//   memory   - with the active memory halo on: each slotted item is held
//              to its socket, riding the slowly turning ring (only a drag
//              moves it; its arrows spring the other end alone, at full
//              strength, so they keep their length), and everything else
//              is kept clear outside it (the centre
//              pull then aims at a band around it, so the graph settles
//              around the halo)
// The simulation never fully cools (an idle alpha target), so the graph
// stays gently alive and reacts to every change. Strengths live in
// `params` and can be tuned from the ≈ panel.
//
// The simulation is stepped manually from the render loop (no d3 timer).

export const FORCE_DEFAULTS = {
  linkDistance: 100, // px, spring rest length
  linkStrength: 0.15, // × d3's default (1 / degree of the busier end)
  repel: 100, // charge per light, scaled by its size
  center: 2, // × centre pull
  tilt: 0.2, // upward pull along arrows
  spacing: 20, // px kept clear around every light
  labelPush: 2, // labels pushing lights and labels off their text
  memoryRadius: 60, // px, the active memory halo, where its items ride
  memoryTurn: 3, // minutes for the halo to go round once; 0 holds it
  memoryPush: 1, // × how hard the rim keeps other items out
  edgeRoom: 16, // px kept clear inside the window's edges
};

export const MEMORY_SLOTS = 3;
// Kept clear outside the halo, past its items' marks.
export const HALO_CLEAR = 22;
// px past the halo a slotted item lets go when dragged.
export const MEMORY_BREAK = 50;

// Where socket i on the halo is, at its turn `angle`.
export function socketAt(memory, i, R) {
  const a = memory.angle + (i * 2 * Math.PI) / MEMORY_SLOTS - Math.PI / 2;
  return { x: memory.cx + Math.cos(a) * R, y: memory.cy + Math.sin(a) * R };
}

// Labels are kept apart like collide: by overlap, not alpha, so it still
// holds while the simulation idles. Gentle per tick, so a crowded spot
// eases apart rather than snaps.
const LABEL_K = 0.12;
// px kept clear around a label: the soft push settles a little short, and lights float.
const LABEL_ROOM = 10;
// px an arrow's target likes to sit above its source.
const TILT_GAP = 60;

const MAX_SPEED = 4; // px per tick
const SNAP_SPEED = 12; // a slotted item springing back to its socket (an event, so quicker)
const IDLE_ALPHA = 0.02; // never cools below this: always gently alive
const DRAG_ALPHA = 0.3;
const STILL = 0.1; // px per tick: slower creep is the idle "alive" drift, drawn at the ambient rate

// Box of a label, relative to its mark (labels hang to the right, see
// Renderer.drawLabel). n.r is where the label starts.
function labelBox(n) {
  const r = n.r ?? 7;
  const w = n.labelW ?? 80;
  const h = n.labelH ?? 18;
  const x0 = r + 8;
  return { x0, x1: x0 + w, y0: -h / 2 - 3, y1: h / 2 + 3 };
}

// Room at the bottom for the canvas name.
const NAME_CLEAR = 40;
const EDGE_K = 0.1;

const endId = (end) => (typeof end === "object" ? end.id : end);

export class Physics {
  constructor() {
    const d3 = window.d3;
    this.params = { ...FORCE_DEFAULTS };
    this.nodes = [];
    this.links = [];
    this.axes = { ax: 400, ay: 300, cx: 0, cy: 0 };
    this.view = { w: 0, h: 0 }; // the window, centred on the world origin
    this.speed = 0;
    this.degree = new Map();
    // The active memory pool: on, its centre and turn. Nodes in it carry
    // n.slot (their socket index).
    this.memory = { on: false, cx: 0, cy: 0, angle: 0 };

    this.sim = d3
      .forceSimulation(this.nodes)
      .velocityDecay(0.55)
      .alphaDecay(0.0228)
      .alphaTarget(IDLE_ALPHA)
      .force("link", d3.forceLink(this.links).id((d) => d.id))
      .force("charge", d3.forceManyBody().distanceMin(20).distanceMax(450).theta(0.9))
      .force("collide", d3.forceCollide((n) => (n.r ?? 7) + this.params.spacing).strength(0.8))
      .force("labels", () => this.labelForce())
      .force("centre", (alpha) => this.centreForce(alpha))
      .force("tilt", (alpha) => this.tiltForce(alpha))
      .force("memory", (alpha) => this.memoryForce(alpha))
      .force("edges", () => this.edgeForce())
      .force("cap", () => this.speedCap())
      .stop();
    this.applyParams();
  }

  // True while something visibly moves (the render loop then draws at full
  // rate). The idle simulation keeps ticking regardless.
  get active() {
    return this.sim.alpha() > IDLE_ALPHA * 1.5 || this.speed > STILL;
  }

  step() {
    this.sim.tick();
  }

  setParams(p) {
    Object.assign(this.params, p);
    this.applyParams();
    this.reheat(0.3);
  }

  // Strengths depend on the params and link degrees.
  applyParams() {
    const p = this.params;
    // Arrows to a slotted item are sprung in memoryForce instead.
    this.sim
      .force("link")
      .distance(p.linkDistance)
      .strength((l) => (this.anchored(l) ? 0 : this.linkK(l)));
    this.sim.force("charge").strength(-p.repel);
  }

  linkK(l) {
    const deg = (end) => this.degree.get(endId(end)) ?? 1;
    return this.params.linkStrength / Math.max(1, Math.min(deg(l.source), deg(l.target)));
  }

  // A link with exactly one end held in a socket: that end is anchored.
  anchored(l) {
    if (!this.memory.on || typeof l.source !== "object") return null;
    const a = l.source.slot != null;
    const b = l.target.slot != null;
    return a === b ? null : a ? l.source : l.target;
  }

  // Usable half-width/height of the field and its centre, in world px.
  setField(ax, ay, cx = 0, cy = 0) {
    // The halo stays in the window's true centre (0, 0): the field is
    // shifted for labels hanging right, which would set it off-centre.
    Object.assign(this.axes, { ax, ay, cx, cy });
  }

  setView(w, h) {
    Object.assign(this.view, { w, h });
  }

  // How far an item at (x, y), mark and label, sticks out of the window:
  // the shift that would bring it back in (0 when inside). Too big to fit,
  // its mark and the start of its label win.
  outside(n, x, y) {
    const { w, h } = this.view;
    if (!w) return { dx: 0, dy: 0 };
    const room = this.params.edgeRoom;
    const r = n.r ?? 7;
    const b = labelBox(n);
    const [x0, x1] = [-w / 2 + room, w / 2 - room];
    const [y0, y1] = [-h / 2 + room, h / 2 - room - NAME_CLEAR];
    const left = x - r;
    const right = x + (n.labelW ? b.x1 : r);
    const top = y + Math.min(-r, b.y0);
    const bottom = y + Math.max(r, b.y1);
    const dx = left < x0 ? x0 - left : right > x1 ? Math.max(x1 - right, x0 - left) : 0;
    const dy = top < y0 ? y0 - top : bottom > y1 ? Math.max(y1 - bottom, y0 - top) : 0;
    return { dx, dy };
  }

  // Where a held item (dragged or pinned) may sit: inside the window.
  clamp(n, x, y) {
    const { dx, dy } = this.outside(n, x, y);
    return [x + dx, y + dy];
  }

  // Items, their labels and so their arrows stay in the window. One inside
  // meets a wall: nothing pushes it further out. One left outside (by a
  // resize) is eased back in, so the layout squeezes rather than jumps.
  // Runs after the other forces and isn't scaled by alpha, so it holds
  // while the simulation idles.
  edgeForce() {
    const k = EDGE_K;
    const f = 1 - this.sim.velocityDecay(); // d3 moves a node by v * f
    const ease = (v, d) => (d > 0 ? Math.max(v, 0) : Math.min(v, 0)) + d * k;
    for (const n of this.nodes) {
      if (n.fx != null || (n.slot != null && this.memory.on)) continue;
      const now = this.outside(n, n.x, n.y);
      const next = this.outside(n, n.x + n.vx * f, n.y + n.vy * f);
      if (now.dx) n.vx = ease(n.vx, now.dx);
      else n.vx += next.dx / f;
      if (now.dy) n.vy = ease(n.vy, now.dy);
      else n.vy += next.dy / f;
    }
  }

  // Wake the simulation up (sizes or links changed).
  reheat(alpha = 0.15) {
    this.sim.force("collide").radius((n) => (n.r ?? 7) + this.params.spacing);
    this.applyParams();
    this.sim.alpha(Math.max(this.sim.alpha(), alpha));
  }

  setNodes(nodes) {
    this.nodes.length = 0;
    this.nodes.push(...nodes);
    this.sim.nodes(this.nodes);
  }

  setLinks(links) {
    this.links.length = 0;
    this.links.push(...links);
    this.degree = new Map();
    for (const l of links) {
      for (const end of [l.source, l.target]) this.degree.set(endId(end), (this.degree.get(endId(end)) ?? 0) + 1);
    }
    this.sim.force("link").links(this.links);
    this.applyParams();
  }

  // While an item is dragged, wormholes hold still: they are where it may
  // be dropped, so they must not dodge it. Pinned ones are fixed anyway.
  dragging(on, node = null) {
    this.sim.alphaTarget(on ? DRAG_ALPHA : IDLE_ALPHA);
    for (const n of this.nodes) {
      if (on && node && node.item?.kind !== "wormhole" && n.item?.kind === "wormhole" && n.fx == null) {
        n.fx = n.x;
        n.fy = n.y;
        n.held = true;
      } else if (!on && n.held) {
        n.fx = n.fy = null;
        n.held = false;
      }
    }
    if (on) this.reheat(0.1);
  }

  // Ellipse-normalised pull towards the field's centre, so a wide screen
  // gets a wide graph. Gentle: repulsion keeps the lights spread out.
  // With the pool on it pulls toward a ring around the pool instead, and
  // never inward past it: the rim keeps the middle, and the pull holding the
  // graph together mustn't pile it up against the rim.
  centreForce(alpha) {
    const { ax, ay } = this.axes;
    const { cx, cy } = this.memory.on ? this.memory : this.axes; // the ring around the halo
    const k = 0.015 * this.params.center * alpha;
    const mean = (ax + ay) / 2;
    const ring = this.memory.on ? (this.params.memoryRadius + HALO_CLEAR + 60) / mean : 0;
    for (const n of this.nodes) {
      if (n.slot != null && this.memory.on) continue;
      const ex = (n.x - cx) / ax;
      const ey = (n.y - cy) / ay;
      const s = ring ? Math.max(0, 1 - ring / (Math.hypot(ex, ey) || 1)) : 1;
      n.vx -= ex * s * k * mean;
      n.vy -= ey * s * k * mean;
    }
  }

  // Not scaled by alpha, like collide, so it holds while the simulation idles.
  // Runs after the other forces: a slotted item's velocity is replaced, not
  // added to, so neighbours (dragged or not) can't tug it off its socket.
  memoryForce(alpha) {
    const m = this.memory;
    if (!m.on) return;
    const p = this.params;
    const R = p.memoryRadius;
    const hold = 0.35;
    const push = 0.15 * p.memoryPush;
    // Its arrows: the whole spring on the free end, as d3 would split it
    // with an end that can't move. Same maths as d3's forceLink.
    for (const l of this.links) {
      const anchor = this.anchored(l);
      if (!anchor) continue;
      const free = anchor === l.source ? l.target : l.source;
      if (free.fx != null || free.dying) continue;
      const dx = free.x + free.vx - anchor.x || 1e-6;
      const dy = free.y + free.vy - anchor.y;
      const d = Math.hypot(dx, dy);
      const k = ((d - p.linkDistance) / d) * alpha * this.linkK(l);
      free.vx -= dx * k;
      free.vy -= dy * k;
    }
    for (const n of this.nodes) {
      if (n.dying) continue;
      if (n.slot != null) {
        if (n.fx != null) continue; // in hand
        const s = socketAt(m, n.slot, R);
        n.vx = (s.x - n.x) * hold;
        n.vy = (s.y - n.y) * hold;
        continue;
      }
      if (n.fx != null || !push) continue;
      // The light, then its label: whichever reaches deeper in is pushed out.
      const clear = R + HALO_CLEAR + p.spacing;
      let dx = n.x - m.cx;
      let dy = n.y - m.cy;
      let d = Math.hypot(dx, dy) || 1;
      let over = clear + (n.r ?? 7) - d;
      const b = labelBox(n);
      const lx = Math.min(Math.max(m.cx, n.x + b.x0), n.x + b.x1) - m.cx;
      const ly = Math.min(Math.max(m.cy, n.y + b.y0), n.y + b.y1) - m.cy;
      const ld = Math.hypot(lx, ly);
      if (clear - ld > over && ld > 1) {
        over = clear - ld;
        [dx, dy, d] = [lx, ly, ld];
      }
      if (over <= 0) continue;
      n.vx += (dx / d) * over * push;
      n.vy += (dy / d) * over * push;
    }
  }

  // Arrows a -> b: if b isn't at least TILT_GAP above a, ease them apart
  // vertically. Faint, so it only biases the shape.
  tiltForce(alpha) {
    const k = 0.1 * this.params.tilt * alpha;
    if (!k) return;
    for (const l of this.links) {
      const a = l.source;
      const b = l.target;
      if (typeof a !== "object" || typeof b !== "object") continue;
      const short = TILT_GAP - (a.y - b.y);
      if (short <= 0) continue;
      a.vy += short * k;
      b.vy -= short * k;
    }
  }

  // Labels hang to the right of their light: softly push any other light or
  // label out of a label's box, along whichever axis frees it sooner. Long
  // labels side by side part vertically; ones just touching at their ends
  // slide sideways instead of stacking. Boxes sit where they are drawn,
  // floating on the swell (n.floatX/Y from the renderer): neighbours float
  // by different amounts, and a strong drift would carry text onto marks.
  labelForce() {
    const list = this.nodes.filter((n) => !n.dying);
    const k = this.params.labelPush * LABEL_K;
    if (!k) return;
    const at = (n) => [n.x + (n.floatX ?? 0), n.y + (n.floatY ?? 0)];
    const room = LABEL_ROOM;
    for (const a of list) {
      const { x0, x1, y0, y1 } = labelBox(a);
      const box = { x0: x0 - room, x1: x1 + room, y0: y0 - room, y1: y1 + room };
      const [ax, ay] = at(a);
      for (const b of list) {
        if (a === b) continue;
        const [bx, by] = at(b);
        const rb = (b.r ?? 7) + 2;
        // b's light against a's label.
        this.part(a, b, ax + box.x0, ax + box.x1, ay + box.y0, ay + box.y1,
          bx - rb, bx + rb, by - rb, by + rb, k);
        // b's label against a's label (each pair once).
        if (a.id >= b.id) continue;
        const bb = labelBox(b);
        this.part(a, b, ax + box.x0, ax + box.x1, ay + box.y0, ay + box.y1,
          bx + bb.x0, bx + bb.x1, by + bb.y0, by + bb.y1, k);
      }
    }
  }

  // Two boxes [x0, x1] x [y0, y1], belonging to items a and b.
  part(a, b, ax0, ax1, ay0, ay1, bx0, bx1, by0, by1, k) {
    const ox = Math.min(ax1, bx1) - Math.max(ax0, bx0);
    const oy = Math.min(ay1, by1) - Math.max(ay0, by0);
    if (ox <= 0 || oy <= 0) return;
    const side = (d, tie) => (d < 0 || (d === 0 && tie) ? -1 : 1);
    const tie = a.id < b.id;
    if (ox < oy) {
      const push = side(ax0 + ax1 - bx0 - bx1, tie) * ox * k * 0.5;
      a.vx += push;
      b.vx -= push;
    } else {
      const push = side(ay0 + ay1 - by0 - by1, tie) * oy * k * 0.5;
      a.vy += push;
      b.vy -= push;
    }
  }

  speedCap() {
    let fastest = 0;
    for (const n of this.nodes) {
      const v = Math.hypot(n.vx, n.vy);
      const max = n.slot != null && this.memory.on ? SNAP_SPEED : MAX_SPEED;
      if (v > max) {
        n.vx *= max / v;
        n.vy *= max / v;
      }
      if (n.fx == null && !n.dying) fastest = Math.max(fastest, Math.min(v, MAX_SPEED));
    }
    this.speed = fastest * (1 - this.sim.velocityDecay());
  }
}
