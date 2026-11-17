// Series model: merged options, last-value state from StoreDiffs, bar color resolution,
// autoscale contribution, and a generic primitive list (plugins attach there, never as fields).
import { mergeOptions, type DeepPartial, type TimeIndex } from '../core';
import type { PlotStoreView, StoreDiff } from '../data';
import { mergeMargins, type AutoscaleMargins } from './price-scale/autoscale';

export type SeriesKindName =
  | 'line'
  | 'area'
  | 'baseline'
  | 'histogram'
  | 'bar'
  | 'candlestick'
  | 'custom';

/** `margins` are pixel margins, max-merged. */
export interface AutoscaleInfo {
  priceRange: { minValue: number; maxValue: number } | null;
  margins?: { above: number; below: number };
}

export type AutoscaleInfoProvider = (
  baseImplementation: () => AutoscaleInfo | null,
) => AutoscaleInfo | null;

export interface AxisLabel {
  coordinate(): number;
  fixedCoordinate?(): number | undefined;
  text(): string;
  textColor(): string;
  backColor(): string;
  visible?(): boolean;
  tickVisible?(): boolean;
}

/** `source` is `unknown` because SceneSource is a gfx type the model may not name. */
export interface PrimitiveSource {
  target: 'pane' | 'price-axis' | 'time-axis';
  axis?: 'left' | 'right';
  source: unknown;
}

/** Only the model-relevant hooks; attach/detach lifecycle is host-driven. */
export interface IPrimitive {
  autoscale?(range: LogicalRange): AutoscaleInfo | null;
  sources?(): readonly PrimitiveSource[];
  priceAxisLabels?(): readonly AxisLabel[];
  timeAxisLabels?(): readonly AxisLabel[];
}

/** Inclusive. */
export interface LogicalRange {
  readonly from: TimeIndex;
  readonly to: TimeIndex;
}

/** Passed in by the host; the model never reads the store's color sidecar itself. */
export interface PointColorOverrides {
  color?: string;
  lineColor?: string;
  borderColor?: string;
  wickColor?: string;
}

export interface ColorerBar {
  readonly open: number;
  readonly close: number;
}

/** Only `barColor` is universal; candlesticks also resolve border + wick. */
export interface BarColors {
  barColor: string;
  barBorderColor?: string;
  barWickColor?: string;
}

/** Loosely typed; the strict per-type interfaces live at the API boundary. */
export type SeriesOptions = Record<string, unknown>;

/** The write-only `borderColor`/`wickColor` shorthands fan out to up/down and are then dropped. */
export function candlestickNormalizeOptions(patch: Record<string, unknown>): void {
  if (typeof patch.borderColor === 'string') {
    if (patch.borderUpColor === undefined) patch.borderUpColor = patch.borderColor;
    if (patch.borderDownColor === undefined) patch.borderDownColor = patch.borderColor;
    delete patch.borderColor;
  }
  if (typeof patch.wickColor === 'string') {
    if (patch.wickUpColor === undefined) patch.wickUpColor = patch.wickColor;
    if (patch.wickDownColor === undefined) patch.wickDownColor = patch.wickColor;
    delete patch.wickColor;
  }
}

/** Precedence: per-point override → up/down or above/below-base → option default.
 *  Baseline ignores per-point overrides. */
export function resolveBarColors(
  kind: SeriesKindName,
  bar: ColorerBar,
  overrides: PointColorOverrides,
  options: SeriesOptions,
): BarColors {
  switch (kind) {
    case 'bar': {
      const isUp = bar.open <= bar.close;
      const upDown = (isUp ? options.upColor : options.downColor) as string;
      return { barColor: overrides.color ?? upDown };
    }
    case 'candlestick': {
      const isUp = bar.open <= bar.close;
      const barColor = overrides.color ?? ((isUp ? options.upColor : options.downColor) as string);
      const barBorderColor =
        overrides.borderColor ??
        ((isUp ? options.borderUpColor : options.borderDownColor) as string);
      const barWickColor =
        overrides.wickColor ?? ((isUp ? options.wickUpColor : options.wickDownColor) as string);
      return { barColor, barBorderColor, barWickColor };
    }
    case 'area': {
      return { barColor: overrides.lineColor ?? (options.lineColor as string) };
    }
    case 'baseline': {
      const baseValue = (options.baseValue as { price?: number } | undefined)?.price ?? 0;
      const above = bar.close >= baseValue;
      return { barColor: (above ? options.topLineColor : options.bottomLineColor) as string };
    }
    case 'line':
    case 'histogram':
    case 'custom':
    default:
      return { barColor: overrides.color ?? (options.color as string) };
  }
}

/** Store rows [first, last] whose slot lies in `range`; first > last when none do. */
export function rowsInRange(store: PlotStoreView, range: LogicalRange): [number, number] {
  const n = store.length;
  if (n === 0) return [0, -1];
  let first = store.nearestIndexAt(range.from, 'right');
  if ((store.timeIndex(first) as number) < (range.from as number)) first = n;
  let last = store.nearestIndexAt(range.to, 'left');
  if ((store.timeIndex(last) as number) > (range.to as number)) last = -1;
  return [first, last];
}

