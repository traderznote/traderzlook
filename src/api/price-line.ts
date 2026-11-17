// IPriceLine facade: boundary guards over a series-owned port; no business logic.
import type { DeepPartial, DeepReadonly } from '../core';
import { ChartErrorCode, throwChartError } from './errors';
import type { IPriceLine, PriceLineOptions } from './series';

/** The series-owned port; the model owns the merge, reset target and snapshot. */
export interface PriceLinePort {
  /** True once chart.dispose() ran. */
  isDisposed(): boolean;
  /** False once series.removePriceLine ran; the handle is then permanently dead. */
  isAlive(): boolean;
  applyOptions(patch: DeepPartial<PriceLineOptions>): void;
  /** A fresh, immutable snapshot (never the live object). */
  options(): DeepReadonly<PriceLineOptions>;
}

export interface PriceLineApiDeps {
  readonly port: PriceLinePort;
}

/**
 * Called once per createPriceLine; the series caches the handle. After chart.dispose()
 * or series.removePriceLine every method throws `disposed` (a removed line is disposed
 * from the caller's view; there is no per-line error code).
 */
export function createPriceLineApi(deps: PriceLineApiDeps): IPriceLine {
  const { port } = deps;
  const guard = (): void => {
    if (port.isDisposed() || !port.isAlive()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: IPriceLine = {
    applyOptions(patch): void {
      guard();
      port.applyOptions(patch);
    },
    options(): DeepReadonly<PriceLineOptions> {
      guard();
      return port.options();
    },
  };

  return api;
}
