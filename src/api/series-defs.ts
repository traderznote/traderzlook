// The six built-in series definitions, defineSeries, the common series defaults and the
// Time type guards. Headless: no DOM, no backend.
import type { SeriesDataContract } from '../data';
import type { Time, BusinessDay, UTCTimestamp } from '../data';
import { singleValueContract, barContract } from '../data';
import type { SeriesKind } from '../views';
import {
  createLineKind,
  createAreaKind,
  createBaselineKind,
  createHistogramKind,
  createBarKind,
  createCandlestickKind,
} from '../views';
import type { SeriesOptions } from '../model';
import { candlestickNormalizeOptions } from '../model';

export type SeriesType =
  | 'line'
  | 'area'
  | 'baseline'
  | 'bar'
  | 'candlestick'
  | 'histogram'
  | 'custom';

/** The tree-shakable {contract, kind} pair passed to `addSeries`. `createKind` is a
 *  factory because view kinds are built from the live merged options. `defaultOptions`
 *  are style defaults the common defaults are merged into; `normalizeOptions` is an
 *  optional shorthand-expansion hook (only candlestick has one). */
export interface SeriesDefinition<K extends SeriesType, TItem, TOptions> {
  readonly type: K;
  readonly defaultOptions: TOptions;
  readonly contract: SeriesDataContract<TItem>;
  readonly createKind: (options: SeriesOptions) => SeriesKind<unknown>;
  readonly normalizeOptions?: (patch: Record<string, unknown>) => void;
}

function kindFactory(
  factory: (options: SeriesOptions) => unknown,
): (options: SeriesOptions) => SeriesKind<unknown> {
  return (options) => factory(options) as SeriesKind<unknown>;
}

// Area's factory is the outlier: it takes Partial<AreaKindOptions> and returns
// `{kind, buffer}`, so adapt the argument and unwrap `.kind`.
function areaKindFactory(): (options: SeriesOptions) => SeriesKind<unknown> {
  type AreaArg = Parameters<typeof createAreaKind>[0];
  return (options) => createAreaKind(options as unknown as AreaArg).kind as SeriesKind<unknown>;
}

/** Common defaults merged into every definition's style defaults; exported for
 *  custom-series authors building their own defaults on top. */
export const defaultSeriesOptions = {
  title: '',
  visible: true,
  lastValueVisible: true,
  priceLineVisible: true,
  priceLineSource: 'last-bar',
  priceLineWidth: 1,
  priceLineColor: '',
  priceLineStyle: 'dashed',
  baseLineVisible: true,
  baseLineWidth: 1,
  baseLineColor: '#B2B5BE',
  baseLineStyle: 'solid',
  priceFormat: { type: 'price', precision: 2, minMove: 0.01 },
  hitTestTolerance: 3,
} as const;

// Shared by Line, Area and Baseline.
const lineStyleDefaults = {
  color: '#2196f3',
  lineStyle: 'solid',
  lineWidth: 3,
  lineType: 'simple',
  lineVisible: true,
  pointMarkersVisible: false,
  pointMarkersRadius: undefined,
  crosshairMarkerVisible: true,
  crosshairMarkerRadius: 4,
  crosshairMarkerBorderColor: '',
  crosshairMarkerBorderWidth: 2,
  crosshairMarkerBackgroundColor: '',
  lastPriceAnimation: 'disabled',
} as const;

export const LineSeries: SeriesDefinition<'line', { time: Time; value: number }, typeof lineStyleDefaults> = {
  type: 'line',
  defaultOptions: { ...lineStyleDefaults },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createLineKind),
};

export const AreaSeries: SeriesDefinition<
  'area',
  { time: Time; value: number },
  typeof lineStyleDefaults & {
    topColor: string; bottomColor: string; invertFilledArea: boolean;
    relativeGradient: boolean; lineColor: string;
  }
> = {
  type: 'area',
  defaultOptions: {
    ...lineStyleDefaults,
    topColor: 'rgba( 46, 220, 135, 0.4)',
    bottomColor: 'rgba( 40, 221, 100, 0)',
    invertFilledArea: false,
    relativeGradient: false,
    lineColor: '#33D778',
  },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: areaKindFactory(),
};

