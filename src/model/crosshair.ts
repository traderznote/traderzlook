// Crosshair state. The model never hit-tests; the host sets HoverTarget from views
// results, and touch-tracking entry/exit lives in host/input.
import type { Coordinate, CursorStyle, TimeIndex } from '../core';

export const CrosshairMode = {
  Normal: 'normal',
  Magnet: 'magnet',
  Hidden: 'hidden',
  MagnetOHLC: 'magnet-ohlc',
} as const;
export type CrosshairMode = (typeof CrosshairMode)[keyof typeof CrosshairMode];

/** `x`/`y` are the applied (snapped) media coords; `originX`/`originY` keep the raw
 *  pointer so scroll/zoom can re-snap. */
export interface CrosshairPosition {
  readonly index: TimeIndex;
  readonly price: number; // NaN when the scale is empty / cleared
  readonly x: Coordinate; // NaN when cleared
  readonly y: Coordinate; // NaN when cleared
  readonly originX: Coordinate;
  readonly originY: Coordinate;
}

/** One series' values at the hovered index; single-value series repeat the value in all
 *  four slots. NaN values (no datum) are never snapped to. `priceToCoordinate` is the
 *  series' own scale; when absent the pane's default scale is used. */
export interface MagnetCandidate {
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly priceToCoordinate?: (price: number) => number;
}

/** Conversions for the pane's default price scale. */
export interface MagnetConverters {
  priceToCoordinate(price: number): number;
  coordinateToPrice(coordinate: number): number;
}

export interface MagnetSnapArgs extends MagnetConverters {
  readonly mode: CrosshairMode;
  readonly price: number;
  readonly candidates: readonly MagnetCandidate[];
}

/** The hovered source, copied in by the host from a views hit test. */
export interface HoverTarget {
  readonly sourceId: string;
  readonly seriesId?: string;
  readonly externalId?: string;
  readonly cursor?: CursorStyle;
  readonly data?: unknown;
}

/**
 * Magnet snaps to the nearest close; MagnetOHLC to the nearest OHLC level. Comparison
 * is in pixel space (each candidate through its own scale) so series on different
 * scales compete fairly; the winning Y is converted back through the default scale.
 * Returns `price` unchanged for non-magnet modes, no candidates, a NaN pointer Y, or
 * when every candidate is NaN.
 */
export function magnetSnapPrice(args: MagnetSnapArgs): number {
  const { mode, price, candidates, priceToCoordinate, coordinateToPrice } = args;
  if (mode !== CrosshairMode.Magnet && mode !== CrosshairMode.MagnetOHLC) return price;
  if (candidates.length === 0) return price;

  const targetY = priceToCoordinate(price);
  // Empty default scale: NaN survives and just hides the horizontal line.
  if (!Number.isFinite(targetY)) return price;

  const ohlc = mode === CrosshairMode.MagnetOHLC;
  let bestY = Number.NaN;
  let bestDist = Number.POSITIVE_INFINITY;

  const consider = (value: number, toY: (p: number) => number): void => {
    if (!Number.isFinite(value)) return;
    const y = toY(value);
    if (!Number.isFinite(y)) return; // candidate's own scale is empty
    const d = Math.abs(y - targetY);
    if (d < bestDist) {
      bestDist = d;
      bestY = y;
    }
  };

  for (const c of candidates) {
    const toY = c.priceToCoordinate ?? priceToCoordinate;
    if (ohlc) {
      consider(c.open, toY);
      consider(c.high, toY);
      consider(c.low, toY);
    }
    consider(c.close, toY);
  }

  if (!Number.isFinite(bestY)) return price;
  return coordinateToPrice(bestY);
}

export class Crosshair {
  #mode: CrosshairMode = CrosshairMode.Magnet;
  #position: CrosshairPosition | null = null;
  #visible = false;
  #hover: HoverTarget | null = null;
  #tracking = false;

  mode(): CrosshairMode {
    return this.#mode;
  }
  setMode(mode: CrosshairMode): void {
    this.#mode = mode;
  }

  /** Whether the crosshair has a live (non-cleared) position. */
  visible(): boolean {
    return this.#visible;
  }

  /** Hidden suppresses rendering only; position and events still flow. */
  renderVisible(): boolean {
    return this.#visible && this.#mode !== CrosshairMode.Hidden;
  }

  position(): CrosshairPosition | null {
    return this.#position;
  }

  /** Stores an already clamped, snapped and re-derived position. */
  setPosition(position: CrosshairPosition): void {
    this.#position = position;
    this.#visible = true;
  }

  /** Keeps the index at the last bar (so the time-axis label stays meaningful) with NaN
   *  price/coords; a null `lastBarIndex` (empty chart) drops the position. */
  clear(lastBarIndex: TimeIndex | null): void {
    this.#visible = false;
    if (lastBarIndex === null) {
      this.#position = null;
      return;
    }
    const nan = Number.NaN as unknown as Coordinate;
    this.#position = {
      index: lastBarIndex,
      price: Number.NaN,
      x: nan,
      y: nan,
      originX: nan,
      originY: nan,
    };
  }

  hover(): HoverTarget | null {
    return this.#hover;
  }
  setHover(target: HoverTarget | null): void {
    this.#hover = target;
  }

  isTracking(): boolean {
    return this.#tracking;
  }
  setTracking(on: boolean): void {
    this.#tracking = on;
  }
}
