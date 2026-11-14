// Fixed colours: nothing drifts with the hour. The background is one per
// theme; the accent belongs to the canvas. Every canvas has its own hue at
// the same OKLCH lightness and chroma, so all look equally bright and none
// goes muddy. Light mode is paper with deeper versions of the same hues, so
// marks read as ink rather than light.
// The theme follows a schedule (light from lightAt, dark from darkAt); ◐
// overrides it until the next switch time.

const LOOKS = {
  dark: { bg: "#0b0d12", l: 0.84, c: 0.08 },
  light: { bg: "#f1f1ec", l: 0.53, c: 0.095 },
};
export const DEFAULT_HUE = 200; // a canvas with no hue yet

const hexToRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
export const toHex = (rgb) => "#" + rgb.map((v) => v.toString(16).padStart(2, "0")).join("");

// OKLCH -> linear sRGB (Björn Ottosson's OKLab matrices).
function oklchLinear(l, c, hue) {
  const h = (hue * Math.PI) / 180;
  const a = c * Math.cos(h);
  const b = c * Math.sin(h);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const encode = (v) => Math.round(255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055));

// A canvas's accent in a theme. Outside sRGB the chroma gives way, never
// the lightness, so every hue keeps the same brightness.
export function canvasAccent(hue, theme = "dark") {
  const { l, c } = LOOKS[theme] ?? LOOKS.dark;
  let k = c;
  let rgb = oklchLinear(l, k, hue ?? DEFAULT_HUE);
  while (k > 0 && rgb.some((v) => v < 0 || v > 1)) {
    k -= 0.002;
    rgb = oklchLinear(l, k, hue ?? DEFAULT_HUE);
  }
  return rgb.map((v) => encode(Math.min(1, Math.max(0, v))));
}

export function paletteFor(theme = "dark") {
  const name = LOOKS[theme] ? theme : "dark";
  const bg = LOOKS[name].bg;
  return { theme: name, bg, bgRgb: hexToRgb(bg) };
}

export function currentHour(date = new Date()) {
  return date.getHours() + date.getMinutes() / 60;
}

// Light from lightAt until darkAt, dark the rest of the day.
export function scheduledTheme(hour, lightAt = 7, darkAt = 19) {
  const day = lightAt <= darkAt ? hour >= lightAt && hour < darkAt : hour >= lightAt || hour < darkAt;
  return day ? "light" : "dark";
}

// The next switch time strictly after `date`: where a hand-picked theme
// gives way to the schedule again.
export function nextSwitch(date, lightAt = 7, darkAt = 19) {
  let best = null;
  for (const at of [lightAt, darkAt]) {
    const d = new Date(date);
    d.setHours(Math.floor(at), Math.round((at % 1) * 60), 0, 0);
    if (d <= date) d.setDate(d.getDate() + 1);
    if (!best || d < best) best = d;
  }
  return best;
}

export function applyPalette(p) {
  const root = document.documentElement;
  // Opening the page: no fade from the stylesheet's default (dark)
  // background, or light ink sits on near-black for a moment.
  if (!root.dataset.theme) {
    root.classList.add("theme-init");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("theme-init")));
  }
  root.dataset.theme = p.theme;
  root.style.setProperty("--bg", p.bg);
  root.style.setProperty("--accent", p.accent);
  root.style.setProperty("--accent-rgb", p.accentRgb.join(", "));
}
