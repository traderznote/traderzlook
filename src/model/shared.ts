// Model glue: pane-id formatting, option types and defaults, and the value-object
// builders (HorzGeometry, PriceConverter) that views consume instead of model objects.
import type { Brand } from '../core';
import type { LocalizationOptions, TimeScaleOptions } from '../data';
import {
  PriceScaleMode,
  defaultLogFormula,
  toIndexed,
  toLog,
  toPercent,
  type LogFormula,
  type MinMax,
} from './price-scale/modes';
import { createPriceGeometry } from './price-scale/geometry';
import { createHorzGeometry, type HorzGeometry, type HorzGeometryParams } from './time-scale/geometry';

/** Chart-unique, never reused. */
export type PaneId = Brand<string, 'PaneId'>;

/** `creationOrdinal` is the creation counter, not the positional index. */
export function formatPaneId(creationOrdinal: number): PaneId {
  return `p${creationOrdinal}` as PaneId;
}

export type {
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
} from '../data';

/** Interactive state (e.g. barSpacing after a pan) is model state, not options. */
export interface ChartOptions {
  width: number;
  height: number;
  autoSize: boolean;
  validation: 'throw' | 'warn' | 'off';
  addDefaultPane: boolean;
  hoveredSeriesOnTop: boolean;
  defaultPriceScaleId: string;
  layout: LayoutOptions;
  grid: GridOptions;
  crosshair: CrosshairOptions;
  timeScale?: Partial<TimeScaleOptions>;
  rightPriceScale?: Partial<PriceScaleOptions>;
  leftPriceScale?: Partial<PriceScaleOptions>;
  localization?: Partial<LocalizationOptions>;
  kineticScroll?: { touch?: boolean; mouse?: boolean };
}

export interface LayoutOptions {
  background: { type: 'solid'; color: string };
  textColor: string;
  fontSize: number;
  fontFamily: string;
}

export interface GridOptions {
  vertLines: { color: string; visible: boolean; lineWidth?: number };
  horzLines: { color: string; visible: boolean; lineWidth?: number };
}

export interface CrosshairOptions {
  mode: 'normal' | 'magnet' | 'hidden' | 'magnet-ohlc';
  vertLine?: Partial<CrosshairLineStyle>;
  horzLine?: Partial<CrosshairLineStyle>;
}

export interface CrosshairLineStyle {
  color: string;
  width: number;
  style: string | number;
  visible: boolean;
  labelVisible: boolean;
  labelBackgroundColor: string;
}

export interface PriceScaleOptions {
  autoScale: boolean;
  mode: PriceScaleMode;
  invertScale: boolean;
  borderVisible: boolean;
  borderColor: string;
  entireTextOnly: boolean;
  visible: boolean;
  ticksVisible: boolean;
  scaleMargins: { top: number; bottom: number };
  minimumWidth: number;
  tickMarkDensity: number;
}

const DEFAULT_FONT_FAMILY =
  "-apple-system, BlinkMacSystemFont, 'Trebuchet MS', Roboto, Ubuntu, sans-serif";

export const DEFAULT_CHART_OPTIONS: ChartOptions = {
  width: 0,
  height: 0,
  autoSize: false,
  validation: 'throw',
  addDefaultPane: true,
  hoveredSeriesOnTop: true,
  defaultPriceScaleId: 'right',
  layout: {
    background: { type: 'solid', color: '#FFFFFF' },
    textColor: '#191919',
    fontSize: 12,
    fontFamily: DEFAULT_FONT_FAMILY,
  },
  grid: {
    // A line can't go below 1 device px, so low alpha is what makes the grid faint.
    // lineWidth 0.5 keeps it 1 device px on hi-DPI.
    vertLines: { color: 'rgba(214, 220, 222, 0.25)', visible: true, lineWidth: 0.5 },
    horzLines: { color: 'rgba(214, 220, 222, 0.25)', visible: true, lineWidth: 0.5 },
  },
  crosshair: { mode: 'normal' },
};

