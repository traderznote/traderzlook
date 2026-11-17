// Immutable price⇄coordinate snapshot with no model reference.
// h = H − top − bottom margins; the drawable band is h − 1 px and the pane bottom is H − 1.
// Coordinates are not rounded. An empty scale (H ≤ 0, no range, min == max, NaN) maps to 0.
import { PriceScaleMode, fromLog, toLog, type LogFormula, type MinMax } from './modes';

export interface PriceGeometryParams {
  /** H: scale height, media px. */
  readonly height: number;
  /** Visible range in logical space (null on an unset/empty scale). */
  readonly range: MinMax | null;
  /** Fractions of H. */
  readonly scaleMargins: { readonly top: number; readonly bottom: number };
  /** Pixel autoscale margin above the data; adds to the top fraction. */
  readonly marginAbovePx: number;
  readonly marginBelowPx: number;
  /** Only Logarithmic transforms here; Percentage/Indexed ranges are already logical. */
  readonly mode: PriceScaleMode;
  readonly inverted: boolean;
  /** Only consulted in Logarithmic mode. */
  readonly logFormula: LogFormula;
}

export interface PriceGeometry extends PriceGeometryParams {
  /** top·H + marginAbovePx. */
  readonly marginNearMaxLogical: number;
  /** bottom·H + marginBelowPx. */
  readonly marginNearMinLogical: number;
  readonly topMarginPx: number;
  readonly bottomMarginPx: number;
  readonly internalHeight: number;
  readonly isEmpty: boolean;
  logicalToCoordinate(logical: number): number;
  coordinateToLogical(coord: number): number;
}

function rangeIsEmpty(range: MinMax | null): boolean {
  if (range === null) return true;
  if (!Number.isFinite(range.min) || !Number.isFinite(range.max)) return true;
  return range.min === range.max;
}

export function createPriceGeometry(p: PriceGeometryParams): PriceGeometry {
  const H = p.height;

  const marginNearMaxLogical = p.scaleMargins.top * H + p.marginAbovePx;
  const marginNearMinLogical = p.scaleMargins.bottom * H + p.marginBelowPx;

  // Margins are computed once relative to max/min; inversion only swaps which is on top.
  const topMarginPx = p.inverted ? marginNearMinLogical : marginNearMaxLogical;
  const bottomMarginPx = p.inverted ? marginNearMaxLogical : marginNearMinLogical;
  const internalHeight = H - topMarginPx - bottomMarginPx;

  const isEmpty = !(H > 0) || rangeIsEmpty(p.range);
  const isLog = p.mode === PriceScaleMode.Logarithmic;

  const logicalToCoordinate = (logical: number): number => {
    if (isEmpty) return 0;
    const range = p.range as MinMax;
    // exactly 0 skips the log transform.
    let value = logical;
    if (isLog && logical !== 0) value = toLog(logical, p.logFormula);
    const length = range.max - range.min;
    const inv = bottomMarginPx + (internalHeight - 1) * ((value - range.min) / length);
    return p.inverted ? inv : H - 1 - inv;
  };

  const coordinateToLogical = (coord: number): number => {
    if (isEmpty) return 0;
    const range = p.range as MinMax;
    const inv = p.inverted ? coord : H - 1 - coord;
    const length = range.max - range.min;
    const logical = range.min + length * ((inv - bottomMarginPx) / (internalHeight - 1));
    return isLog ? fromLog(logical, p.logFormula) : logical;
  };

  return Object.freeze({
    ...p,
    marginNearMaxLogical,
    marginNearMinLogical,
    topMarginPx,
    bottomMarginPx,
    internalHeight,
    isEmpty,
    logicalToCoordinate,
    coordinateToLogical,
  });
}
