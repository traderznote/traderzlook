// One series end to end: its store and timeline membership, its scene sources (the
// series itself, the last-value line, price lines) and the port behind ISeries.
import type { BarPrice, Coordinate, IFrameCounters, TimeIndex } from '../core';
import { DataValidationError, PlotStore, validateSeriesData } from '../data';
import type { IHorzScaleBehavior, PlotStoreView, StoreDiff as DataStoreDiff, Timeline, ValidationMode } from '../data';
import { DisplayListBuilder, LineStyle, ZBand } from '../gfx';
import type { DisplayList, SceneSource, ViewFrame } from '../gfx';
import { Series as ModelSeries, UpdateLevel, resolveBarColors, rowsInRange } from '../model';
import type { ChartModel, Pane, SeriesOptions } from '../model';
import { createPriceLineSource, itemWindow, shouldDecimate } from '../views';
import type { ItemBuffer, PaneScene, SeriesKind } from '../views';
import { toLineStyle } from './axis-sources';
import type { DisposedCell } from './chart';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type StoreDiff } from './events';
import type { FrameState, SeriesEntry } from './frame-state';
import { isVisible, scaleIdOf, seriesFormatter } from './frame-state';
import { createSeriesOptions, snapshot } from './options';
import { createPriceLineApi } from './price-line';
import { createSeriesApi } from './series';
import type {
  BarsInfo,
  IPaneHandle,
  IPriceLine,
  IPriceScaleHandle,
  MismatchDirection,
  PriceLineOptions,
  SeriesPort,
} from './series';
import type { SeriesDefinition, SeriesType } from './series-defs';

const EMPTY: readonly DisplayList[] = Object.freeze([]);

export interface SeriesWiringDeps<H> {
  readonly model: ChartModel<H, unknown>;
  readonly timeline: Timeline<{ time: unknown }, H, unknown>;
  readonly behavior: IHorzScaleBehavior<H, unknown>;
  readonly state: FrameState<H>;
  readonly disposed: DisposedCell;
  readonly counters: IFrameCounters | undefined;
  sceneFor(pane: Pane): PaneScene;
  paneHandle(pane: Pane): IPaneHandle;
  priceScaleHandle(pane: Pane, id: string): IPriceScaleHandle;
  validation(): ValidationMode;
  customPriceFormatter(): ((price: number) => string) | undefined;
  /** Another series' timeline slots moved; re-read them. */
  timelineShifted(source: SeriesEntry<H>): void;
  moveToPane(entry: SeriesEntry<H>, paneIndex: number): void;
  setOrder(entry: SeriesEntry<H>, order: number): void;
  order(entry: SeriesEntry<H>): number;
}

export interface WiredSeries<H> {
  readonly entry: SeriesEntry<H>;
  /** The series, last-value line and price-line sources, for (re)registration. */
  sources(): readonly SceneSource[];
  /** Data or timeline changed under this series: rebuild its item buffer. */
  markDirty(): void;
  /** Re-read slots after another series changed the shared timeline. */
  retime(): void;
}

// Map string line styles to the numeric enum the views expect.
function kindOptions(o: SeriesOptions): SeriesOptions {
  return { ...o, lineStyle: toLineStyle(o.lineStyle, LineStyle.Solid) };
}

function makeBuffer(kind: SeriesKind<unknown>): ItemBuffer<unknown> {
  const factory = (kind as { createBuffer?: () => ItemBuffer<unknown> }).createBuffer;
  if (typeof factory === 'function') return factory.call(kind);
  return (kind as { buffer?: ItemBuffer<unknown> }).buffer ?? ({ length: 0 } as unknown as ItemBuffer<unknown>);
}

function toChartError(e: unknown): never {
  if (!(e instanceof DataValidationError)) throw e;
  const code =
    e.kind === 'order'
      ? ChartErrorCode.InvalidDataOrder
      : e.kind === 'date'
        ? ChartErrorCode.InvalidDateString
        : e.kind === 'non-finite'
          ? ChartErrorCode.NonFiniteValue
          : ChartErrorCode.ValueOutOfBounds;
  throwChartError(code, e.message);
}

