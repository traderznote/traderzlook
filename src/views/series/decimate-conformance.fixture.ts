// Headless fixtures for the decimation helper: a seeded store, the bulk-scene
// parameters, and a stub per-device-column raster for checking visual parity between
// decimated and full-resolution output within AA tolerance.
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { ViewFrame } from '../../gfx';
import type { DisplayList, PolylineCommand, RectsCommand } from '../../gfx';
import type { PlotStoreView } from '../../data';
import type { TimeIndex } from '../../core';

/** Deterministic seeded PRNG. */
export function mulberry32(seed = 0x7eadbeef): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `timeIndex(i) == startIndex + i`, so rows map left→right monotonically (the
 *  helper's forward-scan precondition). Line fixtures pass lows === highs === closes;
 *  NaN rows model gaps. */
export function fixtureStore(
  lows: readonly number[],
  highs: readonly number[],
  closes: readonly number[] = lows,
  startIndex = 0,
): PlotStoreView {
  const n = lows.length;
  return {
    length: n,
    timeIndex: (i) => (startIndex + i) as TimeIndex,
    current: (i) => closes[i]!,
    min: (i) => lows[i]!,
    max: (i) => highs[i]!,
    lane: (k, i) => (k === 0 ? lows[i]! : k === 1 ? highs[i]! : closes[i]!),
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

/** Seeded random walk of `n` OHLC rows. */
export function seededWalk(n: number, seed = 0x7eadbeef): PlotStoreView {
  const rnd = mulberry32(seed);
  const lows: number[] = new Array(n);
  const highs: number[] = new Array(n);
  const closes: number[] = new Array(n);
  let price = 100;
  for (let i = 0; i < n; i++) {
    price += (rnd() - 0.5) * 2;
    const c = price;
    const spread = 0.5 + rnd();
    lows[i] = c - spread;
    highs[i] = c + spread;
    closes[i] = c;
  }
  return fixtureStore(lows, highs, closes, 0);
}

/** Y = K − price in media px, so a larger price maps higher on screen. */
export function fixturePrice(k = 1000): PriceConverter {
  return {
    priceToCoordinate: (price) => k - price,
    firstValue: null,
    mode: 'normal',
    toLogical: (price) => price,
  };
}

/** Square device ratios (`hr === vr`), `bitmapSize = mediaSize·hr`. */
export function fixtureFrame(mediaWidth: number, mediaHeight: number, hr: number): ViewFrame {
  return {
    frame: {
      mediaSize: { width: mediaWidth, height: mediaHeight },
      bitmapSize: { width: mediaWidth * hr, height: mediaHeight * hr },
      hr,
      vr: hr,
    },
    now: 0,
  };
}

export function fixtureHorz(barSpacing: number, baseIndex: number, width: number): HorzGeometry {
  return createHorzGeometry({ width, barSpacing, rightOffset: 0, baseIndex });
}

/**
 * The bulk scene: 1 M points fit into a 1600×900 DPR-2 viewport, so barSpacing·hr ≪ 1
 * and decimation is active. `commandCap` is the draw-command budget for that frame.
 */
export const S8_SCENE = {
  points: 1_000_000,
  mediaWidth: 1600,
  mediaHeight: 900,
  hr: 2,
  /** fitContent spacing (media px per bar) when all `points` fill `mediaWidth`. */
  get barSpacing(): number {
    return this.mediaWidth / this.points;
  },
  commandCap: 60,
} as const;

/** Per device column, the inclusive [yTop, yBot] span (device px) any geometry painted. */
export interface ColumnRaster {
  readonly width: number;
  readonly touched: Uint8Array;
  readonly yTop: Float64Array; // ∞ if untouched
  readonly yBot: Float64Array; // −∞ if untouched
}

function blankRaster(width: number): ColumnRaster {
  const w = Math.max(0, Math.ceil(width));
  const yTop = new Float64Array(w).fill(Number.POSITIVE_INFINITY);
  const yBot = new Float64Array(w).fill(Number.NEGATIVE_INFINITY);
  return { width: w, touched: new Uint8Array(w), yTop, yBot };
}

function cover(r: ColumnRaster, col: number, y0: number, y1: number): void {
  const c = Math.floor(col);
  if (c < 0 || c >= r.width) return;
  const lo = Math.min(y0, y1);
  const hi = Math.max(y0, y1);
  r.touched[c] = 1;
  if (lo < r.yTop[c]!) r.yTop[c] = lo;
  if (hi > r.yBot[c]!) r.yBot[c] = hi;
}

/**
 * Reduce device-px display lists to per-column vertical coverage. Polylines are
 * connected segments (NaN = pen-up); each rect covers columns [x, x+w) over [y, y+h].
 */
export function composeColumns(lists: readonly DisplayList[], deviceWidth: number): ColumnRaster {
  const raster = blankRaster(deviceWidth);
  for (const list of lists) {
    for (const cmd of list.commands) {
      if (cmd.kind === 'polyline') rasterPolyline(raster, cmd);
      else if (cmd.kind === 'rects') rasterRects(raster, cmd);
    }
  }
  return raster;
}

function rasterPolyline(r: ColumnRaster, cmd: PolylineCommand): void {
  const p = cmd.points;
  let hasPrev = false;
  let px = 0;
  let py = 0;
  for (let o = 0; o + 1 < p.length; o += 2) {
    const x = p[o]!;
    const y = p[o + 1]!;
    if (Number.isNaN(x) || Number.isNaN(y)) {
      hasPrev = false;
      continue;
    }
    if (hasPrev) coverSegment(r, px, py, x, y);
    else cover(r, x, y, y); // a lone start vertex still covers its own pixel
    px = x;
    py = y;
    hasPrev = true;
  }
}

/** Cover each column the segment crosses with its (linearly interpolated) Y extent
 *  there; a vertical segment covers its single column's full span. */
function coverSegment(r: ColumnRaster, ax: number, ay: number, bx: number, by: number): void {
  const dx = bx - ax;
  if (dx === 0) {
    cover(r, ax, ay, by);
    return;
  }
  const x0 = Math.min(ax, bx);
  const x1 = Math.max(ax, bx);
  const c0 = Math.floor(x0);
  const c1 = Math.floor(x1);
  const yAt = (x: number): number => ay + ((x - ax) / dx) * (by - ay);
  for (let c = c0; c <= c1; c++) {
    const lo = Math.max(x0, c);
    const hi = Math.min(x1, c + 1);
    if (hi < lo) continue;
    cover(r, c, yAt(lo), yAt(hi));
  }
}

function rasterRects(r: ColumnRaster, cmd: RectsCommand): void {
  const c = cmd.coords;
  for (let o = 0; o + 3 < c.length; o += 4) {
    const x = c[o]!;
    const y = c[o + 1]!;
    const w = c[o + 2]!;
    const h = c[o + 3]!;
    const x0 = Math.floor(x);
    const x1 = Math.ceil(x + w);
    for (let col = x0; col < x1; col++) cover(r, col, y, y + h);
  }
}

/** Parity below 1 bar/pixel is not bit-identity: each column must be touched by both
 *  rasters or neither, with extents agreeing within tolerance. */
export interface RasterDiff {
  readonly maxDelta: number; // worst |yTop−yTop'| or |yBot−yBot'| over co-touched columns
  readonly coverageMismatch: number; // columns touched by exactly one raster
  readonly firstMismatchCol: number; // -1 if none
}

export function diffColumns(a: ColumnRaster, b: ColumnRaster): RasterDiff {
  const w = Math.max(a.width, b.width);
  let maxDelta = 0;
  let coverageMismatch = 0;
  let firstMismatchCol = -1;
  for (let c = 0; c < w; c++) {
    const ta = c < a.width ? a.touched[c]! : 0;
    const tb = c < b.width ? b.touched[c]! : 0;
    if (ta !== tb) {
      coverageMismatch++;
      if (firstMismatchCol < 0) firstMismatchCol = c;
      continue;
    }
    if (ta === 0) continue;
    const dTop = Math.abs(a.yTop[c]! - b.yTop[c]!);
    const dBot = Math.abs(a.yBot[c]! - b.yBot[c]!);
    const d = Math.max(dTop, dBot);
    if (d > maxDelta) maxDelta = d;
    if (firstMismatchCol < 0 && d > 0) firstMismatchCol = c;
  }
  return { maxDelta, coverageMismatch, firstMismatchCol };
}

/**
 * The full-resolution picture at sub-pixel spacing: one ~1-px mark per row, overdrawn
 * within a column, so the visible result is the column's min/max union — what a single
 * decimated segment reproduces. This is the correct parity baseline, not the connected
 * emit polyline, whose slanted segments paint pixels the overlapping marks never did.
 */
export function referenceColumnEnvelope(
  store: PlotStoreView,
  from: number,
  to: number,
  frame: ViewFrame,
  horz: HorzGeometry,
  price: PriceConverter,
): ColumnRaster {
  const hr = frame.frame.hr;
  const vr = frame.frame.vr;
  const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
  const r = blankRaster(deviceWidth);
  const lo = from < 0 ? 0 : from;
  const hi = to > store.length ? store.length : to;
  for (let i = lo; i < hi; i++) {
    const min = store.min(i);
    const max = store.max(i);
    if (Number.isNaN(min) || Number.isNaN(max)) continue;
    const col = Math.floor(horz.indexToCoordinate(store.timeIndex(i) as number) * hr);
    cover(r, col, price.priceToCoordinate(max) * vr, price.priceToCoordinate(min) * vr);
  }
  return r;
}

/** Half a device pixel: the most a min/max segment's edge can differ from the
 *  overlapping-draw envelope it replaces. */
export const AA_TOLERANCE = 0.5;