export const DEFAULT_TIME_SCALE_OPTIONS = {
  rightOffset: 0,
  rightOffsetPixels: undefined,
  barSpacing: 6,
  minBarSpacing: 0.5,
  maxBarSpacing: 0,
  fixLeftEdge: false,
  fixRightEdge: false,
  resizeAnchor: 'right-offset' as const,
  rightBarStaysOnScroll: false,
  borderVisible: true,
  borderColor: '#2B2B43',
  visible: true,
  timeVisible: false,
  secondsVisible: true,
  shiftVisibleRangeOnNewBar: true,
  allowShiftVisibleRangeOnWhitespaceReplacement: false,
  ticksVisible: false,
  uniformDistribution: false,
  tickMarkMaxCharacterLength: undefined,
  minimumHeight: 0,
  allowBoldLabels: true,
  tickMarkFormatter: undefined,
};

function priceScaleDefaults(visible: boolean): PriceScaleOptions {
  return {
    autoScale: true,
    mode: PriceScaleMode.Normal,
    invertScale: false,
    borderVisible: true,
    borderColor: '#2B2B43',
    entireTextOnly: false,
    visible,
    ticksVisible: false,
    scaleMargins: { top: 0.2, bottom: 0.1 },
    minimumWidth: 0,
    tickMarkDensity: 2.5,
  };
}

/** Right visible, left hidden. */
export const DEFAULT_PRICE_SCALE_OPTIONS = {
  right: priceScaleDefaults(true),
  left: priceScaleDefaults(false),
};

export function buildHorzGeometry(p: HorzGeometryParams): HorzGeometry {
  return createHorzGeometry(p);
}

/** String mode flag, so views never import the numeric PriceScaleMode. */
export type PriceConverterMode = 'normal' | 'log' | 'percent' | 'indexed';

const MODE_FLAG: Record<PriceScaleMode, PriceConverterMode> = {
  [PriceScaleMode.Normal]: 'normal',
  [PriceScaleMode.Logarithmic]: 'log',
  [PriceScaleMode.Percentage]: 'percent',
  [PriceScaleMode.IndexedTo100]: 'indexed',
};

/** View-facing function bag; plain functions and numbers, never a model object. */
export interface PriceConverter {
  /** Media-px Y; applies the active mode transform. */
  priceToCoordinate(price: number): number;
  /** Close of the first visible bar; null ⇒ percent/indexed skip. */
  readonly firstValue: number | null;
  readonly mode: PriceConverterMode;
  toLogical(price: number): number;
}

export interface PriceConverterParams {
  /** H: scale height, media px. */
  readonly height: number;
  /** Visible range in the mode's logical space (null on an empty scale). */
  readonly range: MinMax | null;
  readonly scaleMargins: { readonly top: number; readonly bottom: number };
  readonly marginAbovePx: number;
  readonly marginBelowPx: number;
  readonly mode: PriceScaleMode;
  readonly inverted: boolean;
  /** Percent/indexed base; null ⇒ skip. */
  readonly firstValue: number | null;
  /** Log mode only; defaults to {L=4,C=1e−4}. */
  readonly logFormula?: LogFormula;
}

export function buildPriceConverter(p: PriceConverterParams): PriceConverter {
  const logFormula = p.logFormula ?? defaultLogFormula();
  const geom = createPriceGeometry({
    height: p.height,
    range: p.range,
    scaleMargins: p.scaleMargins,
    marginAbovePx: p.marginAbovePx,
    marginBelowPx: p.marginBelowPx,
    mode: p.mode,
    inverted: p.inverted,
    logFormula,
  });
  const isLog = p.mode === PriceScaleMode.Logarithmic;
  const base = p.firstValue;
  // Percentage / indexed ranges are relative to each series' own first visible value.
  const relative =
    base === null
      ? null
      : p.mode === PriceScaleMode.Percentage
        ? (price: number): number => toPercent(price, base)
        : p.mode === PriceScaleMode.IndexedTo100
          ? (price: number): number => toIndexed(price, base)
          : null;
  return Object.freeze({
    priceToCoordinate: (price: number): number =>
      geom.logicalToCoordinate(relative === null ? price : relative(price)),
    firstValue: p.firstValue,
    mode: MODE_FLAG[p.mode],
    toLogical: (price: number): number =>
      relative !== null ? relative(price) : isLog && price !== 0 ? toLog(price, logFormula) : price,
  });
}