export function wireSeries<H>(
  deps: SeriesWiringDeps<H>,
  definition: SeriesDefinition<SeriesType, unknown, unknown>,
  options: unknown,
  pane: Pane,
  ownerId: number,
  z: number,
): WiredSeries<H> {
  const { model, timeline, behavior, state } = deps;
  const modelSeries = new ModelSeries({
    kind: definition.type as never,
    defaultOptions: createSeriesOptions(
      definition.defaultOptions as Record<string, unknown>,
      options as never,
      definition.normalizeOptions,
    ),
    normalizeOptions: definition.normalizeOptions,
  });
  const store = new PlotStore<unknown>(definition.contract);
  if (__TN_PROFILE__ && deps.counters !== undefined) store.setCounters(deps.counters);
  const isWhitespace = (item: unknown): boolean => definition.contract.isWhitespace(item);
  const keyOf = (item: unknown): number => behavior.key((item as { time: H }).time) as unknown as number;

  let kind = definition.createKind(kindOptions(modelSeries.options()));
  let buffer = makeBuffer(kind);
  let pendingDiff: DataStoreDiff | null = { kind: 'replace' };
  const builder = new DisplayListBuilder();
  let cached = EMPTY;
  const dataChanged = new EventHub<[StoreDiff]>();
  const priceLines: { handle: IPriceLine; source: SceneSource; options(): PriceLineOptions; kill(): void }[] = [];

  const entry: SeriesEntry<H> = {
    id: `s${ownerId}`,
    ownerId,
    model: modelSeries,
    store,
    pane,
    z,
    handle: null as never,
    rows: [],
    items: [],
    slots: [],
    axisLines: () =>
      priceLines
        .map((l) => l.options())
        .filter((o) => o.axisLabelVisible !== false)
        .map((o) => ({ price: o.price, color: o.axisLabelColor ?? o.color ?? '' })),
  };
  let slots: number[] = [];
  const syncSlots = (): void => {
    slots = timeline.timeIndicesFor(entry.id);
    entry.slots = slots;
  };

  // The store as the renderers see it, plus each row's own color overrides.
  const storeView: PlotStoreView = {
    get length() {
      return store.length;
    },
    timeIndex: (i) => store.timeIndex(i),
    current: (i) => store.current(i),
    min: (i) => store.min(i),
    max: (i) => store.max(i),
    lane: (n, i) => store.lane(n, i),
    firstIndexAt: (t) => store.firstIndexAt(t),
    nearestIndexAt: (t, d) => store.nearestIndexAt(t, d),
    minMaxInRows: (lo, hi) => store.minMaxInRows(lo, hi),
    pointColors: (i) => entry.rows[i] as ReturnType<NonNullable<PlotStoreView['pointColors']>>,
  };

  const scaleOf = (height?: number) => {
    const fallback = (model.options() as { defaultPriceScaleId?: string }).defaultPriceScaleId ?? 'right';
    return state.pane(entry.pane, height).scale(scaleIdOf(entry, fallback));
  };

  // --- rendering -----------------------------------------------------------------
  const rebuild = (frame: ViewFrame): void => {
    const n = store.length;
    const horz = state.horz();
    const slotsOnScreen = state.visibleSlots(horz);
    if (n === 0 || !isVisible(entry) || slotsOnScreen === null) {
      cached = EMPTY;
      return;
    }
    let [lo, hi] = rowsInRange(store, { from: slotsOnScreen.from as TimeIndex, to: slotsOnScreen.to as TimeIndex });
    if (kind.extendedRange) {
      lo = Math.max(0, Math.min(lo, n) - 1);
      hi = Math.min(n - 1, Math.max(hi, -1) + 1);
    }
    if (lo > hi) {
      cached = EMPTY;
      return;
    }
    const price = scaleOf(frame.frame.mediaSize.height).converter(entry);
    const win = itemWindow(lo, hi + 1);
    builder.reset();
    if (shouldDecimate(horz.barSpacing, frame.frame.hr)) {
      kind.decimate(store, win, frame, horz, price, builder);
    } else {
      if (pendingDiff !== null) {
        kind.itemsFromStore(storeView, pendingDiff, buffer);
        pendingDiff = null;
      }
      kind.convert(buffer, win, frame, horz, price);
      kind.emit(buffer, win, frame, builder);
    }
    cached = builder.finish();
  };
  const seriesSource: SceneSource = {
    zBand: ZBand.Series,
    update: rebuild,
    displayLists: () => cached,
    hitTest: (x: Coordinate, y: Coordinate) => (isVisible(entry) ? kind.hitTest(buffer, x, y) : null),
  };

  const lastBarColor = (row: number): string => {
    const bar = { open: store.lane(0, row), close: store.current(row) };
    return resolveBarColors(modelSeries.kind(), bar, {}, modelSeries.options()).barColor;
  };

  const lastValueLine = (): SceneSource => {
    const o = modelSeries.options() as {
      priceLineVisible?: boolean;
      priceLineWidth?: number;
      priceLineColor?: string;
      priceLineStyle?: unknown;
    };
    return createPriceLineSource(
      () => {
        const n = store.length;
        if (n === 0 || !isVisible(entry)) return { y: null, barColor: '', text: '' };
        const price = store.current(n - 1);
        return { y: scaleOf().toY(entry, price), barColor: modelSeries.priceLineColor(lastBarColor(n - 1)), text: '' };
      },
      {
        visible: o.priceLineVisible !== false,
        color: o.priceLineColor ?? '',
        lineWidth: o.priceLineWidth ?? 1,
        lineStyle: toLineStyle(o.priceLineStyle, LineStyle.Dashed),
      },
    );
  };
  let lastValueSource = lastValueLine();

  // --- data ------------------------------------------------------------------------
  const markDirty = (): void => {
    pendingDiff = { kind: 'replace' };
  };
  const changed = (diff: StoreDiff, level: UpdateLevel): void => {
    markDirty();
    model.invalidate(level);
    if (dataChanged.hasListeners()) dataChanged.emit(() => [diff]);
  };

  const setData = (next: readonly unknown[]): void => {
    let kept: readonly unknown[];
    try {
      kept = validateSeriesData(next as readonly { time: unknown }[], definition.contract as never, behavior, {
        validation: deps.validation(),
      });
    } catch (e) {
      toChartError(e);
    }
    const shifted = timeline.slotCount;
    const applied = timeline.applySeriesData(entry.id, kept as readonly { time: unknown }[], behavior);
    entry.items = kept.slice();
    entry.rows = applied.rows.map((r) => r.item);
    store.setData(entry.rows, applied.rows.map((r) => r.timeIndex as number));
    syncSlots();
    modelSeries.applyDiff(store, { kind: 'replace' });
    if (applied.firstChanged !== null && (applied.firstChanged as number) < shifted) deps.timelineShifted(entry);
    changed({ kind: 'replace' }, UpdateLevel.Layout);
  };

  const update = (item: unknown, historical: boolean): void => {
    const items = entry.items;
    const key = keyOf(item);
    const lastKey = items.length > 0 ? keyOf(items[items.length - 1]) : null;
    if (lastKey !== null && key < lastKey) {
      if (!historical) {
        throwChartError(ChartErrorCode.StaleUpdate, `time ${key} is older than the last bar ${lastKey}`);
      }
      const next = items.slice();
      let i = next.length - 1;
      while (i >= 0 && keyOf(next[i]) > key) i--;
      if (i >= 0 && keyOf(next[i]) === key) next[i] = item;
      else next.splice(i + 1, 0, item);
      setData(next);
      return;
    }
    try {
      validateSeriesData([item as { time: unknown }], definition.contract as never, behavior, {
        validation: deps.validation(),
      });
    } catch (e) {
      toChartError(e);
    }
    const replacing = lastKey !== null && key === lastKey;
    const wasReal = replacing && !isWhitespace(items[items.length - 1]);
    const isReal = !isWhitespace(item);
    if (replacing && wasReal !== isReal) {
      // A bar turning into whitespace (or back) changes the row count: take the full path.
      const next = items.slice();
      next[next.length - 1] = item;
      setData(next);
      return;
    }
    const slotCount = timeline.slotCount;
    const r = timeline.appendOrUpdateLast(entry.id, item as { time: unknown }, behavior);
    const ti = r.timeIndex as number;
    let diff: StoreDiff;
    if (replacing) {
      items[items.length - 1] = item;
      if (isReal) {
        store.updateLast(item, ti);
        entry.rows[entry.rows.length - 1] = item;
      }
      diff = { kind: 'updateLast' };
    } else {
      items.push(item);
      slots.push(ti);
      if (isReal) {
        store.append([item], [ti]);
        entry.rows.push(item);
      }
      diff = { kind: 'append', count: 1 };
    }
    modelSeries.applyDiff(store, { kind: 'replace' });
    if (r.firstChanged !== null && (r.firstChanged as number) < slotCount) {
      syncSlots();
      deps.timelineShifted(entry);
    }
    changed(diff, UpdateLevel.Render);
  };

  const retime = (): void => {
    syncSlots();
    const rowSlots: number[] = [];
    for (let i = 0; i < entry.items.length; i++) if (!isWhitespace(entry.items[i])) rowSlots.push(slots[i]!);
    store.retime(rowSlots);
    markDirty();
  };

  const rowAtSlot = (slot: number, mismatch: MismatchDirection): number | null => {
    const exact = store.firstIndexAt(slot as TimeIndex);
    if (exact !== null || mismatch === 'none' || store.length === 0) return exact;
    const r = store.nearestIndexAt(slot as TimeIndex, mismatch === 'nearest-left' ? 'left' : 'right');
    const t = store.timeIndex(r) as number;
    return (mismatch === 'nearest-left' ? t <= slot : t >= slot) ? r : null;
  };

  const barsInLogicalRange = (range: { from: number; to: number } | null): BarsInfo<H> | null => {
    if (range === null || store.length === 0) return null;
    const firstSlot = store.timeIndex(0) as number;
    const lastSlot = store.timeIndex(store.length - 1) as number;
    const info: BarsInfo<H> = { barsBefore: range.from - firstSlot, barsAfter: lastSlot - range.to };
    const [lo, hi] = rowsInRange(store, {
      from: Math.ceil(range.from) as TimeIndex,
      to: Math.floor(range.to) as TimeIndex,
    });
    if (lo <= hi) {
      info.from = (entry.rows[lo] as { time: H }).time;
      info.to = (entry.rows[hi] as { time: H }).time;
    }
    return info;
  };

  // --- price lines -----------------------------------------------------------------
  const createPriceLine = (lineOpts: PriceLineOptions): IPriceLine => {
    let stored = { ...lineOpts };
    let alive = true;
    const makeSource = (): SceneSource =>
      createPriceLineSource(
        () => ({ y: alive ? scaleOf().toY(entry, stored.price) : null, barColor: modelSeries.priceLineColor(), text: stored.title ?? '' }),
        {
          visible: stored.lineVisible ?? true,
          color: stored.color ?? '',
          lineWidth: stored.lineWidth ?? 1,
          lineStyle: toLineStyle(stored.lineStyle, LineStyle.Dashed),
          externalId: stored.id,
        },
      );
    const record = {
      handle: null as unknown as IPriceLine,
      source: makeSource(),
      options: () => stored,
      kill: () => {
        alive = false;
      },
    };
    record.handle = createPriceLineApi({
      port: {
        isDisposed: () => deps.disposed.value,
        isAlive: () => alive,
        applyOptions: (patch) => {
          stored = { ...stored, ...(patch as object) } as PriceLineOptions;
          const scene = deps.sceneFor(entry.pane);
          scene.unregister(record.source);
          record.source = makeSource();
          scene.register(record.source, { ownerZ: entry.z, ownerId: entry.ownerId });
          model.invalidate(UpdateLevel.Layout);
        },
        options: () => snapshot(stored),
      },
    });
    priceLines.push(record);
    deps.sceneFor(entry.pane).register(record.source, { ownerZ: entry.z, ownerId: entry.ownerId });
    model.invalidate(UpdateLevel.Layout);
    return record.handle;
  };

  const removePriceLine = (line: IPriceLine): void => {
    const i = priceLines.findIndex((l) => l.handle === line);
    if (i < 0) return;
    const [record] = priceLines.splice(i, 1);
    record!.kill();
    deps.sceneFor(entry.pane).unregister(record!.source);
    model.invalidate(UpdateLevel.Layout);
  };

  // --- options ---------------------------------------------------------------------
  const optionsChanged = (): void => {
    const scene = deps.sceneFor(entry.pane);
    kind = definition.createKind(kindOptions(modelSeries.options()));
    buffer = makeBuffer(kind);
    scene.unregister(lastValueSource);
    lastValueSource = lastValueLine();
    scene.register(lastValueSource, { ownerZ: entry.z, ownerId: entry.ownerId });
    markDirty();
    model.invalidate(UpdateLevel.Layout);
  };

  const port: SeriesPort<H> = {
    isDisposed: () => deps.disposed.value,
    setData,
    update,
    data: () => entry.items.slice(),
    dataByIndex: (logical, mismatch) => {
      const row = rowAtSlot(Math.round(logical), mismatch);
      return row === null ? null : entry.rows[row];
    },
    barsInLogicalRange: (range) => barsInLogicalRange(range as { from: number; to: number } | null),
    store: () => store,
    priceToCoordinate: (price) =>
      store.length === 0 ? null : (scaleOf().toY(entry, price) as Coordinate | null),
    coordinateToPrice: (y) => (store.length === 0 ? null : (scaleOf().toPrice(entry, y) as BarPrice | null)),
    priceFormatter: () => seriesFormatter(entry, deps.customPriceFormatter()),
    priceScale: () => {
      const id = scaleIdOf(entry);
      if (entry.pane.priceScale(id) === null) entry.pane.ensureOverlayScale(id);
      return deps.priceScaleHandle(entry.pane, id);
    },
    pane: () => deps.paneHandle(entry.pane),
    moveToPane: (index) => deps.moveToPane(entry, index),
    order: () => deps.order(entry),
    setOrder: (order) => deps.setOrder(entry, order),
    optionsChanged,
    createPriceLine,
    removePriceLine,
    priceLines: () => priceLines.map((l) => l.handle),
    lastValue: (globalLast) => {
      const n = store.length;
      if (n === 0) return null;
      let row = n - 1;
      if (!globalLast) {
        const slotsOnScreen = state.visibleSlots();
        if (slotsOnScreen !== null) {
          const [lo, hi] = rowsInRange(store, { from: slotsOnScreen.from as TimeIndex, to: slotsOnScreen.to as TimeIndex });
          if (lo <= hi) row = hi;
        }
      }
      return { price: store.current(row), color: lastBarColor(row) };
    },
    dataChanged,
  };

  entry.handle = createSeriesApi<SeriesType, H>(definition.type, modelSeries, port, definition.normalizeOptions);

  return {
    entry,
    sources: () => [seriesSource, lastValueSource, ...priceLines.map((l) => l.source)],
    markDirty,
    retime,
  };
}
