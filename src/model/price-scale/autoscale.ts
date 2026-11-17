// Autoscale range assembly. Contributors supply raw ranges plus their own firstValue
// (percent/indexed transforms are per-source); the result is in the mode's logical space.
import {
  PriceScaleMode,
  logFormulaForRange,
  toIndexed,
  toLogRange,
  toPercent,
  type LogFormula,
  type MinMax,
} from './modes';

export interface AutoscaleMargins {
  readonly above: number;
  readonly below: number;
}

export interface AutoscaleContributor {
  readonly firstValue: number | null; // null = no data → skipped
  readonly range: MinMax | null; // raw price
  readonly margins: AutoscaleMargins | null;
}

export interface AssembledRange {
  readonly range: MinMax; // in the mode's logical space
  readonly margins: AutoscaleMargins;
  readonly logFormula: LogFormula;
}

/** −Infinity when neither is finite. */
function finiteMin(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return Math.min(a, b);
  if (af) return a;
  if (bf) return b;
  return -Infinity;
}

/** +Infinity when neither is finite. */
function finiteMax(a: number, b: number): number {
  const af = Number.isFinite(a);
  const bf = Number.isFinite(b);
  if (af && bf) return Math.max(a, b);
  if (af) return a;
  if (bf) return b;
  return Infinity;
}

/** Per-bound merge where a finite bound wins over a non-finite one. */
export function finiteMerge(a: MinMax, b: MinMax): MinMax {
  return { min: finiteMin(a.min, b.min), max: finiteMax(a.max, b.max) };
}

/** Max-merge of margins; the single merge used by series, primitives and indicators. */
export function mergeMargins(margins: readonly AutoscaleMargins[]): AutoscaleMargins {
  let above = 0;
  let below = 0;
  for (const m of margins) {
    if (m.above > above) above = m.above;
    if (m.below > below) below = m.below;
  }
  return { above, below };
}

/** A zero-width range is widened by ±5·minMove. */
function widenIfDegenerate(range: MinMax, minMove: number): MinMax {
  if (range.min === range.max) {
    return { min: range.min - 5 * minMove, max: range.max + 5 * minMove };
  }
  return range;
}

/** null when nothing contributes a range (the caller keeps its existing range). */
export function assembleRange(opts: {
  contributors: readonly AutoscaleContributor[];
  mode: PriceScaleMode;
  minMove: number;
  logFormula: LogFormula;
}): AssembledRange | null {
  const { contributors, mode, minMove } = opts;
  const isPercentLike = mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
  const transform = mode === PriceScaleMode.Percentage ? toPercent : toIndexed;

  const marginsList: AutoscaleMargins[] = [];
  let mergedRaw: MinMax | null = null;
  let mergedTransformed: MinMax | null = null;

  for (const c of contributors) {
    if (c.firstValue === null || c.range === null) continue;
    if (c.margins !== null) marginsList.push(c.margins);
    mergedRaw = mergedRaw === null ? c.range : finiteMerge(mergedRaw, c.range);
    if (isPercentLike) {
      // each source is transformed by its own first value before merging.
      const tr: MinMax = {
        min: transform(c.range.min, c.firstValue),
        max: transform(c.range.max, c.firstValue),
      };
      mergedTransformed = mergedTransformed === null ? tr : finiteMerge(mergedTransformed, tr);
    }
  }

  if (mergedRaw === null) return null;
  const margins = mergeMargins(marginsList);

  if (isPercentLike) {
    const range = widenIfDegenerate(mergedTransformed as MinMax, minMove);
    return { range, margins, logFormula: opts.logFormula };
  }
  if (mode === PriceScaleMode.Logarithmic) {
    // widen in raw space first, then re-derive the adaptive formula and re-log.
    const widenedRaw = widenIfDegenerate(mergedRaw, minMove);
    const logFormula = logFormulaForRange(widenedRaw);
    return { range: toLogRange(widenedRaw, logFormula), margins, logFormula };
  }
  return { range: widenIfDegenerate(mergedRaw, minMove), margins, logFormula: opts.logFormula };
}
