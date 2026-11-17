// ITimeScale facade: a thin guarded map-through over the model time scale and host axis.
import type { Coordinate, DeepPartial, DeepReadonly, HorzKey, Logical, Unsubscribe } from '../core';
import type { TimeScaleOptions } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub } from './events';
import { normalizeChartPatch } from './options';
import type { LogicalRange } from './series';

export interface TimeRange<H = unknown> {
  from: H;
  to: H;
}

/**
 * The time-scale handle, generic over the horizontal item `H`. Singleton per chart;
 * every method throws after dispose().
 */
export interface ITimeScale<H = unknown> {
  scrollPosition(): number; // right offset in bars
  scrollToPosition(position: number, animated?: boolean): void;
  scrollToRealTime(): void;
  fitContent(): void;
  reset(): void;

  // Logical ranges can extrapolate; H-typed ranges clamp to data.
  getVisibleRange(): TimeRange<H> | null;
  setVisibleRange(range: TimeRange<H>): void;
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: { from: number; to: number }): void;

  // Conversions return null when the scale is empty.
  logicalToCoordinate(logical: number): Coordinate | null;
  coordinateToLogical(x: number): Logical | null; // continuous float
  snapToBar(logical: number): Logical | null;
  timeToCoordinate(time: H): Coordinate | null; // exact match only
  coordinateToTime(x: number): H | null;
  timeToLogical(time: H, mismatch?: MismatchDirection): Logical | null;

  // Off-grid key ↔ logical mapping (drawing tools, multi-chart sync).
  keyToLogical(key: number, opts?: { extrapolate?: boolean }): Logical | null;
  logicalToKey(logical: number, opts?: { extrapolate?: boolean }): HorzKey | null;
  keysInRange(range: { from: number; to: number }): readonly HorzKey[];

  barSpacing(): number;
  rightOffset(): number;

  width(): number;
  height(): number;

  applyOptions(patch: DeepPartial<TimeScaleOptions>): void;
  options(): DeepReadonly<TimeScaleOptions>;

  subscribeVisibleTimeRangeChange(h: (r: TimeRange<H> | null) => void): Unsubscribe;
  unsubscribeVisibleTimeRangeChange(h: (r: TimeRange<H> | null) => void): void;
  subscribeVisibleLogicalRangeChange(h: (r: LogicalRange | null) => void): Unsubscribe;
  unsubscribeVisibleLogicalRangeChange(h: (r: LogicalRange | null) => void): void;
  subscribeSizeChange(h: (width: number, height: number) => void): Unsubscribe;
  unsubscribeSizeChange(h: (width: number, height: number) => void): void;
}

// Duplicated from series.ts so this file never imports the series facade.
export type MismatchDirection = 'none' | 'nearest-left' | 'nearest-right';

/**
 * Everything the time-scale facade delegates to. The model owns clamping and
 * extrapolation; the facade adds only the disposed guard and the from > to check.
 */
export interface TimeScalePort<H = unknown> {
  /** True once chart.dispose() ran. */
  isDisposed(): boolean;
  /** True when the scale has no points (the range setters then no-op). */
  isEmpty(): boolean;
  /** The sortable numeric key used for the H-typed from > to check. */
  key(item: H): number;

  scrollPosition(): number;
  scrollToPosition(position: number, animated: boolean): void;
  scrollToRealTime(): void;
  fitContent(): void;
  reset(): void;

  getVisibleRange(): TimeRange<H> | null;
  setVisibleRange(range: TimeRange<H>): void;
  getVisibleLogicalRange(): LogicalRange | null;
  setVisibleLogicalRange(range: { from: number; to: number }): void;

  logicalToCoordinate(logical: number): Coordinate | null;
  coordinateToLogical(x: number): Logical | null;
  snapToBar(logical: number): Logical | null;
  timeToCoordinate(time: H): Coordinate | null;
  coordinateToTime(x: number): H | null;
  timeToLogical(time: H, mismatch: MismatchDirection): Logical | null;

  keyToLogical(key: number, extrapolate: boolean): Logical | null;
  logicalToKey(logical: number, extrapolate: boolean): HorzKey | null;
  keysInRange(range: { from: number; to: number }): readonly HorzKey[];

  barSpacing(): number;
  rightOffset(): number;
  width(): number;
  height(): number;

  // The chart owns and fires these.
  readonly events: {
    readonly visibleTimeRange: EventHub<[TimeRange<H> | null]>;
    readonly visibleLogicalRange: EventHub<[LogicalRange | null]>;
    readonly size: EventHub<[number, number]>;
  };
}

