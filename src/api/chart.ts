// IChart facade over the model and injected host wiring. It owns the identity law (one
// cached handle per underlying entity, `===` across calls) and the disposed guard (after
// dispose() every method throws `disposed` at the facade boundary). dispose() is idempotent.
import { assert } from '../core';
import type { DeepPartial, DeepReadonly, Unsubscribe } from '../core';
import type { Snapshot } from '../gfx';
import type { IHorzScaleBehavior } from '../data';
import { UpdateLevel } from '../model';
import type { Pane, Series, ChartModel, ChartOptions } from '../model';
import type { IInteractionRouter } from '../host';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type MouseEventHandler } from './events';
import { normalizeChartPatch, snapshot } from './options';
import type { SeriesType, SeriesDefinition } from './series-defs';
import type { ISeries } from './series';
import type { ITimeScale } from './time-scale';
import type { IPriceScale } from './price-scale';
import type { IPane } from './pane';

export type { IPriceScale, IPane };

/**
 * The chart handle, generic over the horizontal item `H`. Every accessor returns a
 * cached handle; every method throws after dispose().
 */
export interface IChart<H = unknown> {
  dispose(): void;
  resize(width: number, height: number, forceRepaint?: boolean): void;
  autoSizeActive(): boolean;
  element(): HTMLDivElement;

  addSeries<D extends SeriesDefinition<SeriesType, unknown, unknown>>(
    definition: D,
    options?: DeepPartial<unknown>,
    paneIndex?: number,
  ): ISeries<SeriesType, H>;
  removeSeries(series: ISeries<SeriesType, H>): void;

  panes(): readonly IPane<H>[];
  addPane(preserveEmptyPane?: boolean): IPane<H>;
  removePane(index: number): void;
  swapPanes(a: number, b: number): void;

  timeScale(): ITimeScale<H>;
  priceScale(id: string, paneIndex?: number): IPriceScale;

  applyOptions(patch: DeepPartial<ChartOptions>): void;
  options(): DeepReadonly<ChartOptions>;

  setCrosshairPosition(price: number | null, horzItem: H, series?: ISeries<SeriesType, H>): void;
  clearCrosshairPosition(): void;

  horzBehavior(): IHorzScaleBehavior<H>;
  input(): IInteractionRouter;

  takeScreenshot(options?: { includeCrosshair?: boolean }): Snapshot;

