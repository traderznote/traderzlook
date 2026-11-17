// Crisp-pixel rules as pure functions: emitters produce bitmap-space coordinates
// with these, and backends draw them verbatim.

export function crispWidth(mediaWidth: number, ratio: number): number {
  return Math.max(1, Math.floor(mediaWidth * ratio));
}

export function crispRound(coord: number, ratio: number): number {
  return Math.round(coord * ratio);
}

/** Odd widths get a half-pixel shift; parity is the LINE's bitmap width, not the surface's. */
export function crispStrokePos(coord: number, ratio: number, lineBitmapWidth: number): number {
  return Math.round(coord * ratio) + (lineBitmapWidth % 2 ? 0.5 : 0);
}

export interface TickRect {
  pos: number;
  thickness: number;
  length: number;
}

/** A tick/border drawn as a filled rect instead of a stroke, recentred on `coord`. */
export function tickRect(coord: number, ratio: number, length: number): TickRect {
  return {
    pos: Math.round(coord * ratio) - Math.floor(ratio * 0.5),
    thickness: Math.max(1, Math.floor(ratio)),
    length,
  };
}

export interface EdgeRect {
  x: number;
  w: number;
}

export function edgeToRect(left: number, right: number): EdgeRect {
  return { x: left, w: right - left + 1 };
}

export function optimalBarWidth(barSpacing: number, ratio: number): number {
  return Math.floor(barSpacing * 0.3 * ratio);
}

/** Plateau at 2.5–4 spacing, else an atan taper from 1× toward 0.8× spacing, clamped. */
export function optimalCandlestickWidth(barSpacing: number, ratio: number): number {
  if (barSpacing >= 2.5 && barSpacing <= 4) {
    return Math.floor(3 * ratio);
  }
  const coeff = 1 - (0.2 * Math.atan(Math.max(4, barSpacing) - 4)) / (Math.PI * 0.5);
  const res = Math.floor(barSpacing * coeff * ratio);
  return Math.max(Math.floor(ratio), Math.min(res, Math.floor(barSpacing * ratio)));
}

/**
 * Match the bar's parity to the crosshair line width so a centered crosshair bisects
 * it symmetrically. Bars pass `max(1, floor(hr))`, candles `floor(hr)`.
 */
export function applyBarParity(width: number, refLineWidth: number): number {
  if (width >= 2 && width % 2 !== refLineWidth % 2) {
    return width - 1;
  }
  return width;
}

export function evenFloor(x: number): number {
  return 2 * Math.floor(x / 2);
}

export function evenCeil(x: number): number {
  return 2 * Math.ceil(x / 2);
}

export function ceiledOdd(x: number): number {
  const c = Math.ceil(x);
  return c % 2 === 0 ? c - 1 : c;
}

export function ceiledEven(x: number): number {
  const c = Math.ceil(x);
  return c % 2 !== 0 ? c - 1 : c;
}