export const BaselineSeries: SeriesDefinition<
  'baseline',
  { time: Time; value: number },
  typeof lineStyleDefaults & {
    baseValue: { type: 'price'; price: number }; relativeGradient: boolean;
    topFillColor1: string; topFillColor2: string; topLineColor: string;
    bottomFillColor1: string; bottomFillColor2: string; bottomLineColor: string;
  }
> = {
  type: 'baseline',
  defaultOptions: {
    ...lineStyleDefaults,
    baseValue: { type: 'price', price: 0 },
    relativeGradient: false,
    topFillColor1: 'rgba(38, 166, 154, 0.28)',
    topFillColor2: 'rgba(38, 166, 154, 0.05)',
    topLineColor: 'rgba(38, 166, 154, 1)',
    bottomFillColor1: 'rgba(239, 83, 80, 0.05)',
    bottomFillColor2: 'rgba(239, 83, 80, 0.28)',
    bottomLineColor: 'rgba(239, 83, 80, 1)',
  },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createBaselineKind),
};

export const HistogramSeries: SeriesDefinition<
  'histogram',
  { time: Time; value: number },
  { color: string; base: number }
> = {
  type: 'histogram',
  defaultOptions: { color: '#26a69a', base: 0 },
  contract: singleValueContract as SeriesDataContract<{ time: Time; value: number }>,
  createKind: kindFactory(createHistogramKind),
};

export const BarSeries: SeriesDefinition<
  'bar',
  { time: Time; open: number; high: number; low: number; close: number },
  { upColor: string; downColor: string; openVisible: boolean; thinBars: boolean }
> = {
  type: 'bar',
  defaultOptions: { upColor: '#26a69a', downColor: '#ef5350', openVisible: true, thinBars: true },
  contract: barContract as SeriesDataContract<{
    time: Time; open: number; high: number; low: number; close: number;
  }>,
  createKind: kindFactory(createBarKind),
};

/** Also accepts the write-only `borderColor`/`wickColor` shorthands (fanned out to up/down). */
export const CandlestickSeries: SeriesDefinition<
  'candlestick',
  { time: Time; open: number; high: number; low: number; close: number },
  {
    upColor: string; downColor: string; wickVisible: boolean; borderVisible: boolean;
    borderUpColor: string; borderDownColor: string; wickUpColor: string; wickDownColor: string;
  }
> = {
  type: 'candlestick',
  defaultOptions: {
    upColor: '#26a69a',
    downColor: '#ef5350',
    wickVisible: true,
    borderVisible: true,
    borderUpColor: '#26a69a',
    borderDownColor: '#ef5350',
    wickUpColor: '#26a69a',
    wickDownColor: '#ef5350',
  },
  contract: barContract as SeriesDataContract<{
    time: Time; open: number; high: number; low: number; close: number;
  }>,
  createKind: kindFactory(createCandlestickKind),
  normalizeOptions: candlestickNormalizeOptions,
};

/** The only custom-series entry point. The result is tagged `'custom'`; `kind` is a live
 *  `SeriesKind` instance, so `createKind` returns it and ignores options. */
export function defineSeries<TItem extends { time: unknown }, TOptions>(def: {
  type: string;
  defaultOptions: TOptions;
  contract: SeriesDataContract<TItem>;
  kind: SeriesKind<unknown>;
  normalizeOptions?: (patch: Record<string, unknown>) => void;
}): SeriesDefinition<'custom', TItem, TOptions> {
  return {
    type: 'custom',
    defaultOptions: def.defaultOptions,
    contract: def.contract,
    createKind: () => def.kind,
    normalizeOptions: def.normalizeOptions,
  };
}

/** True iff `time` is a `{year, month, day}` object (not a timestamp or date string). */
export function isBusinessDay(time: Time): time is BusinessDay {
  return typeof time === 'object' && time !== null;
}

/** True iff `time` is a number (unix seconds). */
export function isUTCTimestamp(time: Time): time is UTCTimestamp {
  return typeof time === 'number';
}
