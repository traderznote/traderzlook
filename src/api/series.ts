// ISeries facade: a thin guarded map-through over the model Series and chart-owned ports.
import type {
  BarPrice,
  Coordinate,
  DeepPartial,
  DeepReadonly,
  Logical,
  Unsubscribe,
} from '../core';
import type { PlotStoreView } from '../data';
import type { Series, SeriesOptions, IPrimitive } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type StoreDiff } from './events';
import { normalizeSeriesPatch, type NormalizeOptionsHook } from './options';
import type { SeriesType } from './series-defs';
import type { IPriceScale } from './price-scale';
import type { IPane } from './pane';

export type MismatchDirection = 'none' | 'nearest-left' | 'nearest-right';

/** A time slot that draws nothing. */
export interface WhitespaceData<H = unknown> {
  time: H;
  customValues?: Record<string, unknown>;
}

/** Inclusive, possibly fractional, logical range. */
export interface LogicalRange {
  from: Logical;
  to: Logical;
}

/** `from`/`to` are present iff the series has at least one bar inside the range. */
export interface BarsInfo<H = unknown> {
  barsBefore: number;
  barsAfter: number;
  from?: H;
  to?: H;
}

export interface IPriceFormatter {
  format(price: number): string;
}

export interface PriceLineOptions {
  price: number;
  color?: string;
  lineStyle?: string;
  lineWidth?: number;
  lineVisible?: boolean;
  axisLabelVisible?: boolean;
  title?: string;
  axisLabelColor?: string;
  axisLabelTextColor?: string;
  id?: string;
}

/** One cached handle per createPriceLine call. */
export interface IPriceLine {
  applyOptions(patch: DeepPartial<PriceLineOptions>): void;
  options(): DeepReadonly<PriceLineOptions>;
}

// The trailing defaulted parameters give defineSeries authors full item/option inference.
export interface ISeries<
  K extends SeriesType = SeriesType,
  H = unknown,
  TItem = unknown,
  TOptions = SeriesOptions,
> {
  seriesType(): K;

  setData(items: readonly (TItem | WhitespaceData<H>)[]): void;
  update(item: TItem | WhitespaceData<H>, options?: { historical?: boolean }): void;
  data(): readonly (TItem | WhitespaceData<H>)[];
  dataByIndex(logical: number, mismatch?: MismatchDirection): TItem | null;
  barsInLogicalRange(range: LogicalRange | null): BarsInfo<H> | null;
  store(): PlotStoreView;

  applyOptions(patch: DeepPartial<TOptions>): void;
  options(): DeepReadonly<TOptions>;

  // null on empty data / empty scale
  priceToCoordinate(price: number): Coordinate | null;
  coordinateToPrice(coordinate: number): BarPrice | null;
  priceFormatter(): IPriceFormatter;

  priceScale(): IPriceScaleHandle; // resolved at call time, so it follows the series
  pane(): IPaneHandle;
  moveToPane(paneIndex: number): void;
  order(): number;
  setOrder(order: number): void;

  createPriceLine(options: PriceLineOptions): IPriceLine;
  removePriceLine(line: IPriceLine): void;
  priceLines(): readonly IPriceLine[];

  lastValue(globalLast?: boolean): { noData: true } | { noData: false; price: BarPrice; color: string };

  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;

  subscribeDataChanged(h: (diff: StoreDiff) => void): Unsubscribe;
  unsubscribeDataChanged(h: (diff: StoreDiff) => void): void;
}

export type IPriceScaleHandle = IPriceScale;
export type IPaneHandle = IPane;

/**
 * Everything the series facade delegates to. Scale/pane lookups return the chart's
 * cached handles, so priceScale() follows the series.
 */
export interface SeriesPort<H = unknown> {
  /** True once chart.dispose() ran. */
  isDisposed(): boolean;

  setData(items: readonly unknown[]): void;
  update(item: unknown, historical: boolean): void;
  data(): readonly unknown[];
  dataByIndex(logical: number, mismatch: MismatchDirection): unknown | null;
  barsInLogicalRange(range: LogicalRange | null): BarsInfo<H> | null;
  store(): PlotStoreView;

  priceToCoordinate(price: number): Coordinate | null;
  coordinateToPrice(coordinate: number): BarPrice | null;
  priceFormatter(): IPriceFormatter;

