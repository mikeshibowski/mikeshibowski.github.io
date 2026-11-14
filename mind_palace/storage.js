// The palace lives in this browser's localStorage. It is synchronous, so a
// change is read, modify, write in one step and two open tabs can't
// overwrite each other; the other tabs hear of it through `storage` events.

export const STATE_KEY = "mindPalace.state";

export class Storage {
  constructor(backend) {
    try {
      this.backend = backend ?? globalThis.localStorage;
    } catch {
      this.backend = null; // storage blocked outright: every read and save falls back
    }
    this.fallback = null; // the last state, used once the browser has refused a save
    this.refused = false;
  }

  // The stored state as a fresh object, or null when there is none yet.
  load() {
    if (!this.refused) {
      try {
        const text = this.backend.getItem(STATE_KEY);
        if (text) return JSON.parse(text);
      } catch {}
    }
    return this.fallback ? JSON.parse(this.fallback) : null;
  }

  save(state) {
    this.fallback = JSON.stringify(state);
    try {
      this.backend.setItem(STATE_KEY, this.fallback);
      this.refused = false;
    } catch {
      this.refused = true; // private mode or full: it lives on in this tab only
    }
    return !this.refused;
  }

  // Another tab changed the palace.
  onChange(listener) {
    globalThis.addEventListener?.("storage", (e) => {
      if (e.key !== STATE_KEY || !e.newValue) return;
      try {
        listener(JSON.parse(e.newValue));
      } catch {}
    });
  }

  // Ask the browser not to evict the palace under disk pressure.
  persist() {
    globalThis.navigator?.storage?.persist?.().catch(() => {});
  }
}
