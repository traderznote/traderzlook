// Shared scaffold for column kinds (Histogram, Bar, Candlestick): OHLC lane access,
// crisp column widths and the range hit test. Per-kind emit stays in each kind.
import { lowerBound } from '../../core';
import { HitPriority } from '../../gfx';
import type { HitCandidate } from '../../gfx';
import { applyBarParity, optimalBarWidth, optimalCandlestickWidth } from '../../gfx';

/** `extra` holds media-px Y as [open, high, low, close] per item. */
export const OHLC_LANE_STRIDE = 4;

export const OHLC = {
  Open: 0,
  High: 1,
  Low: 2,
  Close: 3,
} as const;
export type OHLC = (typeof OHLC)[keyof typeof OHLC];

export function ohlc(extra: Float32Array, i: number, k: OHLC): number {
  return extra[i * OHLC_LANE_STRIDE + k]!;
}

export function setOhlc(extra: Float32Array, i: number, k: OHLC, y: number): void {
  extra[i * OHLC_LANE_STRIDE + k] = y;
}

/** `max(floor(hr), optimalBarWidth)`, then parity against the bar line width
 *  `max(1, floor(hr))`. */
export function barColumnWidth(barSpacing: number, hr: number): number {
  const w = Math.max(Math.floor(hr), optimalBarWidth(barSpacing, hr));
  return applyBarParity(w, Math.max(1, Math.floor(hr)));
}

/** Parity against the wick width `floor(hr)` — deliberately distinct from bars. */
export function candleColumnWidth(barSpacing: number, hr: number): number {
  return applyBarParity(optimalCandlestickWidth(barSpacing, hr), Math.floor(hr));
}

/** Vertical extent of item `i`'s column in media-px Y (top ≤ bottom). */
export type ColumnSpan = (i: number) => { readonly top: number; readonly bottom: number };

/**
 * Range hit over `[from, to)` in media px. The cursor's column slot runs from the
 * midpoint with the previous column to the midpoint with the next; a side falls back
 * to `x ∓ barSpacing/2` when that neighbour is absent (time index not exactly ±1, or
 * at the visible edge). The slot is widened by `tolerance`. Inside the vertical span
 * → distance 0, else the distance to the nearest edge.
 */
export function hitTestColumns(
  xs: Float32Array,
  timeIndex: Int32Array,
  span: ColumnSpan,
  from: number,
  to: number,
  px: number,
  py: number,
  barSpacing: number,
  tolerance: number,
): HitCandidate | null {
  const count = to - from;
  if (count === 0) return null;
  const half = barSpacing / 2;
  const reach = half + tolerance;
  const last = to - 1;
  const lo = lowerBound(xs, px - reach, (a, v) => (a as number) < (v as number), from, to);
  let best: HitCandidate | null = null;
  for (let i = lo > from ? lo - 1 : from; i < to; i++) {
    const x = xs[i]!;
    if (x - reach > px) break;
    if (Number.isNaN(x)) continue;
    const prevPresent = i > from && timeIndex[i - 1] === timeIndex[i]! - 1;
    const nextPresent = i < last && timeIndex[i + 1] === timeIndex[i]! + 1;
    const left = (prevPresent ? (xs[i - 1]! + x) / 2 : x - half) - tolerance;
    const right = (nextPresent ? (x + xs[i + 1]!) / 2 : x + half) + tolerance;
    if (px < left || px > right) continue;
    const { top, bottom } = span(i);
    if (Number.isNaN(top) || Number.isNaN(bottom)) continue;
    let dy: number;
    if (py < top) dy = top - py;
    else if (py > bottom) dy = py - bottom;
    else dy = 0;
    if (dy > tolerance) continue;
    if (best === null || dy < best.distance) best = { distance: dy, priority: HitPriority.Range };
  }
  return best;
}
