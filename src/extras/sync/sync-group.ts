// SyncGroup: keep the visible ranges and crosshairs of several charts in step.
// Ping-pong cannot loop because the public setters only fire change events on an actual
// value change, so A→B→A settles after one hop.
import type { Disposable, Unsubscribe } from '../../core';
import type { IChart, ITimeScale, MouseEventParams } from '../../api';

export interface SyncGroupOptions {
  /** `'logical'` (default) mirrors raw logical ranges, for charts with the same bars.
   *  `'time'` maps the range endpoints through time keys, for charts with different
   *  datasets. `'off'` disables range sync. */
  range?: 'off' | 'logical' | 'time';
  /** `'time'` (default) moves only the vertical time line on targets. `'time-price'` also
   *  places the price on each target's first pane-0 series, falling back to the time line
   *  when there is no such series or no price. `'off'` disables crosshair sync. */
  crosshair?: 'off' | 'time' | 'time-price';
}

interface PriceSeries {
  coordinateToPrice(coordinate: number): number | null;
}

type SyncChart<H> = IChart<H>;

/** Link `charts` together; `dispose()` removes every subscription. */
export function createSyncGroup<H = unknown>(
  charts: readonly IChart<H>[],
  opts?: SyncGroupOptions,
): Disposable {
  const rangeMode = opts?.range ?? 'logical';
  const crosshairMode = opts?.crosshair ?? 'time';

  const offs: Unsubscribe[] = [];
  // Re-entrancy guards, so a backend that re-fires on a same-value set cannot recurse.
  // One per channel: a crosshair event arriving mid range fan-out (or vice versa) is an
  // independent signal and must not be swallowed.
  let forwardingRange = false;
  let forwardingCrosshair = false;

  const ts = (c: SyncChart<H>): ITimeScale<H> => c.timeScale();

  // Read live on every event; panes and series can change between events.
  const firstPaneSeries = (c: SyncChart<H>): PriceSeries | null => {
    const panes = c.panes();
    if (panes.length === 0) return null;
    const series = (panes[0] as unknown as { series(): readonly unknown[] }).series();
    return series.length > 0 ? (series[0] as unknown as PriceSeries) : null;
  };
  const firstSeriesHandle = (c: SyncChart<H>): unknown => {
    const panes = c.panes();
    if (panes.length === 0) return null;
    const series = (panes[0] as unknown as { series(): readonly unknown[] }).series();
    return series.length > 0 ? series[0] : null;
  };

  if (rangeMode !== 'off') {
    for (const source of charts) {
      const off = ts(source).subscribeVisibleLogicalRangeChange((range) => {
        if (forwardingRange || range === null) return;
        forwardingRange = true;
        try {
          forwardRange(source, range);
        } finally {
          forwardingRange = false;
        }
      });
      offs.push(off);
    }
  }

  function forwardRange(source: SyncChart<H>, range: { from: number; to: number }): void {
    if (rangeMode === 'logical') {
      for (const target of charts) {
        if (target === source) continue;
        ts(target).setVisibleLogicalRange({ from: range.from, to: range.to });
      }
      return;
    }
    // 'time': source logical → key once, then key → each target's logical.
    const srcTs = ts(source);
    const fromKey = srcTs.logicalToKey(range.from, { extrapolate: true });
    const toKey = srcTs.logicalToKey(range.to, { extrapolate: true });
    if (fromKey === null || toKey === null) return;
    for (const target of charts) {
      if (target === source) continue;
      const tgtTs = ts(target);
      const from = tgtTs.keyToLogical(fromKey as number, { extrapolate: true });
      const to = tgtTs.keyToLogical(toKey as number, { extrapolate: true });
      if (from === null || to === null) continue; // empty target timeline
      tgtTs.setVisibleLogicalRange({ from: from as number, to: to as number });
    }
  }

  if (crosshairMode !== 'off') {
    for (const source of charts) {
      const off = source.subscribeCrosshairMove((params) => {
        if (forwardingCrosshair) return;
        forwardingCrosshair = true;
        try {
          forwardCrosshair(source, params);
        } finally {
          forwardingCrosshair = false;
        }
      });
      offs.push(off);
    }
  }

  function forwardCrosshair(source: SyncChart<H>, params: MouseEventParams<H>): void {
    if (params.logical === undefined) return;
    const key = ts(source).logicalToKey(params.logical as unknown as number, { extrapolate: true });
    if (key === null) return;
    const horz = key as unknown as H;

    // The event carries no price, so derive it from the pointer y on the source's first
    // pane-0 series. No point (leave/programmatic move), no series or an off-scale y
    // leaves it null, which means time line only.
    let price: number | null = null;
    if (crosshairMode === 'time-price' && params.point !== undefined) {
      const srcSeries = firstPaneSeries(source);
      if (srcSeries !== null) {
        const p = srcSeries.coordinateToPrice(params.point.y as unknown as number);
        if (p !== null) price = p;
      }
    }

    for (const target of charts) {
      if (target === source) continue;
      if (price === null) {
        target.setCrosshairPosition(null, horz);
        continue;
      }
      // The numeric-price form silently no-ops without a series, so choose the
      // time-line-only form explicitly for a series-less target.
      const tgtSeries = firstSeriesHandle(target);
      if (tgtSeries === null) {
        target.setCrosshairPosition(null, horz);
      } else {
        target.setCrosshairPosition(price, horz, tgtSeries as never);
      }
    }
  }

  let disposed = false;
  return {
    dispose(): void {
      if (disposed) return;
      disposed = true;
      for (const off of offs) off();
      offs.length = 0;
    },
  };
}
