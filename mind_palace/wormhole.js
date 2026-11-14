// Wormhole transition maths ("dive through"). Pure, so it can be tested.
//
// Out: the view dives toward the wormhole; every light is pulled into it on a
// tightening swirl while darkness spreads from the ring. At the midpoint the
// canvas is swapped. In: the new canvas's lights bloom out of the return
// wormhole, unwinding the other way, as the darkness opens up from it.

export const WARP = { outMs: 450, inMs: 450, swirl: 1.2, zoom: 4 };
// Reduced motion: a short fade through dark, nothing flies.
export const WARP_CALM = { outMs: 100, inMs: 100, swirl: 0, zoom: 0 };

export const smooth = (t) => {
  t = Math.min(1, Math.max(0, t));
  return t * t * (3 - 2 * t);
};

// Where the transition is at `now`. k: 0 = canvas untouched, 1 = everything
// inside the wormhole. cover: how much of the screen the tunnel darkens; it
// lags k so the swirl reads before the dark takes over. zoom: camera zoom
// at k = 1 (half on the way in, so arriving lights don't loom).
export function warpState(warp, now) {
  const t = now - warp.t0;
  const { outMs, inMs } = warp.params;
  if (t < outMs) {
    const k = smooth(t / outMs);
    return { phase: "out", k, cover: k * k, swirl: warp.params.swirl, zoom: warp.params.zoom };
  }
  if (t < outMs + inMs) {
    const k = 1 - smooth((t - outMs) / inMs);
    return { phase: "in", k, cover: k * k, swirl: -warp.params.swirl, zoom: warp.params.zoom / 2 };
  }
  return { phase: "done", k: 0, cover: 0, swirl: 0, zoom: 0 };
}

// Pull (x, y) toward origin (ox, oy) by k, rotating it by swirl·k² so the
// path curls in rather than running straight. Writes into `out`.
export function warpPoint(x, y, ox, oy, k, swirl, out) {
  const f = 1 - k;
  const th = swirl * k * k;
  const c = Math.cos(th);
  const s = Math.sin(th);
  const dx = x - ox;
  const dy = y - oy;
  out.x = ox + (dx * c - dy * s) * f;
  out.y = oy + (dx * s + dy * c) * f;
  return out;
}

// Camera zoom about the origin: none at rest, `zoom`× more at the midpoint.
export const warpZoom = (k, zoom) => 1 + zoom * k * k;