  priceScale(): IPriceScaleHandle;
  pane(): IPaneHandle;
  moveToPane(paneIndex: number): void;
  order(): number;
  setOrder(order: number): void;

  // Called after the model applied an options patch.
  optionsChanged(): void;

  createPriceLine(options: PriceLineOptions): IPriceLine;
  removePriceLine(line: IPriceLine): void;
  priceLines(): readonly IPriceLine[];

  /** The legend last value with its resolved color, or null when empty. */
  lastValue(globalLast: boolean): { price: number; color: string } | null;

  dataChanged: EventHub<[StoreDiff]>;
}

/**
 * Called once per addSeries; the chart caches the handle for the series' life. Every
 * method throws `disposed` after chart.dispose().
 */
export function createSeriesApi<
  K extends SeriesType = SeriesType,
  H = unknown,
  TItem = unknown,
  TOptions = SeriesOptions,
>(
  type: K,
  model: Series,
  port: SeriesPort<H>,
  normalizeHook?: NormalizeOptionsHook,
): ISeries<K, H, TItem, TOptions> {
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: ISeries<K, H, TItem, TOptions> = {
    seriesType(): K {
      guard();
      return type;
    },

    setData(items): void {
      guard();
      port.setData(items as readonly unknown[]);
    },
    update(item, options): void {
      guard();
      port.update(item, options?.historical ?? false);
    },
    data(): readonly (TItem | WhitespaceData<H>)[] {
      guard();
      return port.data() as readonly (TItem | WhitespaceData<H>)[];
    },
    dataByIndex(logical, mismatch): TItem | null {
      guard();
      return port.dataByIndex(logical, mismatch ?? 'none') as TItem | null;
    },
    barsInLogicalRange(range): BarsInfo<H> | null {
      guard();
      return port.barsInLogicalRange(range);
    },
    store(): PlotStoreView {
      guard();
      return port.store();
    },

    // Normalizations (minMove→precision, candlestick shorthands) re-run on every call;
    // the model owns the merge and the null-leaf reset target.
    applyOptions(patch): void {
      guard();
      const normalized = normalizeSeriesPatch(patch as Record<string, unknown>, normalizeHook);
      model.applyOptions(normalized as DeepPartial<SeriesOptions>);
      port.optionsChanged();
    },
    options(): DeepReadonly<TOptions> {
      guard();
      return model.options() as DeepReadonly<TOptions>;
    },

    priceToCoordinate(price): Coordinate | null {
      guard();
      return port.priceToCoordinate(price);
    },
    coordinateToPrice(coordinate): BarPrice | null {
      guard();
      return port.coordinateToPrice(coordinate);
    },
    priceFormatter(): IPriceFormatter {
      guard();
      return port.priceFormatter();
    },

    priceScale(): IPriceScaleHandle {
      guard();
      return port.priceScale();
    },
    pane(): IPaneHandle {
      guard();
      return port.pane();
    },
    moveToPane(paneIndex): void {
      guard();
      port.moveToPane(paneIndex);
    },
    order(): number {
      guard();
      return port.order();
    },
    setOrder(order): void {
      guard();
      port.setOrder(order);
    },

    createPriceLine(options): IPriceLine {
      guard();
      return port.createPriceLine(options);
    },
    removePriceLine(line): void {
      guard();
      port.removePriceLine(line);
    },
    priceLines(): readonly IPriceLine[] {
      guard();
      return port.priceLines();
    },

    lastValue(globalLast): { noData: true } | { noData: false; price: BarPrice; color: string } {
      guard();
      const lv = port.lastValue(globalLast ?? false);
      if (lv === null) return { noData: true };
      return { noData: false, price: lv.price as BarPrice, color: lv.color };
    },

    attachPrimitive(p): void {
      guard();
      model.attachPrimitive(p);
    },
    detachPrimitive(p): void {
      guard();
      model.detachPrimitive(p);
    },

    subscribeDataChanged(h): Unsubscribe {
      guard();
      return port.dataChanged.subscribe(h);
    },
    unsubscribeDataChanged(h): void {
      guard();
      port.dataChanged.unsubscribe(h);
    },
  };

  return api;
}
