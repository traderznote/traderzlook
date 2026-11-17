// IPane facade: a thin guarded map-through over the model Pane.
import type { IPrimitive } from '../model';
import { ChartErrorCode, throwChartError } from './errors';
import type { SeriesType, SeriesDefinition } from './series-defs';
import type { IPriceScale } from './price-scale';

export type IPriceScaleHandle = IPriceScale;
/** Opaque series handle; the chart caches one per live series. */
export interface ISeriesHandle {
  seriesType(): string;
}

/** The pane handle. `index()` is the live position; `id()` ('p0','p1',…) is minted once,
 *  never reused, and survives moveTo/removePane/swapPanes. One cached handle per live
 *  pane; every method throws after dispose(). */
export interface IPane<H = unknown> {
  index(): number;
  id(): string;
  size(): { width: number; height: number };
  height(): number;
  setHeight(px: number): void;
  stretchFactor(): number;
  setStretchFactor(f: number): void;
  moveTo(index: number): void;
  series(): readonly ISeriesHandle[];
  priceScale(id: string): IPriceScaleHandle;
  addSeries<D extends SeriesDefinition<SeriesType, unknown, unknown>>(
    definition: D,
    options?: unknown,
  ): ISeriesHandle;
  preserveEmptyPane(): boolean;
  setPreserveEmptyPane(keep: boolean): void;
  element(): HTMLElement | null;
  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;
  /** Phantom: ties the handle to the chart's H. Never set. */
  readonly __h?: (h: H) => void;
}

/** IPane with a loose addSeries, and priceScale returning null when the id is absent in
 *  this pane. The model owns setHeight redistribution, the 30 px floor and moveTo bounds. */
export interface PanePort<H = unknown> extends Omit<IPane<H>, 'addSeries' | 'priceScale'> {
  isDisposed(): boolean;
  addSeries(definition: SeriesDefinition<SeriesType, unknown, unknown>, options: unknown): ISeriesHandle;
  priceScale(id: string): IPriceScaleHandle | null;
}

/**
 * Called once per pane; the chart caches the result. priceScale(id) resolves immediately:
 * 'left'/'right' always resolve on a live pane whatever their visibility, an overlay id
 * only while a series sits on it; anything else throws no-such-scale.
 */
export function createPaneApi<H = unknown>(port: PanePort<H>): IPane<H> {
  const guard = (): void => {
    if (port.isDisposed()) throwChartError(ChartErrorCode.Disposed);
  };

  const api: IPane<H> = {
    index(): number {
      guard();
      return port.index();
    },
    id(): string {
      guard();
      return port.id();
    },

    size(): { width: number; height: number } {
      guard();
      return port.size();
    },
    height(): number {
      guard();
      return port.height();
    },
    setHeight(px): void {
      guard();
      port.setHeight(px);
    },
    stretchFactor(): number {
      guard();
      return port.stretchFactor();
    },
    setStretchFactor(f): void {
      guard();
      port.setStretchFactor(f);
    },
    moveTo(index): void {
      guard();
      port.moveTo(index); // the model throws RangeError out of bounds
    },

    series(): readonly ISeriesHandle[] {
      guard();
      return port.series();
    },
    addSeries(definition, options): ISeriesHandle {
      guard();
      return port.addSeries(definition as SeriesDefinition<SeriesType, unknown, unknown>, options);
    },

    priceScale(id): IPriceScaleHandle {
      guard();
      const handle = port.priceScale(id);
      if (handle === null) throwChartError(ChartErrorCode.NoSuchScale, id);
      return handle;
    },

    preserveEmptyPane(): boolean {
      guard();
      return port.preserveEmptyPane();
    },
    setPreserveEmptyPane(keep): void {
      guard();
      port.setPreserveEmptyPane(keep);
    },
    element(): HTMLElement | null {
      guard();
      return port.element();
    },
    attachPrimitive(p): void {
      guard();
      port.attachPrimitive(p);
    },
    detachPrimitive(p): void {
      guard();
      port.detachPrimitive(p);
    },
  };

  return api;
}
