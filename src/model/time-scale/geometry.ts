// Immutable horizontal-mapping snapshot with no model reference.
//   indexToCoordinate(v)   = W − (B + R − v + 0.5)·S − 1
//   coordinateToLogical(x) = B + R + 0.5 − (W − 1 − x)/S   (1e-6-quantized)
// +0.5 centers an index in its bar slot; −1 anchors the right edge to column W − 1.
// The two are exact continuous inverses (no snapping) so zoom anchors and drawing tools
// keep sub-bar precision; integer snapping happens in the api layer.
import type { Logical } from '../../core';

export interface HorzGeometryParams {
  /** W: scale width, media px. */
  readonly width: number;
  /** S: media px per bar. */
  readonly barSpacing: number;
  /** R: bars of right margin (may be fractional / negative). */
  readonly rightOffset: number;
  /** B: newest TimeIndex with data. */
  readonly baseIndex: number;
}

/** Inclusive integer bar range, floor/ceil-widened from the logical borders. */
export interface StrictRange {
  readonly left: number;
  readonly right: number;
}

export interface LogicalRange {
  readonly from: Logical;
  readonly to: Logical;
}

export interface HorzGeometry extends HorzGeometryParams {
  indexToCoordinate(ix: number): number;
  coordinateToLogical(x: number): Logical;
  /** null on an empty scale. */
  visibleLogicalRange(): LogicalRange | null;
  /** `[floor(left), ceil(right)]`, or null on an empty scale. */
  visibleStrictRange(): StrictRange | null;
}

/** Quantize to 1e-6 to kill accumulated FP error. */
function quantize(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

function isEmpty(p: HorzGeometryParams): boolean {
  return !(p.width > 0);
}

export function createHorzGeometry(p: HorzGeometryParams): HorzGeometry {
  const { width: W, barSpacing: S, rightOffset: R, baseIndex: B } = p;

  const indexToCoordinate = (ix: number): number => W - (B + R - ix + 0.5) * S - 1;

  const coordinateToLogical = (x: number): Logical =>
    quantize(B + R + 0.5 - (W - 1 - x) / S) as Logical;

  const visibleLogicalRange = (): LogicalRange | null => {
    if (isEmpty(p)) return null;
    const barsLength = W / S;
    const rightBorder = R + B;
    const leftBorder = rightBorder - barsLength + 1;
    return { from: leftBorder as Logical, to: rightBorder as Logical };
  };

  const visibleStrictRange = (): StrictRange | null => {
    const lr = visibleLogicalRange();
    if (lr === null) return null;
    return { left: Math.floor(lr.from as number), right: Math.ceil(lr.to as number) };
  };

  return Object.freeze({
    width: W,
    barSpacing: S,
    rightOffset: R,
    baseIndex: B,
    indexToCoordinate,
    coordinateToLogical,
    visibleLogicalRange,
    visibleStrictRange,
  });
}
