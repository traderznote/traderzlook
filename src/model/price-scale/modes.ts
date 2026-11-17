// Price-scale modes and their transforms. Ranges are stored in logical space: the raw
// price in Normal mode, the transformed price in Log / Percentage / Indexed modes.
import { precisionByMinMove } from '../../fmt';

export const PriceScaleMode = {
  Normal: 0,
  Logarithmic: 1,
  Percentage: 2,
  IndexedTo100: 3,
} as const;
export type PriceScaleMode = (typeof PriceScaleMode)[keyof typeof PriceScaleMode];

export interface LogFormula {
  /** L — added to log10 so typical prices map to positive logicals. */
  readonly logicalOffset: number;
  /** C — keeps prices near 0 finite (avoids log10(0)). */
  readonly coordOffset: number;
}

/** Transforms do not re-sort bounds: a negative base can invert their order. */
export interface MinMax {
  readonly min: number;
  readonly max: number;
}

/** Percentage / Indexed-to-100 have no meaningful absolute range to drag. */
export function refusesManualScale(mode: PriceScaleMode): boolean {
  return mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
}

/** Entering Percentage / Indexed-to-100 forces autoScale on. */
export function isAutoScaleForced(mode: PriceScaleMode): boolean {
  return mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
}

// toPercent(v,b)   = b<0 ? −r : r,   r = 100·(v − b)/b
// fromPercent(p,b) = (p'/100)·b + b, p' = b<0 ? −p : p     (true inverse, both signs)

export function toPercent(value: number, baseValue: number): number {
  const r = (100 * (value - baseValue)) / baseValue;
  return baseValue < 0 ? -r : r;
}

export function fromPercent(percent: number, baseValue: number): number {
  const p = baseValue < 0 ? -percent : percent;
  return (p / 100) * baseValue + baseValue;
}

// Indexed = percent + 100, so the pair is a true inverse for a negative base too.

export function toIndexed(value: number, baseValue: number): number {
  return toPercent(value, baseValue) + 100;
}

export function fromIndexed(indexed: number, baseValue: number): number {
  return fromPercent(indexed - 100, baseValue);
}

// toLog(p)   = 0                              if |p| < 1e−15
//            = sign(p)·(log10(|p| + C) + L)   otherwise
// fromLog(x) = 0                              if |x| < 1e−15
//            = sign(x)·(10^(|x| − L) − C)     otherwise

const LOG_ZERO_EPS = 1e-15;

export function defaultLogFormula(): LogFormula {
  return { logicalOffset: 4, coordOffset: 0.0001 };
}

export function toLog(price: number, formula: LogFormula = defaultLogFormula()): number {
  if (Math.abs(price) < LOG_ZERO_EPS) return 0;
  const abs = Math.abs(price);
  const value = Math.log10(abs + formula.coordOffset) + formula.logicalOffset;
  return price < 0 ? -value : value;
}

export function fromLog(logical: number, formula: LogFormula = defaultLogFormula()): number {
  if (Math.abs(logical) < LOG_ZERO_EPS) return 0;
  const abs = Math.abs(logical);
  const value = 10 ** (abs - formula.logicalOffset) - formula.coordOffset;
  return logical < 0 ? -value : value;
}

export function toLogRange(range: MinMax, formula: LogFormula = defaultLogFormula()): MinMax {
  return { min: toLog(range.min, formula), max: toLog(range.max, formula) };
}

export function fromLogRange(range: MinMax, formula: LogFormula = defaultLogFormula()): MinMax {
  return { min: fromLog(range.min, formula), max: fromLog(range.max, formula) };
}

/**
 * The fixed C=1e−4 flattens sub-1 ranges, so derive {L,C} from the range width:
 *   d ≥ 1 or d < 1e−15 → default;  else L = 4 + ceil(|log10(d)|), C = 10^(−L).
 */
export function logFormulaForRange(rawRange: MinMax | null): LogFormula {
  if (rawRange === null) return defaultLogFormula();
  const d = Math.abs(rawRange.max - rawRange.min);
  if (d >= 1 || d < LOG_ZERO_EPS) return defaultLogFormula();
  const digits = Math.ceil(Math.abs(Math.log10(d)));
  const logicalOffset = 4 + digits;
  return { logicalOffset, coordOffset: 10 ** -logicalOffset };
}

/** false when a bound is not finite in raw space; mode switching then falls back to autoscale. */
export function canConvertFromLog(logRange: MinMax, formula: LogFormula = defaultLogFormula()): boolean {
  const raw = fromLogRange(logRange, formula);
  return Number.isFinite(raw.min) && Number.isFinite(raw.max);
}

/**
 * Re-express a log range (e.g. a live drag snapshot) under a new adaptive formula,
 * preserving the raw prices it denotes so the on-screen range does not jump.
 */
export function reexpressLogRange(range: MinMax, oldFormula: LogFormula, newFormula: LogFormula): MinMax {
  return toLogRange(fromLogRange(range, oldFormula), newFormula);
}

/** Raw-price range, de-noised to the tick grid. */
export interface VisibleRange {
  readonly from: number;
  readonly to: number;
}

/** round(v/minMove)·minMove then toFixed, cancelling the float noise of 10^x.
 *  A non-finite or zero minMove skips the grid snap. */
function snapToTickGrid(value: number, minMove: number, precision: number): number {
  const snapped = Number.isFinite(minMove) && minMove !== 0 ? Math.round(value / minMove) * minMove : value;
  return Number(snapped.toFixed(precision));
}

/** Public getVisibleRange for log mode: raw bounds snapped to the tick grid, not re-sorted. */
export function deNoiseLogVisibleRange(logRange: MinMax, formula: LogFormula, minMove: number): VisibleRange {
  const raw = fromLogRange(logRange, formula);
  const precision = precisionByMinMove(minMove);
  return {
    from: snapToTickGrid(raw.min, minMove, precision),
    to: snapToTickGrid(raw.max, minMove, precision),
  };
}
