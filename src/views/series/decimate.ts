// Shared emit-time column decimation, used by every built-in kind's `decimate`.
// Active only at sub-pixel spacing (`barSpacing · hr < 1`); otherwise it returns null
// and the engine runs the normal convert→emit path. One forward scan over the visible
// store rows emits at most one min/max segment per device-pixel column:
//   • line / area → one (top, bottom) vertex pair per column;
//   • bar / candle → one 1-px-wide hi–lo quad per column;
//   • histogram   → one column rect from the base line to the extremum.
// Cost is O(visibleRows) reads for O(deviceWidth) geometry.
import { assert } from '../../core';
import { LineStyle, type DisplayListBuilder } from '../../gfx';
import type { PlotStoreView } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { ViewFrame } from '../../gfx';
import type { ItemWindow } from './window';

export type DecimateShape = 'line' | 'area' | 'barlike' | 'histogram';

export interface DecimateOptions {
  readonly shape: DecimateShape;
  /** One colour for every column (the kind resolves it once). */
  readonly color: string;
  /** Stroke width for the line/area polyline. */
  readonly lineWidth?: number;
  /** Base line Y in device px (the output is a bitmap list). Required for `histogram`. */
  readonly baseY?: number;
}

export interface DecimateResult {
  /** Always ≤ ceil(deviceWidth). */
  readonly columns: number;
  readonly rowsScanned: number;
}

export function shouldDecimate(barSpacing: number, hr: number): boolean {
  return barSpacing * hr < 1;
}

/**
 * Write decimated geometry into `out` (already `beginList`'d). Returns null when
 * inactive. Rows are time-ordered, so the device column is monotonic: accumulate
 * min/max per column and flush when it advances. NaN rows are skipped.
 */
export function decimateColumns(
  store: PlotStoreView,
  window: ItemWindow,
  frame: ViewFrame,
  horz: HorzGeometry,
  price: PriceConverter,
  out: DisplayListBuilder,
  opts: DecimateOptions,
): DecimateResult | null {
  const hr = frame.frame.hr;
  const vr = frame.frame.vr;
  if (!shouldDecimate(horz.barSpacing, hr)) return null;

  if (__DEV__ && opts.shape === 'histogram') {
    assert(opts.baseY !== undefined, 'histogram decimation requires opts.baseY');
  }

  const from = window.from < 0 ? 0 : window.from;
  const to = window.to > store.length ? store.length : window.to;
  const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);

  // Per-column geometry lives in module-scope `emitColumn` so no closure is created per frame.
  const lineLike = opts.shape === 'line' || opts.shape === 'area';
  const poly = lineLike ? out.polyline(opts.lineWidth ?? 1, LineStyle.Solid, 'miter') : null;
  const rects = lineLike ? null : out.rects({});

  // -1 means "no column open yet", so the first finite row always opens one.
  let curCol = -1;
  let colMin = Number.POSITIVE_INFINITY;
  let colMax = Number.NEGATIVE_INFINITY;
  let columns = 0;
  let rowsScanned = 0;

  for (let i = from; i < to; i++) {
    const lo = store.min(i);
    const hi = store.max(i);
    if (Number.isNaN(lo) || Number.isNaN(hi)) continue;
    rowsScanned++;
    const xMedia = horz.indexToCoordinate(store.timeIndex(i) as number);
    const col = Math.floor(xMedia * hr);
    // The window is extended by ± neighbours, so rows can map off-screen. Those still
    // advance `curCol` but are never emitted, which keeps `columns ≤ deviceWidth`.
    if (col !== curCol) {
      if (curCol >= 0 && curCol < deviceWidth && emitColumn(poly, rects, opts, price, vr, curCol, colMin, colMax))
        columns++;
      curCol = col;
      colMin = lo;
      colMax = hi;
    } else {
      if (lo < colMin) colMin = lo;
      if (hi > colMax) colMax = hi;
    }
  }
  if (curCol >= 0 && curCol < deviceWidth && emitColumn(poly, rects, opts, price, vr, curCol, colMin, colMax))
    columns++;

  if (__DEV__) assert(columns <= deviceWidth, 'decimation emitted more columns than device pixels');
  return { columns, rowsScanned };
}

/** Returns true iff a segment was written. */
function emitColumn(
  poly: ReturnType<DisplayListBuilder['polyline']> | null,
  rects: ReturnType<DisplayListBuilder['rects']> | null,
  opts: DecimateOptions,
  price: PriceConverter,
  vr: number,
  col: number,
  colMin: number,
  colMax: number,
): boolean {
  if (colMin === Number.POSITIVE_INFINITY) return false;
  // Device px: `col` is already a device column; Y is media px ·vr. Y grows downward,
  // so the larger price maps to the top.
  const yTop = price.priceToCoordinate(colMax) * vr;
  const yBot = price.priceToCoordinate(colMin) * vr;
  const x = col;
  const w = 1;
  const fill = opts.color;
  if (poly !== null) {
    poly.vertex(x, yTop, fill);
    poly.vertex(x, yBot, fill);
    poly.gap();
    return true;
  }
  if (rects !== null) {
    if (opts.shape === 'histogram') {
      // From the base line to whichever extremum is furthest from it.
      const baseY = opts.baseY ?? 0;
      const ext = Math.abs(yTop - baseY) >= Math.abs(yBot - baseY) ? yTop : yBot;
      const top = Math.min(ext, baseY);
      rects.quad(x, top, w, Math.abs(ext - baseY), fill);
    } else {
      const h = yBot - yTop;
      rects.quad(x, yTop, w, h < 0 ? 0 : h, fill);
    }
    return true;
  }
  return false;
}