export interface LastValue {
  readonly index: TimeIndex;
  readonly price: number;
}

export interface SeriesInit {
  readonly kind: SeriesKindName;
  readonly defaultOptions: SeriesOptions;
  /** Shorthand expansion, applied at creation and on every applyOptions. */
  readonly normalizeOptions?: (patch: Record<string, unknown>) => void;
}

export class Series {
  readonly #kind: SeriesKindName;
  readonly #defaults: SeriesOptions;
  readonly #normalize?: (patch: Record<string, unknown>) => void;
  #options: SeriesOptions;
  #lastValue: LastValue | null = null;
  readonly #primitives: IPrimitive[] = [];

  constructor(init: SeriesInit) {
    this.#kind = init.kind;
    this.#normalize = init.normalizeOptions;
    const defaults = { ...init.defaultOptions };
    this.#normalize?.(defaults);
    this.#defaults = defaults;
    this.#options = { ...defaults };
  }

  kind(): SeriesKindName {
    return this.#kind;
  }

  /** A snapshot copy, never the live object. */
  options(): SeriesOptions {
    return { ...this.#options };
  }

  applyOptions(patch: DeepPartial<SeriesOptions>): void {
    const local = { ...(patch as Record<string, unknown>) };
    this.#normalize?.(local);
    this.#options = mergeOptions(this.#options, local as DeepPartial<SeriesOptions>, this.#defaults);
  }

  /** Every diff kind can change the last row, so this just re-reads the store's tail. */
  applyDiff(store: PlotStoreView, _diff: StoreDiff): void {
    const len = store.length;
    if (len === 0) {
      this.#lastValue = null;
      return;
    }
    const i = len - 1;
    this.#lastValue = { index: store.timeIndex(i), price: store.current(i) };
  }

  lastValue(): LastValue | null {
    return this.#lastValue;
  }

  /** `priceLineColor` option when non-empty, else the caller's resolved last-bar color,
   *  else the `color` option. */
  priceLineColor(lastBarColor?: string): string {
    const opt = this.#options.priceLineColor;
    if (typeof opt === 'string' && opt !== '') return opt;
    if (lastBarColor !== undefined) return lastBarColor;
    return (this.#options.color as string) ?? '';
  }

  /** A user `autoscaleInfoProvider` wraps the whole base computation and receives it as a thunk. */
  autoscaleInfo(store: PlotStoreView, range: LogicalRange): AutoscaleInfo | null {
    const base = (): AutoscaleInfo | null => this.#baseAutoscaleInfo(store, range);
    const provider = this.#options.autoscaleInfoProvider as AutoscaleInfoProvider | undefined;
    return typeof provider === 'function' ? provider(base) : base();
  }

  #baseAutoscaleInfo(store: PlotStoreView, range: LogicalRange): AutoscaleInfo | null {
    let min = Number.POSITIVE_INFINITY;
    let max = Number.NEGATIVE_INFINITY;
    const [first, last] = rowsInRange(store, range);
    const any = first <= last;
    if (any) {
      if (store.minMaxInRows !== undefined) {
        const r = store.minMaxInRows(first, last);
        min = r.min;
        max = r.max;
      } else {
        for (let i = first; i <= last; i++) {
          if (store.min(i) < min) min = store.min(i);
          if (store.max(i) > max) max = store.max(i);
        }
      }
    }

    const margins: AutoscaleMargins[] = [];
    let priceRange: { minValue: number; maxValue: number } | null = any
      ? { minValue: min, maxValue: max }
      : null;

    for (const p of this.#primitives) {
      const info = p.autoscale?.(range);
      if (!info) continue;
      if (info.priceRange) {
        priceRange = priceRange
          ? {
              minValue: Math.min(priceRange.minValue, info.priceRange.minValue),
              maxValue: Math.max(priceRange.maxValue, info.priceRange.maxValue),
            }
          : { minValue: info.priceRange.minValue, maxValue: info.priceRange.maxValue };
      }
      if (info.margins) margins.push(info.margins);
    }

    if (priceRange === null) return null;
    // zero baseline so margins are always defined; the series itself adds none.
    const merged = mergeMargins([{ above: 0, below: 0 }, ...margins]);
    return { priceRange, margins: { above: merged.above, below: merged.below } };
  }

  attachPrimitive(primitive: IPrimitive): void {
    this.#primitives.push(primitive);
  }

  /** No-op if it was never attached. */
  detachPrimitive(primitive: IPrimitive): void {
    const i = this.#primitives.indexOf(primitive);
    if (i >= 0) this.#primitives.splice(i, 1);
  }

  primitives(): readonly IPrimitive[] {
    return this.#primitives.slice();
  }

  primitiveSources(): readonly PrimitiveSource[] {
    const out: PrimitiveSource[] = [];
    for (const p of this.#primitives) {
      const srcs = p.sources?.();
      if (srcs) out.push(...srcs);
    }
    return out;
  }

  primitivePriceAxisLabels(): readonly AxisLabel[] {
    const out: AxisLabel[] = [];
    for (const p of this.#primitives) {
      const labels = p.priceAxisLabels?.();
      if (labels) out.push(...labels);
    }
    return out;
  }
}
