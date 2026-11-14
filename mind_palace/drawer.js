// The details card of the focused item (top right). Saves as you type
// (debounced). Closing it lets go of the focus (api.onClose).

import { canFocus, remaining, clock, total } from "./focus.js";

const $ = (id) => document.getElementById(id);

const timeOf = (iso) =>
  iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";

export class Drawer {
  constructor(api) {
    this.api = api; // { patch(id, fields), remove(id), unlink(id), togglePin(id), onClose(), focus }
    this.el = $("drawer");
    this.item = null;
    this.timer = null;
    this.pending = {};

    this.title = $("d-title");
    this.notes = $("d-notes");

    this.title.addEventListener("input", () => {
      this.autosize(this.title);
      // A wormhole's title is its canvas's name, which may be empty.
      const title = this.title.value.trim();
      this.queue({ title: title || (this.item.kind === "wormhole" ? "" : this.item.title) });
    });
    this.title.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        this.notes.focus();
      }
    });
    // Notes grow with the text up to the card's max height, then scroll.
    this.notes.addEventListener("input", () => {
      this.autosize(this.notes);
      this.queue({ notes: this.notes.value });
    });

    $("d-kind").addEventListener("click", (e) => {
      const kind = e.target.dataset.kind;
      if (kind && kind !== this.item.kind) this.save({ kind });
    });
    $("d-imp").addEventListener("click", (e) => {
      const i = Number(e.target.dataset.i);
      if (i) this.save({ importance: i });
    });
    // Done items stay on the canvas, dimmed, so this toggles.
    $("d-done").addEventListener("click", () => this.save({ done: !this.item.done }));
    $("d-pin").addEventListener("click", () => this.api.togglePin(this.item.id));
    $("d-unlink").addEventListener("click", () => this.api.unlink(this.item.id));
    const del = $("d-delete");
    del.addEventListener("click", () => {
      if (!del.classList.contains("armed")) {
        del.classList.add("armed");
        del.textContent = "Delete?";
        setTimeout(() => this.disarm(), 2500);
        return;
      }
      this.api.remove(this.item.id);
      this.close();
    });
    $("d-close").addEventListener("click", () => this.close());

    // Pomodoro: Focus / Pause / Resume, and Stop.
    $("d-focus-go").addEventListener("click", () => {
      const f = this.api.focus;
      if (!f.state.on(this.item.id)) f.start(this.item.id);
      else if (f.state.running) f.pause();
      else f.resume();
    });
    $("d-focus-stop").addEventListener("click", () => this.api.focus.stop());
  }

  get isOpen() {
    return this.item !== null;
  }

  disarm() {
    const del = $("d-delete");
    del.classList.remove("armed");
    // A door is there because its canvas is: deleting it deletes the canvas.
    del.textContent = this.item?.kind === "wormhole" ? "Delete canvas" : "Delete";
  }

  autosize(t) {
    t.style.height = "auto";
    t.style.height = t.scrollHeight + "px";
  }

  open(item, edgeCount) {
    this.flush();
    this.item = item;
    this.title.value = item.title;
    this.notes.value = item.notes || "";
    this.disarm();
    this.render(item, edgeCount);
    this.el.classList.add("open");
    this.el.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      this.autosize(this.title);
      this.autosize(this.notes);
    });
  }

  // Refresh from the stored state without clobbering the field being edited.
  render(item, edgeCount) {
    this.item = item;
    const wormhole = item.kind === "wormhole";
    this.el.classList.toggle("wormhole", wormhole);
    // Home has no name to edit.
    this.title.readOnly = wormhole && item.target === "home";
    this.title.placeholder = wormhole ? (item.target === "home" ? "home" : "Canvas name (optional)") : "Title";
    const focused = document.activeElement;
    if (focused !== this.title && !("title" in this.pending)) {
      this.title.value = item.title;
      this.autosize(this.title);
    }
    if (focused !== this.notes && !("notes" in this.pending)) {
      this.notes.value = item.notes || "";
      this.autosize(this.notes);
    }
    this.el.classList.toggle("not-task", item.kind !== "task");
    for (const b of $("d-kind").children) b.classList.toggle("on", b.dataset.kind === item.kind);
    for (const b of $("d-imp").children) b.classList.toggle("on", Number(b.dataset.i) >= item.importance);
    $("d-pin").textContent = item.pinned ? "Unpin" : "Pin";
    $("d-done").textContent = item.done ? "Not done" : "Done";
    $("d-unlink").hidden = !edgeCount;
    $("d-delete").hidden = wormhole && item.target === "home"; // home stays
    $("d-unlink").textContent = edgeCount > 1 ? `Disconnect ${edgeCount}` : "Disconnect";

    const bits = [`added ${timeOf(item.created)}`];
    if (item.touched !== item.created) bits.push(`touched ${timeOf(item.touched)}`);
    if (wormhole) bits.splice(0, bits.length, `wormhole · ${item.label}`, "click it to travel");
    $("d-meta").textContent = bits.join(" · ");
    this.renderFocus();
  }

  // The pomodoro row, also refreshed once a second while one runs.
  renderFocus() {
    if (!this.item) return;
    const f = this.api.focus;
    const s = f.state.session;
    const mine = f.state.on(this.item.id);
    this.el.classList.toggle("focusable", canFocus(this.item));
    this.el.classList.toggle("focusing", mine);
    $("d-clock").textContent = clock(mine ? remaining(s, Date.now()) : f.state.minutes * 60_000);
    const go = $("d-focus-go");
    go.textContent = !mine ? (s ? "Focus here" : "Focus") : f.state.running ? "Pause" : "Resume";
    go.title = !mine && s ? `Ends the pomodoro on “${f.itemTitle(s.itemId)}” and logs it` : "";
    $("d-focus-stop").hidden = !mine;
    const spent = total(this.item.focus_minutes);
    $("d-focus-total").textContent = spent ? `${spent} focused` : "";
  }

  queue(fields) {
    Object.assign(this.pending, fields);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush(), 500);
  }

  flush() {
    clearTimeout(this.timer);
    if (this.item && Object.keys(this.pending).length) {
      this.api.patch(this.item.id, this.pending);
    }
    this.pending = {};
  }

  save(fields) {
    this.flush();
    this.api.patch(this.item.id, fields);
  }

  close() {
    this.flush();
    this.item = null;
    this.el.classList.remove("open");
    this.el.setAttribute("aria-hidden", "true");
    if (this.el.contains(document.activeElement)) document.activeElement.blur();
    this.api.onClose?.();
  }
}