  subscribeClick(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeClick(h: MouseEventHandler<H>): void;
  subscribeDblClick(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeDblClick(h: MouseEventHandler<H>): void;
  subscribeCrosshairMove(h: MouseEventHandler<H>): Unsubscribe;
  unsubscribeCrosshairMove(h: MouseEventHandler<H>): void;
}

/** The host surface the chart drives. ChartHost satisfies it structurally, so this file
 *  never names the backend. */
export interface ChartHostFacade {
  /** Synchronously flushes layout. */
  setSize(size: { width: number; height: number }): void;
  /** Flushes pending invalidations first; `includeCrosshair` (default true) toggles the overlay layer. */
  takeScreenshot(includeCrosshair?: boolean): Snapshot;
  input(): IInteractionRouter;
  dispose(): void;
}

/**
 * Structural work the chart delegates (model mutation, sibling handle construction);
 * tests pass recording fakes. The chart owns the disposed flag and the identity caches.
 */
export interface ChartWiring<H = unknown> {
  /** `paneIndex === paneCount` creates the pane. The chart caches the returned handle. */
  createSeries(
    definition: SeriesDefinition<SeriesType, unknown, unknown>,
    options: DeepPartial<unknown> | undefined,
    paneIndex: number,
  ): { model: Series; handle: ISeries<SeriesType, H> };
  destroySeries(model: Series): void;
  /** Detaches the pane's primitives; called BEFORE the model drops the pane. Optional for fakes. */
  destroyPane?(pane: Pane): void;
  createPane(pane: Pane): IPane<H>;
  /** Called once; the chart caches the singleton. */
  createTimeScale(): ITimeScale<H>;
  createPriceScale(pane: Pane, scaleId: string): IPriceScale;
  /** No-op cases (unknown series, empty scale) are handled here, not in the facade. */
  setCrosshairPosition(price: number | null, horzItem: H, series: Series | null): void;
  clearCrosshairPosition(): void;
  /** The model Series behind a public handle, or null when it is foreign. */
  seriesModel(handle: ISeries<SeriesType, H>): Series | null;
  /** Forwards the option groups the model does not own (price scales, time scale). */
  optionsApplied?(patch: DeepPartial<ChartOptions>): void;
  /** Fired by the wiring; the facade only exposes subscribe/unsubscribe and disposes them. */
  readonly events: {
    readonly click: EventHub<Parameters<MouseEventHandler<H>>>;
    readonly dblClick: EventHub<Parameters<MouseEventHandler<H>>>;
    readonly crosshairMove: EventHub<Parameters<MouseEventHandler<H>>>;
  };
}

/** One cell shared by every facade of a chart, so the disposed guard is chart-wide. */
export interface DisposedCell {
  value: boolean;
}

export interface ChartApiDeps<H = unknown> {
  readonly model: ChartModel<H>;
  readonly host: ChartHostFacade;
  readonly behavior: IHorzScaleBehavior<H>;
  readonly wiring: ChartWiring<H>;
  readonly disposed: DisposedCell;
  readonly element: HTMLDivElement;
  /** The live bar spacing rightOffsetPixels resolves against. */
  readonly barSpacing: () => number;
}

export function createChartApi<H = unknown>(deps: ChartApiDeps<H>): IChart<H> {
  const { model, host, behavior, wiring } = deps;

  const disposedCell = deps.disposed;
  const guard = (): void => {
    if (disposedCell.value) throwChartError(ChartErrorCode.Disposed);
  };

  // Keyed by the model object (WeakMap, so removed entities' handles are collectable).
  // Price scales are a per-pane id → handle map so a destroyed-then-recreated overlay
  // id gets a fresh handle.
  const paneHandles = new WeakMap<Pane, IPane<H>>();
  const priceScaleHandles = new WeakMap<Pane, Map<string, IPriceScale>>();
  let timeScaleHandle: ITimeScale<H> | null = null;

  const paneHandle = (pane: Pane): IPane<H> => {
    let h = paneHandles.get(pane);
    if (h === undefined) {
      h = wiring.createPane(pane);
      paneHandles.set(pane, h);
    }
    return h;
  };

  const priceScaleHandle = (pane: Pane, scaleId: string): IPriceScale => {
    let byId = priceScaleHandles.get(pane);
    if (byId === undefined) {
      byId = new Map();
      priceScaleHandles.set(pane, byId);
    }
    let h = byId.get(scaleId);
    if (h === undefined) {
      h = wiring.createPriceScale(pane, scaleId);
      byId.set(scaleId, h);
    }
    return h;
  };

  const { click: clickHub, dblClick: dblClickHub, crosshairMove: crosshairHub } = wiring.events;

  const panesArray = (): readonly Pane[] => model.panes().panes();
  const paneAt = (index: number): Pane => {
    const list = panesArray();
    if (index < 0 || index >= list.length) {
      throw new RangeError(`pane index ${index} out of bounds`);
    }
    return list[index]!;
  };

  const api: IChart<H> = {
    dispose(): void {
      if (disposedCell.value) return;
      disposedCell.value = true;
      clickHub.dispose();
      dblClickHub.dispose();
      crosshairHub.dispose();
      host.dispose();
    },

    resize(width, height, _forceRepaint): void {
      guard();
      // Under autoSize the ResizeObserver drives the size.
      if (model.options().autoSize) {
        console.warn('resize() is a no-op while autoSize is active (spec 02 §7)');
        return;
      }
      host.setSize({ width, height });
    },

    autoSizeActive(): boolean {
      guard();
      return model.options().autoSize;
    },

    element(): HTMLDivElement {
      guard();
      return deps.element;
    },

    addSeries(definition, options, paneIndex): ISeries<SeriesType, H> {
      guard();
      if (
        definition === null ||
        typeof definition !== 'object' ||
        typeof (definition as { createKind?: unknown }).createKind !== 'function'
      ) {
        throwChartError(ChartErrorCode.UnknownSeriesDefinition);
      }
      // paneIndex === paneCount creates a new pane.
      const count = model.panes().count();
      const target = paneIndex ?? 0;
      if (target < 0 || target > count) {
        throw new RangeError(`pane index ${target} out of bounds`);
      }
      const { handle } = wiring.createSeries(
        definition as SeriesDefinition<SeriesType, unknown, unknown>,
        options as DeepPartial<unknown> | undefined,
        target,
      );
      return handle;
    },

    removeSeries(series): void {
      guard();
      const m = wiring.seriesModel(series);
      if (m !== null) wiring.destroySeries(m);
    },

    panes(): readonly IPane<H>[] {
      guard();
      return panesArray().map(paneHandle);
    },

    addPane(_preserveEmptyPane): IPane<H> {
      guard();
      const pane = model.panes().addPane();
      model.invalidate(UpdateLevel.Layout);
      return paneHandle(pane);
    },

    removePane(index): void {
      guard();
      const list = panesArray();
      if (index < 0 || index >= list.length) {
        throw new RangeError(`pane index ${index} out of bounds`);
      }
      if (list.length === 1) return; // removing the last pane is a no-op
      wiring.destroyPane?.(list[index]!);
      model.panes().removePane(list[index]!);
      model.invalidate(UpdateLevel.Layout);
    },

    swapPanes(a, b): void {
      guard();
      model.panes().swapPanes(a, b); // throws RangeError out of bounds
      model.invalidate(UpdateLevel.Layout);
    },

    timeScale(): ITimeScale<H> {
      guard();
      if (timeScaleHandle === null) timeScaleHandle = wiring.createTimeScale();
      return timeScaleHandle;
    },

    priceScale(id, paneIndex): IPriceScale {
      guard();
      // Resolves immediately: 'left'/'right' always exist on a live pane; overlays only
      // while a series sits on them.
      const pane = paneAt(paneIndex ?? 0);
      if (pane.priceScale(id) === null) {
        throwChartError(ChartErrorCode.NoSuchScale, id);
      }
      return priceScaleHandle(pane, id);
    },

    applyOptions(patch): void {
      guard();
      // The model merges its own option subset; the wiring forwards the time/price-scale groups.
      const normalized = normalizeChartPatch(patch as Record<string, unknown>, deps.barSpacing());
      model.applyOptions(normalized as DeepPartial<ChartOptions>);
      wiring.optionsApplied?.(normalized as DeepPartial<ChartOptions>);
    },

    options(): DeepReadonly<ChartOptions> {
      guard();
      return snapshot(model.options());
    },

    setCrosshairPosition(price, horzItem, series): void {
      guard();
      if (__DEV__) {
        assert(price === null || series !== undefined, 'setCrosshairPosition: series is required when price is numeric (§7)');
      }
      const m = series !== undefined ? wiring.seriesModel(series) : null;
      wiring.setCrosshairPosition(price, horzItem, m);
    },

    clearCrosshairPosition(): void {
      guard();
      wiring.clearCrosshairPosition();
    },

    horzBehavior(): IHorzScaleBehavior<H> {
      guard();
      return behavior;
    },

    input(): IInteractionRouter {
      guard();
      return host.input();
    },

    takeScreenshot(options): Snapshot {
      guard();
      return host.takeScreenshot(options?.includeCrosshair ?? true);
    },

    subscribeClick(h): Unsubscribe {
      guard();
      return clickHub.subscribe(h);
    },
    unsubscribeClick(h): void {
      guard();
      clickHub.unsubscribe(h);
    },
    subscribeDblClick(h): Unsubscribe {
      guard();
      return dblClickHub.subscribe(h);
    },
    unsubscribeDblClick(h): void {
      guard();
      dblClickHub.unsubscribe(h);
    },
    subscribeCrosshairMove(h): Unsubscribe {
      guard();
      return crosshairHub.subscribe(h);
    },
    unsubscribeCrosshairMove(h): void {
      guard();
      crosshairHub.unsubscribe(h);
    },
  };

  return api;
}
