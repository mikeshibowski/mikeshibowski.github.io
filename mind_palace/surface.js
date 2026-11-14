// The swell: a slow surface under the canvas, made of a few long Gerstner
// waves. The background is shaded from its slope, and every light floats on
// it, so items trace small loops that never quite repeat and rise or sink a
// little with the surface. Everything here is pure, so it can be tested.

const WAVES = [
  // direction (deg), wavelength (px), period (s), relative amplitude
  [20, 820, 150, 1.0],
  [115, 560, 113, 0.7],
  [205, 390, 97, 0.45],
  [290, 680, 171, 0.8],
].map(([deg, len, period, amp]) => {
  const a = (deg * Math.PI) / 180;
  return { dx: Math.cos(a), dy: Math.sin(a), k: (2 * Math.PI) / len, w: (2 * Math.PI) / period, amp };
});
const AMP_SUM = WAVES.reduce((s, w) => s + w.amp, 0);

// Light falls from the upper left, like a window beside the screen.
const LIGHT = [-Math.SQRT1_2, -Math.SQRT1_2];

// Fills `out` for world point (x, y) at time t (seconds):
//   h      height, -1..1 (crest = closer to you)
//   shade  how much the slope faces the light, -1..1
//   ox, oy horizontal Gerstner displacement, -1..1 (scale it to px yourself)
export function swellAt(x, y, t, out = {}) {
  let h = 0, shade = 0, ox = 0, oy = 0;
  for (const wv of WAVES) {
    const phase = wv.k * (wv.dx * x + wv.dy * y) - wv.w * t;
    const c = Math.cos(phase);
    const s = Math.sin(phase);
    h += wv.amp * s;
    shade -= wv.amp * c * (wv.dx * LIGHT[0] + wv.dy * LIGHT[1]);
    ox += wv.amp * wv.dx * c;
    oy += wv.amp * wv.dy * c;
  }
  out.h = h / AMP_SUM;
  out.shade = shade / AMP_SUM;
  out.ox = ox / AMP_SUM;
  out.oy = oy / AMP_SUM;
  return out;
}

// Background light for one point: 0..1, meant to be multiplied by a small
// strength (a few percent), so the swell is felt more than seen.
// Squared, so troughs fall back to the plain background and only the lit
// slopes and crests glow.
export const swellLight = (sw) => {
  const v = Math.min(1, Math.max(0, 0.5 + 0.35 * sw.shade + 0.15 * sw.h));
  return v * v;
};
