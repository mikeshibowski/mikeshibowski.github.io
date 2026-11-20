// Dictation through the browser's Web Speech API (Chrome, Edge, Safari).
// In Chrome the audio is recognised on Google's servers. Where the API is
// missing (Firefox), voice is simply unavailable and long-press just types.

const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;

export const voiceSupported = Boolean(Recognition);

const ERRORS = {
  "not-allowed": "microphone blocked — allow it in the address bar",
  "service-not-allowed": "microphone blocked — allow it in the address bar",
  "audio-capture": "no microphone found",
  network: "speech service unreachable",
  "language-not-supported": "this language is not supported",
};

export class Dictation {
  // onText(finalText, interimText, phrases) while listening; onEnd(errorMessage | null) once.
  // phrases: each finalised result on its own; continuous recognition
  // finalises one at each pause, so the list box puts them on separate lines.
  constructor({ onText, onEnd }) {
    this.onText = onText;
    this.onEnd = onEnd;
    this.rec = null;
  }

  get listening() {
    return this.rec !== null;
  }

  start(lang) {
    if (!voiceSupported || this.rec) return;
    const rec = new Recognition();
    rec.lang = lang;
    rec.continuous = true;
    rec.interimResults = true;
    let error = null;

    rec.onresult = (e) => {
      let final = "";
      let interim = "";
      const phrases = [];
      for (const result of e.results) {
        if (result.isFinal) {
          final += result[0].transcript;
          const phrase = result[0].transcript.trim();
          if (phrase) phrases.push(phrase);
        } else interim += result[0].transcript;
      }
      this.onText(final, interim, phrases);
    };
    rec.onerror = (e) => {
      error = ERRORS[e.error] ?? null; // "no-speech" and "aborted" are not worth a message
    };
    rec.onend = () => {
      if (this.rec === rec) this.rec = null;
      this.onEnd(error);
    };

    this.rec = rec;
    try {
      rec.start();
    } catch {
      this.rec = null;
      this.onEnd("could not start listening");
    }
  }

  // Stop listening; results already spoken still arrive before onEnd.
  stop() {
    this.rec?.stop();
  }
}

// Languages offered by the RU/EN switch; the last one used is remembered.
const LANG_KEY = "mindPalace.voiceLang";

export function voiceLanguages(configured) {
  return configured?.length ? configured : [navigator.language || "en-US"];
}

export function loadLang(langs) {
  try {
    const saved = localStorage.getItem(LANG_KEY);
    if (langs.includes(saved)) return saved;
  } catch {}
  return langs[0];
}

export function saveLang(lang) {
  try {
    localStorage.setItem(LANG_KEY, lang);
  } catch {}
}
