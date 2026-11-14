// A pomodoro on one task or question. Only one runs at a time, and it is
// kept in localStorage so a reload doesn't lose it. Times are wall-clock
// ms (Date.now()), so a session survives a reload or sleep. Pauses don't count.

export const FOCUS_KINDS = ["task", "question"];
export const MINUTES = 15; // one length, nothing to choose

const KEY = "mindPalace.focus";

export const canFocus = (item) => Boolean(item) && FOCUS_KINDS.includes(item.kind) && !item.done;

export const elapsed = (s, now) => Math.max(0, (s.pausedAt ?? now) - s.startedAt - s.pausedTotal);
export const remaining = (s, now) => Math.max(0, s.durationMs - elapsed(s, now));
export const progress = (s, now) => Math.min(1, elapsed(s, now) / s.durationMs);

export function startSession(itemId, minutes, now) {
  return { itemId, startedAt: now, durationMs: minutes * 60_000, pausedAt: null, pausedTotal: 0 };
}

export function pauseSession(s, now) {
  return s.pausedAt ? s : { ...s, pausedAt: now };
}

export function resumeSession(s, now) {
  return s.pausedAt ? { ...s, pausedTotal: s.pausedTotal + now - s.pausedAt, pausedAt: null } : s;
}

// What gets logged; whole minutes, and nothing under one.
export const loggedMinutes = (s, now) => Math.round(elapsed(s, now) / 60_000);

// 25:00, counting the started second as still to go.
export function clock(ms) {
  const sec = Math.ceil(ms / 1000);
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;
}

export function total(minutes) {
  if (!minutes) return "";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`;
}

export class Focus {
  constructor() {
    this.session = load(KEY);
    this.minutes = MINUTES;
  }

  get running() {
    return Boolean(this.session && !this.session.pausedAt);
  }

  on(id) {
    return this.session?.itemId === id;
  }

  start(itemId, minutes = this.minutes, now = Date.now()) {
    this.set(startSession(itemId, minutes, now));
  }

  pause(now = Date.now()) {
    if (this.session) this.set(pauseSession(this.session, now));
  }

  resume(now = Date.now()) {
    if (this.session) this.set(resumeSession(this.session, now));
  }

  // Ends the session and returns what to log ({itemId, started, ended,
  // minutes}), or null when there is less than a minute to show for it.
  end(now = Date.now()) {
    const s = this.session;
    if (!s) return null;
    const ended = s.pausedAt ?? now;
    const minutes = loggedMinutes(s, now);
    this.set(null);
    if (minutes < 1) return null;
    return {
      itemId: s.itemId,
      started: new Date(s.startedAt).toISOString(),
      ended: new Date(ended).toISOString(),
      minutes,
    };
  }

  set(s) {
    this.session = s;
    store(KEY, s);
  }
}

function load(key) {
  try {
    return JSON.parse(localStorage.getItem(key));
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}