export interface TimeScaleApiDeps<H = unknown> {
  readonly port: TimeScalePort<H>;
  /** Apply the already-normalized timeScale options through the model. */
  applyOptions(patch: DeepPartial<TimeScaleOptions>): void;
  /** A fresh snapshot of the configured options, not live state. */
  options(): DeepReadonly<TimeScaleOptions>;
}

/**
 * Called once; the chart caches the singleton. Range setters throw RangeError for
 * from > to even on an empty scale, then no-op when the scale is empty.
 */
export function createTimeScaleApi<H = unknown>(deps: TimeScaleApiDeps<H>): ITimeScale<H> {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };
  const { visibleTimeRange, visibleLogicalRange, size } = port.events;

  const api: ITimeScale<H> = {
    scrollPosition(): number {
      guard();
      return port.scrollPosition();
    },
    scrollToPosition(position, animated): void {
      guard();
      if (!Number.isFinite(position)) {
        throw new RangeError(`scrollToPosition: position must be finite, got ${position}`);
      }
      port.scrollToPosition(position, animated ?? false);
    },
    scrollToRealTime(): void {
      guard();
      port.scrollToRealTime();
    },
    fitContent(): void {
      guard();
      port.fitContent();
    },
    reset(): void {
      guard();
      port.reset();
    },

    getVisibleRange(): TimeRange<H> | null {
      guard();
      return port.getVisibleRange();
    },
    setVisibleRange(range): void {
      guard();
      if (port.key(range.from) > port.key(range.to)) {
        throw new RangeError('setVisibleRange: from must be <= to');
      }
      if (port.isEmpty()) return;
      port.setVisibleRange(range);
    },
    getVisibleLogicalRange(): LogicalRange | null {
      guard();
      return port.getVisibleLogicalRange();
    },
    setVisibleLogicalRange(range): void {
      guard();
      if (range.from > range.to) {
        throw new RangeError('setVisibleLogicalRange: from must be <= to');
      }
      if (port.isEmpty()) return;
      port.setVisibleLogicalRange(range);
    },

    logicalToCoordinate(logical): Coordinate | null {
      guard();
      return port.logicalToCoordinate(logical);
    },
    coordinateToLogical(x): Logical | null {
      guard();
      return port.coordinateToLogical(x);
    },
    snapToBar(logical): Logical | null {
      guard();
      return port.snapToBar(logical);
    },
    timeToCoordinate(time): Coordinate | null {
      guard();
      return port.timeToCoordinate(time);
    },
    coordinateToTime(x): H | null {
      guard();
      return port.coordinateToTime(x);
    },
    timeToLogical(time, mismatch): Logical | null {
      guard();
      return port.timeToLogical(time, mismatch ?? 'none');
    },

    keyToLogical(key, opts): Logical | null {
      guard();
      return port.keyToLogical(key, opts?.extrapolate ?? false);
    },
    logicalToKey(logical, opts): HorzKey | null {
      guard();
      return port.logicalToKey(logical, opts?.extrapolate ?? false);
    },
    keysInRange(range): readonly HorzKey[] {
      guard();
      return port.keysInRange(range);
    },

    barSpacing(): number {
      guard();
      return port.barSpacing();
    },
    rightOffset(): number {
      guard();
      return port.rightOffset();
    },
    width(): number {
      guard();
      return port.width();
    },
    height(): number {
      guard();
      return port.height();
    },

    applyOptions(patch): void {
      guard();
      // rightOffsetPixels → bars resolves against the live bar spacing.
      const normalized = normalizeChartPatch(
        { timeScale: patch } as Record<string, unknown>,
        port.barSpacing(),
      );
      deps.applyOptions((normalized as { timeScale: DeepPartial<TimeScaleOptions> }).timeScale);
    },
    options(): DeepReadonly<TimeScaleOptions> {
      guard();
      return deps.options();
    },

    subscribeVisibleTimeRangeChange(h): Unsubscribe {
      guard();
      return visibleTimeRange.subscribe(h);
    },
    unsubscribeVisibleTimeRangeChange(h): void {
      guard();
      visibleTimeRange.unsubscribe(h);
    },
    subscribeVisibleLogicalRangeChange(h): Unsubscribe {
      guard();
      return visibleLogicalRange.subscribe(h);
    },
    unsubscribeVisibleLogicalRangeChange(h): void {
      guard();
      visibleLogicalRange.unsubscribe(h);
    },
    subscribeSizeChange(h): Unsubscribe {
      guard();
      return size.subscribe(h);
    },
    unsubscribeSizeChange(h): void {
      guard();
      size.unsubscribe(h);
    },
  };

  return api;
}
