// Settings for whoever hosts the app. Everything else is tuned per browser
// in the ≈ panel.

export const config = {
  theme: {
    // Light from lightAt, dark from darkAt (hours); ◐ overrides it until the next switch.
    lightAt: 7,
    darkAt: 19,
  },
  // Dictation languages (BCP-47, e.g. ["en-US", "de-DE"]); the first is the
  // default. Empty = the browser's language.
  voiceLangs: [],
  // Base plays on the canvas when ♪ is on; focus comes in during a pomodoro.
  // A file beside index.html (e.g. "sounds/base.mp3") or a URL; empty = the
  // built-in sound (soft brown noise, and a pad for focus).
  music: { base: "", focus: "" },
};
