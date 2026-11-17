// IPriceScale facade: a thin guarded map-through over the model PriceScale.
import type { BarPrice, DeepPartial, DeepReadonly } from '../core';
import type { PriceScaleOptions } from '../model';
import { ChartErrorCode, throwChartError } from './errors';

/**
 * Cached per (pane, scaleId) by the chart. Every method throws `disposed` after dispose()
 * and `no-such-scale` once the scale is destroyed (last overlay series left / pane
 * removed); a re-created id gets a fresh handle.
 */
export interface IPriceScale {
  id(): string;
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void;
  options(): DeepReadonly<PriceScaleOptions>;
  /** 0 for overlay scales. */
  width(): number;
  /** Null when the scale has no data. */
  getVisibleRange(): { from: BarPrice; to: BarPrice } | null;
  /** Disables autoscale first. from > to throws RangeError; no-op when there is no data. */
  setVisibleRange(range: { from: number; to: number }): void;
  /** Sugar for applyOptions({ autoScale }). */
  setAutoScale(on: boolean): void;
  /** Live state: true unless disabled by option or manual interaction. */
  autoScaleActive(): boolean;
}

/** The model owns the autoscale-disable and log de-noise math; the facade only guards. */
export interface PriceScalePort {
  /** True once chart.dispose() ran. */
  isDisposed(): boolean;
  /** False once the underlying scale is destroyed; the handle then stays dead. */
  isAlive(): boolean;
  /** True when the scale has no data (setVisibleRange then no-ops). */
  isEmpty(): boolean;

  id(): string;
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void;
  /** A fresh snapshot of the configured options, not live state. */
  options(): DeepReadonly<PriceScaleOptions>;
  width(): number;
  getVisibleRange(): { from: BarPrice; to: BarPrice } | null;
  /** Disables autoscale, then applies the manual range. */
  setVisibleRange(range: { from: number; to: number }): void;
  autoScaleActive(): boolean;
}

export interface PriceScaleApiDeps {
  readonly port: PriceScalePort;
}

/** Called once per (pane, scaleId); the chart caches it. `disposed` wins over `no-such-scale`. */
export function createPriceScaleApi(deps: PriceScaleApiDeps): IPriceScale {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
    if (!port.isAlive()) throwChartError(ChartErrorCode.NoSuchScale, port.id());
  };

  const api: IPriceScale = {
    id(): string {
      // Survives destruction (a dead handle still knows its id); only dispose silences it.
      if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
      return port.id();
    },

    applyOptions(patch): void {
      guard();
      port.applyOptions(patch);
    },
    options(): DeepReadonly<PriceScaleOptions> {
      guard();
      return port.options();
    },
    width(): number {
      guard();
      return port.width();
    },
    getVisibleRange(): { from: BarPrice; to: BarPrice } | null {
      guard();
      return port.getVisibleRange();
    },
    setVisibleRange(range): void {
      guard();
      // Malformed input throws even with no data; only then does a no-data scale no-op.
      if (range.from > range.to) {
        throw new RangeError('setVisibleRange: from must be <= to');
      }
      if (port.isEmpty()) return;
      port.setVisibleRange(range);
    },
    setAutoScale(on): void {
      guard();
      port.applyOptions({ autoScale: on });
    },
    autoScaleActive(): boolean {
      guard();
      return port.autoScaleActive();
    },
  };

  return api;
}
