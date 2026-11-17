// Pure wheel normalization: WheelEvent-like → { scroll, zoom }. Getting any factor wrong
// changes feel ~100×, so the constants are named and golden-tested.

// WheelEvent.DOM_DELTA_* codes, kept local so this file stays lib.dom-free.
const DELTA_MODE_PIXEL = 0;
const DELTA_MODE_LINE = 1;
const DELTA_MODE_PAGE = 2;

/** Per-notch normalization factors: one page / one line of delta. */
export const WHEEL_DELTA_PAGE = 120;
export const WHEEL_DELTA_LINE = 32;
const SCROLL_COEFF = -80; // empirical px-per-unit; minus = natural scroll
const DELTA_DIVISOR = 100; // the /100 applied to BOTH axes

export interface WheelLike {
  deltaMode: number; // 0 PIXEL | 1 LINE | 2 PAGE
  deltaX: number;
  deltaY: number;
  ctrlKey: boolean;
}

/** `scroll` is horizontal px; `zoom` is a ±1-clamped step; `ctrlKey` passes through so
 *  ctrl+vertical can be treated as a zoom intent. */
export interface NormalizedWheel {
  scroll: number;
  zoom: number;
  ctrlKey: boolean;
}

const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

/** On Windows Chromium, PIXEL deltas arrive scaled by DPR (bug 1001735), so they are divided back out. */
export function normalizeWheel(
  e: WheelLike,
  speed = 1,
  windowsChromium = false,
  dpr = 1,
): NormalizedWheel {
  let adj: number;
  if (e.deltaMode === DELTA_MODE_PAGE) adj = WHEEL_DELTA_PAGE;
  else if (e.deltaMode === DELTA_MODE_LINE) adj = WHEEL_DELTA_LINE;
  else adj = windowsChromium ? 1 / dpr : 1; // PIXEL
  void DELTA_MODE_PIXEL; // documents the third code; PIXEL is the fall-through branch

  const dx = (adj * e.deltaX) / DELTA_DIVISOR * speed;
  const dy = (-(adj * e.deltaY) / DELTA_DIVISOR) * speed;
  return {
    scroll: dx !== 0 ? dx * SCROLL_COEFF : 0,
    zoom: dy !== 0 ? sign(dy) * Math.min(1, Math.abs(dy)) : 0,
    ctrlKey: e.ctrlKey,
  };
}
