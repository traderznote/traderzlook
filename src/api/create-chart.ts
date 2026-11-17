// The join point: builds the model, the per-frame state, the scenes and the host over an
// injected render backend, and returns the IChart facade. createChart injects the canvas
// backend — the only file in `api` allowed to import backend-canvas.
import type { Coordinate, DeepPartial, HorzKey, IFrameCounters, Logical, TimeIndex } from '../core';
import { createFrameCounters } from '../core';
import type { IRenderBackend, SceneSource } from '../gfx';
import { LineStyle, ZBand } from '../gfx';
import { Timeline, timeBehavior } from '../data';
import type { IHorzScaleBehavior, Time } from '../data';
import {
  ChartModel,
  Crosshair,
  PriceScaleMode,
  UpdateLevel,
  createScrollAnimation,
  deNoiseLogVisibleRange,
  magnetSnapPrice,
  refusesManualScale,
  toLogRange,
} from '../model';
import type {
  AxisLabel,
  ChartOptions,
  CrosshairMode,
  CrosshairLineStyle,
  HorzAnimation,
  IPrimitive as ModelIPrimitive,
  MagnetCandidate,
  Pane,
  PriceScaleOptions,
} from '../model';
import { ChartHost, KineticTracker, computeLayout, createRafScheduler } from '../host';
import type { ElementFactory, FrameProfiler, HostElement, IFrameScheduler, IPerfSink, MeasuredAxes } from '../host';
import { PaneScene, PrimitiveBinding, createCrosshairSource } from '../views';
import type { OwnerPlacement, SurfaceKind, TaggedPrimitiveSource } from '../views';
import {
  createBackgroundSource,
  createGridFeed,
  createPriceAxisSource,
  createPriceCrosshairLabel,
  createTimeAxisSource,
  createTimeCrosshairLabel,
  measurePriceAxis,
  timeAxisHeightFor,
  toLineStyle,
} from './axis-sources';
import type { AxisContext, HoverState } from './axis-sources';
import { createChartApi } from './chart';
import type { ChartWiring, DisposedCell, IChart, IPane, IPriceScale } from './chart';
import { ChartErrorCode, throwChartError } from './errors';
import { EventHub, type MouseEventHandler, type MouseEventParams } from './events';
import { FrameState, isVisible, minMoveOf, scaleIdOf } from './frame-state';
import type { SeriesEntry } from './frame-state';
import { createLiveNav } from './live-nav';
import type { LiveNav } from './live-nav';
import { createPaneApi } from './pane';
import type { PanePort } from './pane';
import { createPriceScaleApi } from './price-scale';
import type { PrimitiveContext, IPrimitive } from './primitives';
import type { ISeries, LogicalRange } from './series';
import type { SeriesDefinition, SeriesType } from './series-defs';
import { wireSeries } from './series-wiring';
import type { WiredSeries } from './series-wiring';
import { createTimeScaleApi } from './time-scale';
import type { ITimeScale, TimeRange } from './time-scale';

export { createLiveNav };

/** Optional injection: share one rAF loop across charts and, in profiling builds only,
 *  receive per-frame stats. The profiling fields compile out without __TN_PROFILE__. */
export interface ChartEnvironment {
  scheduler?: IFrameScheduler;
  perfSink?: IPerfSink;
  frameCounters?: IFrameCounters;
}

interface ItemWithTime {
  time: unknown;
}

interface Hover extends HoverState {
  readonly originX: number;
  readonly originY: number;
}

const now = (): number => {
  const g = globalThis as { performance?: { now(): number } };
  return g.performance !== undefined ? g.performance.now() : Date.now();
};

export function createChartWith<H = Time>(
  container: HTMLElement | string,
  backend: IRenderBackend,
  behavior: IHorzScaleBehavior<H, unknown>,
  options?: DeepPartial<ChartOptions>,
  env?: ChartEnvironment,
): IChart<H> {
  const mount = resolveContainer(container);
  const doc = mount.ownerDocument ?? document;
  const element = doc.createElement('div');
  element.style.position = 'relative';
  mount.appendChild(element);

  const disposed: DisposedCell = { value: false };
  const beh = behavior as unknown as IHorzScaleBehavior<H, unknown>;
  let host: ChartHost | null = null;
  let state: FrameState<H> | null = null;
  const model = new ChartModel<H, unknown>({
    behavior: beh,
    invalidate: (mask) => {
      if (mask.level >= UpdateLevel.Render) state?.bump();
      host?.invalidate(mask);
    },
    options,
  });
  const opts = (): ChartOptions => model.options() as ChartOptions;
  const timeline = new Timeline<ItemWithTime, H, unknown>(beh);
  const binder = createPrimitiveBinder<H>(model);

  // Profiling builds only: one counter accumulator shared by every producing layer.
  let counters: IFrameCounters | undefined;
  let profiler: FrameProfiler | undefined;
  const inputLag = { frameSeq: 0, inputSeq: -1, pending: false };
  const markInput = (): void => {
    if (__TN_PROFILE__ && !inputLag.pending) {
      inputLag.inputSeq = inputLag.frameSeq;
      inputLag.pending = true;
    }
  };
  if (__TN_PROFILE__) {
    counters = env?.frameCounters ?? createFrameCounters();
    timeline.setCounters(counters);
    const inputLagFrames = (): number => {
      inputLag.frameSeq++;
      if (!inputLag.pending) return 0;
      inputLag.pending = false;
      return Math.max(0, inputLag.frameSeq - inputLag.inputSeq);
    };
    profiler = { counters, sink: env?.perfSink ?? { onFrame: () => {} }, now, inputLagFrames };
  }

  // --- size and layout -----------------------------------------------------------
  const rect = mount.getBoundingClientRect();
  const size = {
    width: opts().width > 0 ? opts().width : Math.max(0, Math.round(rect.width)),
    height: opts().height > 0 ? opts().height : Math.max(0, Math.round(rect.height)),
  };
  let axisWidths = { left: 0, right: 0 };
  const timeAxisHeight = (): number =>
    (opts().timeScale as { visible?: boolean } | undefined)?.visible === false ? 0 : timeAxisHeightFor(opts());
  const panes = (): readonly Pane[] => model.panes().panes();
  const paneIndexOf = (pane: Pane): number => panes().indexOf(pane);
  const dpr = (): number => (globalThis as { devicePixelRatio?: number }).devicePixelRatio || 1;
  // The same pure layout the host runs, so geometry is known before (and between) frames.
  const layoutNow = () => {
    ensureAxes();
    const stretch = panes().map((p) => p.stretchFactor());
    return computeLayout(size, stretch.length > 0 ? stretch : [1], axisWidths, timeAxisHeight(), dpr());
  };
  const paneWidth = (): number => layoutNow().paneWidth;
  const paneHeight = (pane: Pane): number => layoutNow().panes[paneIndexOf(pane)]?.pane.height ?? 0;

  // --- series registry + per-frame state -----------------------------------------
  const entries: SeriesEntry<H>[] = [];
  const wired = new Map<SeriesEntry<H>, WiredSeries<H>>();
  const paneSeries = new Map<SeriesEntry<H>, { kind(): string }>();
  const nav: LiveNav = createLiveNav(model, () => timeline.slotCount, paneWidth);
  const fs = new FrameState<H>({
    model,
    timeline,
    nav,
    entries: () => entries,
    paneWidth,
    paneHeight,
    customPriceFormatter: () => opts().localization?.priceFormatter,
  });
  state = fs;

  const timeAt = (slot: number): H | undefined => {
    for (const e of entries) {
      const s = e.slots;
      let lo = 0;
      let hi = s.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const v = s[mid]!;
        if (v === slot) return (e.items[mid] as { time: H }).time;
        if (v < slot) lo = mid + 1;
        else hi = mid - 1;
      }
    }
    return undefined;
  };

  // --- hover / crosshair ------------------------------------------------------------
  let hover: Hover | null = null;
  const events = {
    click: new EventHub<Parameters<MouseEventHandler<H>>>(),
    dblClick: new EventHub<Parameters<MouseEventHandler<H>>>(),
    crosshairMove: new EventHub<Parameters<MouseEventHandler<H>>>(),
  };

  const axisCtx: AxisContext<H> = {
    state: fs,
    timeline,
    behavior: beh as unknown as IHorzScaleBehavior<unknown, unknown>,
    measurer: backend.text,
    options: opts,
    hover: () => hover,
    paneIndex: paneIndexOf,
    timeAt,
    priceAxisLabels: (pane, side) => {
      const out: AxisLabel[] = [];
      for (const e of fs.paneEntries(pane)) {
        if (scaleIdOf(e) !== side) continue;
        for (const p of e.model.primitives()) out.push(...(p.priceAxisLabels?.() ?? []));
      }
      if (side === 'right') for (const p of binder.primitivesOf(pane)) out.push(...(p.priceAxisLabels?.() ?? []));
      return out;
    },
    timeAxisLabels: () => {
      const out: AxisLabel[] = [];
      for (const e of entries) for (const p of e.model.primitives()) out.push(...(p.timeAxisLabels?.() ?? []));
      for (const pane of panes()) for (const p of binder.primitivesOf(pane)) out.push(...(p.timeAxisLabels?.() ?? []));
      return out;
    },
  };

  const hitSeries = (paneIndex: number, x: number, y: number): SeriesEntry<H> | null => {
    const pane = panes()[paneIndex];
    if (pane === undefined) return null;
    const list = fs.paneEntries(pane);
    for (let i = list.length - 1; i >= 0; i--) {
      const src = wired.get(list[i]!)?.sources()[0];
      if (src?.hitTest?.(x as Coordinate, y as Coordinate, undefined as never)) return list[i]!;
    }
    return null;
  };

  const mouseParams = (paneIndex: number, x: number, y: number): MouseEventParams<H> => {
    const n = timeline.slotCount;
    const point = { x: x as Coordinate, y: y as Coordinate };
    if (n === 0) return { point, paneIndex, seriesData: new Map() };
    const index = Math.round(fs.horz().coordinateToLogical(x));
    const inData = index >= 0 && index < n;
    const seriesData = new Map<unknown, unknown>();
    if (inData) {
      for (const e of entries) {
        if (!isVisible(e)) continue;
        const row = e.store.firstIndexAt(index as TimeIndex);
        if (row !== null) seriesData.set(e.handle, e.rows[row]);
      }
    }
    const hit = hitSeries(paneIndex, x, y);
    return {
      time: inData ? timeAt(index) : undefined,
      logical: index as Logical,
      point,
      paneIndex,
      seriesData,
      ...(hit !== null && { hoveredInfo: { kind: 'series' as const, series: hit.handle, paneIndex } }),
    };
  };

  const applyHover = (paneIndex: number, x: number, y: number): boolean => {
    const n = timeline.slotCount;
    const pane = panes()[paneIndex];
    if (n === 0 || pane === undefined) return false;
    // The vertical line snaps to a bar slot, including the empty slots past either end of
    // the data; the horizontal line follows the pointer unless a magnet mode is on.
    const index = Math.round(fs.horz().coordinateToLogical(x));
    const pf = fs.pane(pane);
    const sf = pf.defaultScale();
    let price = sf?.toPrice(null, y) ?? Number.NaN;
    const mode = opts().crosshair.mode;
    const magnet = mode === 'magnet' || mode === 'magnet-ohlc';
    if (sf !== null && magnet) {
      const candidates: MagnetCandidate[] = [];
      for (const e of pf.entries) {
        const row = e.store.firstIndexAt(index as TimeIndex);
        if (row === null) continue;
        const s = pf.scale(scaleIdOf(e));
        candidates.push({
          open: e.store.lane(0, row),
          high: e.store.max(row),
          low: e.store.min(row),
          close: e.store.current(row),
          priceToCoordinate: (p) => s.toY(e, p) ?? Number.NaN,
        });
      }
      price = magnetSnapPrice({
        mode: mode as CrosshairMode,
        price,
        candidates,
        priceToCoordinate: (p) => sf.toY(null, p) ?? Number.NaN,
        coordinateToPrice: (c) => sf.toPrice(null, c) ?? Number.NaN,
      });
    }
    const lineY = magnet ? Number.NaN : y;
    const changed =
      hover === null || hover.index !== index || hover.paneIndex !== paneIndex || hover.price !== price || hover.y !== lineY;
    hover = { paneIndex, index, price, y: lineY, originX: x, originY: y };
    if (opts().hoveredSeriesOnTop) {
      // Lift the hovered series above its siblings; reordering needs a base repaint.
      const owner = hitSeries(paneIndex, x, y)?.ownerId ?? null;
      const scene = sceneFor(pane);
      if (scene.hoveredOwner() !== owner) {
        scene.setHoveredOwner(owner);
        model.invalidate(UpdateLevel.Render);
      }
    }
    if (events.crosshairMove.hasListeners()) events.crosshairMove.emit(() => [mouseParams(paneIndex, x, y)]);
    return changed;
  };

  const clearHover = (): boolean => {
    if (hover === null) return false;
    hover = null;
    if (events.crosshairMove.hasListeners()) events.crosshairMove.emit(() => [{ seriesData: new Map() }]);
    return true;
  };

  const crosshairLineOptions = (l: Partial<CrosshairLineStyle> | undefined) => ({
    ...(l?.color !== undefined && { color: l.color }),
    ...(l?.width !== undefined && { width: l.width }),
    ...(l?.visible !== undefined && { visible: l.visible }),
    ...(l?.style !== undefined && { style: toLineStyle(l.style, LineStyle.LargeDashed) }),
  });

  // Each pane draws the shared crosshair: the vertical line everywhere, the horizontal
  // line only on the hovered pane. Positions are re-derived every frame so the lines
  // follow the data through pans and zooms.
  const crosshairFeed = (pane: Pane): SceneSource => {
    const cross = new Crosshair();
    let sig = '';
    let inner: SceneSource | null = null;
    return {
      zBand: ZBand.Crosshair,
      update(frame): void {
        const c = opts().crosshair;
        const nextSig = JSON.stringify([c.vertLine, c.horzLine]);
        if (inner === null || nextSig !== sig) {
          sig = nextSig;
          inner = createCrosshairSource(cross, {
            vertLine: crosshairLineOptions(c.vertLine),
            horzLine: crosshairLineOptions(c.horzLine),
          });
        }
        cross.setMode(c.mode as CrosshairMode);
        if (hover === null || timeline.slotCount === 0) cross.clear(null);
        else {
          const x = fs.horz().indexToCoordinate(hover.index);
          let y = Number.NaN;
          if (hover.paneIndex === paneIndexOf(pane)) {
            y = Number.isFinite(hover.y)
              ? hover.y
              : (fs.pane(pane, frame.frame.mediaSize.height).defaultScale()?.toY(null, hover.price) ?? Number.NaN);
          }
          cross.setPosition({
            index: hover.index as TimeIndex,
            price: hover.price,
            x: x as Coordinate,
            y: y as Coordinate,
            originX: hover.originX as Coordinate,
            originY: hover.originY as Coordinate,
          });
        }
        inner.update(frame);
      },
      displayLists: () => inner?.displayLists() ?? [],
    };
  };

  // --- scenes -----------------------------------------------------------------------
  const background = (): string => opts().layout.background.color;
  const initPane = (pane: Pane): void => {
    const o = opts();
    if (o.rightPriceScale !== undefined) pane.priceScale('right')?.applyOptions(o.rightPriceScale as DeepPartial<PriceScaleOptions>);
    if (o.leftPriceScale !== undefined) pane.priceScale('left')?.applyOptions(o.leftPriceScale as DeepPartial<PriceScaleOptions>);
  };
  const scenes = new Map<Pane, PaneScene>();
  const sceneFor = (pane: Pane): PaneScene => {
    let s = scenes.get(pane);
    if (s === undefined) {
      initPane(pane);
      s = new PaneScene();
      s.register(createBackgroundSource(background), { ownerZ: -1, ownerId: -1 });
      s.register(createGridFeed(axisCtx, pane), { ownerZ: -1, ownerId: -1 });
      s.register(crosshairFeed(pane), { ownerZ: -1, ownerId: -1 });
      scenes.set(pane, s);
    }
    return s;
  };
  const axisScenes = new Map<Pane, { left: PaneScene; right: PaneScene }>();
  const axisSceneFor = (pane: Pane, side: 'left' | 'right'): PaneScene => {
    let pair = axisScenes.get(pane);
    if (pair === undefined) {
      const make = (s: 'left' | 'right'): PaneScene => {
        const scene = new PaneScene();
        scene.register(createBackgroundSource(background), { ownerZ: -1, ownerId: -1 });
        scene.register(createPriceAxisSource(axisCtx, pane, s), { ownerZ: -1, ownerId: -1 });
        scene.register(createPriceCrosshairLabel(axisCtx, pane, s), { ownerZ: -1, ownerId: -1 });
        return scene;
      };
      pair = { left: make('left'), right: make('right') };
      axisScenes.set(pane, pair);
    }
    return pair[side];
  };
  const plainScene = (): PaneScene => {
    const scene = new PaneScene();
    scene.register(createBackgroundSource(background), { ownerZ: -1, ownerId: -1 });
    return scene;
  };
  const timeAxisScene = plainScene();
  timeAxisScene.register(createTimeAxisSource(axisCtx), { ownerZ: -1, ownerId: -1 });
  timeAxisScene.register(createTimeCrosshairLabel(axisCtx), { ownerZ: -1, ownerId: -1 });
  const leftStubScene = plainScene();
  const rightStubScene = plainScene();

  // --- navigation animation (eased scrolls, kinetic fling) -------------------------
  let anim: HorzAnimation | null = null;
  let panX = 0;
  let tracker = new KineticTracker();
  const scrollTo = (position: number, animated: boolean): void => {
    anim = animated ? createScrollAnimation(nav.rightOffset(), position, now()) : null;
    if (!animated) nav.setRightOffset(position);
    model.invalidate(UpdateLevel.Render);
  };

  // --- time-scale events --------------------------------------------------------------
  const tsEvents = {
    visibleTimeRange: new EventHub<[TimeRange<H> | null]>(),
    visibleLogicalRange: new EventHub<[LogicalRange | null]>(),
    size: new EventHub<[number, number]>(),
  };
  const visibleTimeRange = (): TimeRange<H> | null => {
    const slots = fs.visibleSlots();
    if (slots === null) return null;
    const from = timeAt(slots.from);
    const to = timeAt(slots.to);
    return from === undefined || to === undefined ? null : { from, to };
  };
  let lastRangeSig = '';
  let lastSizeSig = '';
  const emitTimeScaleEvents = (): void => {
    const range = timeline.slotCount === 0 ? null : fs.horz().visibleLogicalRange();
    const rangeSig = range === null ? 'null' : `${range.from}|${range.to}`;
    if (rangeSig !== lastRangeSig) {
      lastRangeSig = rangeSig;
      tsEvents.visibleLogicalRange.emit(() => [range as LogicalRange | null]);
      tsEvents.visibleTimeRange.emit(() => [visibleTimeRange()]);
    }
    const sizeSig = `${paneWidth()}|${timeAxisHeight()}`;
    if (sizeSig !== lastSizeSig) {
      lastSizeSig = sizeSig;
      tsEvents.size.emit(() => [paneWidth(), timeAxisHeight()]);
    }
  };

  // --- host -------------------------------------------------------------------------
  const setPanesAutoScale = (on: boolean): void => {
    for (const pane of panes()) for (const ps of pane.priceScales()) ps.setAutoScale(on);
  };
  const scheduler =
    env?.scheduler ??
    createRafScheduler({
      requestAnimationFrame: (cb) => globalThis.requestAnimationFrame(cb),
      cancelAnimationFrame: (h) => globalThis.cancelAnimationFrame(h),
    });
  const elements: ElementFactory = {
    root: () => element as unknown as HostElement,
    surfaceMount: () => doc.createElement('div') as unknown as HostElement,
    separator: () => doc.createElement('div') as unknown as HostElement,
  };
  // An axis grows to fit its labels in 8px steps and only shrinks for a real change, so
  // the pane does not jitter while panning.
  const sideWidth = (side: 'left' | 'right', current: number): number => {
    const want = measurePriceAxis(axisCtx, panes(), side);
    if (want === 0) return 0;
    const q = Math.ceil(want / 8) * 8;
    return q > current || q < current - 16 ? q : current;
  };
  // Label widths depend on the visible range, which depends on the pane width, which
  // depends on the label widths: iterate to a fixed point once per state revision.
  let axesRev = -1;
  let measuring = false;
  function ensureAxes(): void {
    if (measuring || axesRev === fs.revision) return;
    measuring = true;
    try {
      for (let i = 0; i < 4; i++) {
        const next = { left: sideWidth('left', axisWidths.left), right: sideWidth('right', axisWidths.right) };
        if (next.left === axisWidths.left && next.right === axisWidths.right) break;
        axisWidths = next;
      }
    } finally {
      measuring = false;
      axesRev = fs.revision;
    }
  }
  const measure = (): MeasuredAxes => {
    ensureAxes();
    return {
      axisWidths,
      timeAxisHeight: timeAxisHeight(),
      timeAxis: { kind: 'time-axis', scene: timeAxisScene },
      leftStub: { kind: 'time-axis', scene: leftStubScene },
      rightStub: { kind: 'time-axis', scene: rightStubScene },
    };
  };

  host = new ChartHost({
    model: model as never,
    backend: backend as never,
    elements,
    scheduler,
    clock: now,
    getDpr: dpr,
    profiler: __TN_PROFILE__ ? profiler : undefined,
    hooks: {
      paneConfigs: () =>
        panes().map((pane) => ({
          pane: { kind: 'pane', scene: sceneFor(pane) },
          leftAxis: { kind: 'price-axis', scene: axisSceneFor(pane, 'left') },
          rightAxis: { kind: 'price-axis', scene: axisSceneFor(pane, 'right') },
        })),
      measure,
      syncWidgets: () => {},
      applyRender: (_mask, t) => {
        if (anim !== null) {
          nav.setRightOffset(anim.positionAt(t));
          if (anim.finished(t)) anim = null;
        }
        // Axis widths changed since the host last laid out (new data, a pan): re-layout.
        if (host !== null && host.layoutRects()?.paneWidth !== paneWidth()) model.invalidate(UpdateLevel.Layout);
        emitTimeScaleEvents();
      },
      animationRearmLevel: () => (anim !== null ? UpdateLevel.Render : UpdateLevel.None),
      applyHover: (paneIndex, x, y) => applyHover(paneIndex, x, y),
      clearHover,
      pan: (dx) => {
        markInput();
        anim = null;
        panX += dx;
        tracker.addPosition(panX, now());
        nav.pan(dx);
        model.invalidate(UpdateLevel.Render);
      },
      panStart: () => {
        anim = null;
        panX = 0;
        tracker = new KineticTracker();
      },
      panEnd: (pointerType) => {
        const k = opts().kineticScroll;
        const enabled = pointerType === 'mouse' ? k?.mouse === true : k?.touch !== false;
        const fling = enabled ? tracker.start(panX, now()) : null;
        if (fling === null) return;
        const r0 = nav.rightOffset();
        const s = nav.barSpacing();
        const x0 = panX;
        anim = { positionAt: (t) => r0 - (fling.positionAt(t) - x0) / s, finished: (t) => fling.finished(t) };
        model.invalidate(UpdateLevel.Render);
      },
      zoom: (step, atX) => {
        markInput();
        // A time zoom only changes the time axis: pin the price scales where they are.
        setPanesAutoScale(false);
        nav.zoom(step, atX);
        model.invalidate(UpdateLevel.Render);
      },
      resetPane: (paneIndex) => {
        markInput();
        nav.reset();
        for (const ps of panes()[paneIndex]?.priceScales() ?? []) {
          ps.setAutoScale(true);
          ps.setRange(null);
        }
        model.invalidate(UpdateLevel.Render);
      },
      priceAxisDrag: (paneIndex, dy, axis) => {
        markInput();
        const navp = panes()[paneIndex]?.priceScale(axis)?.navigator();
        if (navp === undefined) return;
        navp.startScale(0);
        navp.scaleTo(dy);
        navp.endScale();
        model.invalidate(UpdateLevel.Render);
      },
      priceScroll: (paneIndex, dy) => {
        markInput();
        const pane = panes()[paneIndex];
        if (dy === 0 || pane === undefined) return;
        const scale = pane.priceScale(fs.pane(pane).defaultScale()?.id ?? 'right');
        if (scale === null || scale.range() === null) return;
        if (scale.isAutoScale()) scale.setAutoScale(false);
        const navp = scale.navigator();
        navp.startScroll(0);
        navp.scrollTo(dy);
        navp.endScroll();
        model.invalidate(UpdateLevel.Render);
      },
    },
  });
  const setSize = (s: { width: number; height: number }): void => {
    size.width = s.width;
    size.height = s.height;
    fs.bump();
    nav.flushPending();
    host!.setSize(s);
  };
  setSize(size);

  // Clicks and double-clicks: observe every tap without claiming it.
  const router = host.input();
  router.register({
    kinds: ['tap'],
    surfaces: ['pane'],
    priority: Number.MAX_SAFE_INTEGER,
    handler: (e) => {
      if (events.click.hasListeners()) events.click.emit(() => [mouseParams(e.paneIndex, e.x, e.y)]);
      return 'pass';
    },
  });
  router.register({
    kinds: ['double-tap'],
    surfaces: ['pane'],
    priority: Number.MAX_SAFE_INTEGER,
    handler: (e) => {
      if (events.dblClick.hasListeners()) events.dblClick.emit(() => [mouseParams(e.paneIndex, e.x, e.y)]);
      return 'pass';
    },
  });

  let resizeObserver: { disconnect(): void } | null = null;
  const RO = (globalThis as { ResizeObserver?: new (cb: (e: { contentRect: { width: number; height: number } }[]) => void) => { observe(el: unknown): void; disconnect(): void } }).ResizeObserver;
  if (opts().autoSize && RO !== undefined) {
    const ro = new RO((list) => {
      const r = list[list.length - 1]?.contentRect;
      if (r !== undefined) setSize({ width: Math.floor(r.width), height: Math.floor(r.height) });
    });
    ro.observe(mount);
    resizeObserver = ro;
  }

  // --- primitives ---------------------------------------------------------------------
  let chartApi: IChart<H> | null = null;
  const ctxFor = (pane: Pane, seriesHandle?: ISeries<SeriesType, H>): PrimitiveContext<H> => ({
    get chart(): IChart<H> {
      return chartApi!;
    },
    series: seriesHandle,
    pane: paneHandle(pane) as unknown as PrimitiveContext<H>['pane'],
    requestUpdate(scope): void {
      model.invalidate(
        scope === 'layout' ? UpdateLevel.Layout : scope === 'render' ? UpdateLevel.Render : UpdateLevel.Overlay,
      );
    },
    get input() {
      return host!.input();
    },
    images: { create: (src: unknown) => backend.createImage(src as never) },
  });
  const placementFor = (pane: Pane, scaleId: string | null): OwnerPlacement => ({
    paneId: pane.id(),
    priceScaleId: scaleId,
    axisSide: scaleId === 'left' ? 'left' : scaleId === null ? null : 'right',
  });
  const surfaceScene = (pane: Pane, kind: SurfaceKind): PaneScene =>
    kind === 'pane'
      ? sceneFor(pane)
      : kind === 'time-axis'
        ? timeAxisScene
        : axisSceneFor(pane, kind === 'price-axis-left' ? 'left' : 'right');
  const attachSeriesPrimitive = (e: SeriesEntry<H>, p: ModelIPrimitive): void => {
    binder.attach(p as unknown as IPrimitive<H>, ctxFor(e.pane, e.handle), {
      owner: e.model,
      sceneFor: (kind) => surfaceScene(e.pane, kind),
      ownerZ: e.z,
      ownerId: e.ownerId,
      placement: placementFor(e.pane, scaleIdOf(e)),
    });
  };

  // --- handles --------------------------------------------------------------------------
  const paneHandles = new Map<Pane, IPane<H>>();
  const priceScaleHandles = new Map<string, { handle: IPriceScale; alive: () => boolean }>();
  const priceScaleHandle = (pane: Pane, scaleId: string): IPriceScale => {
    const key = `${pane.id()}\u0000${scaleId}`;
    const cached = priceScaleHandles.get(key);
    if (cached !== undefined && cached.alive()) return cached.handle;
    const made = makePriceScaleHandle(pane, scaleId);
    priceScaleHandles.set(key, made);
    return made.handle;
  };

  function makePriceScaleHandle(pane: Pane, scaleId: string): { handle: IPriceScale; alive: () => boolean } {
    let dead = false;
    const alive = (): boolean => {
      if (!dead && pane.priceScale(scaleId) === null) dead = true;
      return !dead;
    };
    const frame = () => fs.pane(pane).scale(scaleId);
    const handle = createPriceScaleApi({
      port: {
        isDisposed: () => disposed.value,
        isAlive: alive,
        isEmpty: () => frame().entries.length === 0,
        id: () => scaleId,
        applyOptions: (patch) => {
          pane.priceScale(scaleId)?.applyOptions(patch);
          model.invalidate(UpdateLevel.Layout);
        },
        options: () => pane.priceScale(scaleId)!.options() as never,
        width: () => (scaleId === 'left' ? axisWidths.left : scaleId === 'right' ? axisWidths.right : 0),
        getVisibleRange: () => {
          const f = frame();
          const r = f.scale.range();
          if (r === null) return null;
          if (f.mode === PriceScaleMode.Logarithmic) {
            const minMove = f.entries[0] !== undefined ? minMoveOf(f.entries[0]) : 0.01;
            return deNoiseLogVisibleRange(r, f.geom.logFormula, minMove) as never;
          }
          return { from: r.min, to: r.max } as never;
        },
        setVisibleRange: (range) => {
          const f = frame();
          if (refusesManualScale(f.mode)) return;
          const raw = { min: range.from, max: range.to };
          f.scale.setAutoScale(false);
          f.scale.setRange(f.mode === PriceScaleMode.Logarithmic ? toLogRange(raw, f.geom.logFormula) : raw);
          model.invalidate(UpdateLevel.Render);
        },
        autoScaleActive: () => pane.priceScale(scaleId)?.isAutoScale() ?? true,
      },
    }) as unknown as IPriceScale;
    return { handle, alive };
  }

  const paneHandle = (pane: Pane): IPane<H> => {
    let h = paneHandles.get(pane);
    if (h !== undefined) return h;
    const rectOf = () => layoutNow().panes[paneIndexOf(pane)]?.pane;
    const port: PanePort<H> = {
      isDisposed: () => disposed.value,
      index: () => paneIndexOf(pane),
      id: () => pane.id(),
      size: () => ({ width: rectOf()?.width ?? 0, height: rectOf()?.height ?? 0 }),
      height: () => rectOf()?.height ?? 0,
      setHeight: (px) => {
        const all = panes();
        if (all.length < 2) return;
        const total = all.reduce((a, p) => a + paneHeight(p), 0);
        const target = Math.min(Math.max(px, 30), total - 30 * (all.length - 1));
        const others = all.filter((p) => p !== pane);
        const otherStretch = others.reduce((a, p) => a + p.stretchFactor(), 0);
        pane.setStretchFactor((target / Math.max(1, total - target)) * otherStretch);
        model.invalidate(UpdateLevel.Layout);
      },
      stretchFactor: () => pane.stretchFactor(),
      setStretchFactor: (f) => {
        pane.setStretchFactor(f);
        model.invalidate(UpdateLevel.Layout);
      },
      moveTo: (index) => {
        model.panes().moveTo(pane, index);
        model.invalidate(UpdateLevel.Layout);
      },
      series: () => fs.paneEntries(pane).map((e) => e.handle as unknown as { seriesType(): string }),
      priceScale: (id) => (pane.priceScale(id) === null ? null : priceScaleHandle(pane, id)),
      addSeries: (definition, seriesOptions) =>
        wiring.createSeries(definition, seriesOptions as never, paneIndexOf(pane)).handle,
      preserveEmptyPane: () => pane.preserveEmptyPane(),
      setPreserveEmptyPane: (keep) => pane.setPreserveEmptyPane(keep),
      element: () => (host?.paneElement(paneIndexOf(pane)) ?? null) as HTMLElement | null,
      attachPrimitive: (p) =>
        binder.attach(p as unknown as IPrimitive<H>, ctxFor(pane), {
          owner: pane,
          sceneFor: (kind) => surfaceScene(pane, kind),
          ownerZ: -1,
          ownerId: -1,
          placement: placementFor(pane, 'right'),
        }),
      detachPrimitive: (p) => binder.detach(p as unknown as IPrimitive<H>),
    };
    h = createPaneApi<H>(port) as unknown as IPane<H>;
    paneHandles.set(pane, h);
    return h;
  };

  const timeToLogical = (time: H, mismatch: 'none' | 'nearest-left' | 'nearest-right'): Logical | null => {
    if (timeline.slotCount === 0) return null;
    const key = beh.key(time) as unknown as HorzKey;
    if (mismatch === 'none') return timeline.keyToLogical(key);
    return timeline.nearestSlotAt(key, mismatch === 'nearest-left' ? 'left' : 'right') as unknown as Logical;
  };
  const timeScaleHandle = (): ITimeScale<H> =>
    createTimeScaleApi<H>({
      port: {
        isDisposed: () => disposed.value,
        isEmpty: () => timeline.slotCount === 0,
        key: (item) => beh.key(item) as unknown as number,
        scrollPosition: () => nav.rightOffset(),
        scrollToPosition: (position, animated) => scrollTo(position, animated),
        scrollToRealTime: () =>
          scrollTo((opts().timeScale as { rightOffset?: number } | undefined)?.rightOffset ?? 0, true),
        fitContent: () => {
          anim = null;
          nav.fit();
          model.invalidate(UpdateLevel.Render);
        },
        reset: () => {
          anim = null;
          nav.reset();
          model.invalidate(UpdateLevel.Render);
        },
        getVisibleRange: visibleTimeRange,
        setVisibleRange: (range) => {
          const from = timeline.nearestSlotAt(beh.key(range.from) as unknown as HorzKey, 'right');
          const to = timeline.nearestSlotAt(beh.key(range.to) as unknown as HorzKey, 'left');
          nav.setVisibleRange(from, Math.max(from, to));
          model.invalidate(UpdateLevel.Render);
        },
        getVisibleLogicalRange: () =>
          timeline.slotCount === 0 ? null : (fs.horz().visibleLogicalRange() as LogicalRange | null),
        setVisibleLogicalRange: (range) => {
          anim = null;
          const s0 = nav.barSpacing();
          const r0 = nav.rightOffset();
          nav.setVisibleRange(range.from as number, range.to as number);
          // Synced charts echo ranges back: skip the repaint when nothing really moved.
          if (Math.abs(nav.barSpacing() - s0) > 1e-9 || Math.abs(nav.rightOffset() - r0) > 1e-9) {
            model.invalidate(UpdateLevel.Render);
          }
        },
        logicalToCoordinate: (logical) =>
          timeline.slotCount === 0 ? null : (fs.horz().indexToCoordinate(logical) as Coordinate),
        coordinateToLogical: (x) => (timeline.slotCount === 0 ? null : fs.horz().coordinateToLogical(x)),
        snapToBar: (logical) => {
          if (timeline.slotCount === 0) return null;
          const key = timeline.logicalToKey(logical as Logical, { extrapolate: true });
          return key === null ? null : (timeline.nearestSlotAt(key, 'right') as unknown as Logical);
        },
        timeToCoordinate: (time) => {
          const lg = timeToLogical(time, 'none');
          return lg === null ? null : (fs.horz().indexToCoordinate(lg) as Coordinate);
        },
        coordinateToTime: (x) => {
          const n = timeline.slotCount;
          if (n === 0) return null;
          const i = Math.round(fs.horz().coordinateToLogical(x));
          return i >= 0 && i < n ? (timeAt(i) ?? null) : null;
        },
        timeToLogical,
        keyToLogical: (key, extrapolate) => timeline.keyToLogical(key as unknown as HorzKey, { extrapolate }),
        logicalToKey: (logical, extrapolate) => timeline.logicalToKey(logical as Logical, { extrapolate }),
        keysInRange: (range) =>
          timeline.keysInRange({ from: range.from as Logical, to: range.to as Logical }) as unknown as readonly HorzKey[],
        barSpacing: () => nav.barSpacing(),
        rightOffset: () => nav.rightOffset(),
        width: paneWidth,
        height: timeAxisHeight,
        events: tsEvents,
      },
      applyOptions: (patch) => {
        model.applyOptions({ timeScale: patch } as DeepPartial<ChartOptions>);
        wiring.optionsApplied!({ timeScale: patch } as DeepPartial<ChartOptions>);
      },
      options: () => (opts() as unknown as { timeScale: never }).timeScale ?? ({} as never),
    });

  // --- series lifecycle -------------------------------------------------------------
  let ownerSeq = 0;
  const register = (e: SeriesEntry<H>): void => {
    const scene = sceneFor(e.pane);
    for (const s of wired.get(e)!.sources()) scene.register(s, { ownerZ: e.z, ownerId: e.ownerId });
  };
  const unregister = (e: SeriesEntry<H>): void => {
    const scene = sceneFor(e.pane);
    for (const s of wired.get(e)!.sources()) scene.unregister(s);
  };
  const paneOrder = (pane: Pane): SeriesEntry<H>[] =>
    entries.filter((e) => e.pane === pane).sort((a, b) => a.z - b.z);
  const renumber = (list: SeriesEntry<H>[]): void => {
    list.forEach((e) => unregister(e));
    list.forEach((e, i) => (e.z = i));
    list.forEach((e) => register(e));
  };

  const destroySeries = (e: SeriesEntry<H>): void => {
    binder.detachOwner(e.model);
    unregister(e);
    e.pane.removeSeries(paneSeries.get(e)!);
    entries.splice(entries.indexOf(e), 1);
    wired.delete(e);
    paneSeries.delete(e);
    const before = timeline.slotCount;
    const cleared = timeline.applySeriesData(e.id, [], beh);
    if (cleared.firstChanged !== null && (cleared.firstChanged as number) < before) {
      for (const w of wired.values()) w.retime();
    }
    model.invalidate(UpdateLevel.Layout);
  };

  const wiring: ChartWiring<H> = {
    createSeries(definition, seriesOptions, paneIndex) {
      const pm = model.panes();
      const pane = paneIndex === pm.count() ? pm.addPane() : pm.panes()[paneIndex]!;
      sceneFor(pane);
      const ownerId = ++ownerSeq;
      const w = wireSeries<H>(
        {
          model,
          timeline,
          behavior: beh,
          state: fs,
          disposed,
          counters,
          sceneFor,
          paneHandle: (p) => paneHandle(p) as never,
          priceScaleHandle: (p, id) => priceScaleHandle(p, id) as never,
          validation: () => opts().validation,
          customPriceFormatter: () => opts().localization?.priceFormatter,
          timelineShifted: (source) => {
            for (const [e, other] of wired) if (e !== source) other.retime();
          },
          moveToPane: (e, index) => moveToPane(e, index),
          setOrder: (e, order) => {
            const list = paneOrder(e.pane);
            list.splice(list.indexOf(e), 1);
            list.splice(Math.max(0, Math.min(order, list.length)), 0, e);
            renumber(list);
            model.invalidate(UpdateLevel.Render);
          },
          order: (e) => paneOrder(e.pane).indexOf(e),
        },
        definition as SeriesDefinition<SeriesType, unknown, unknown>,
        seriesOptions,
        pane,
        ownerId,
        paneOrder(pane).length,
      );
      const e = w.entry;
      entries.push(e);
      wired.set(e, w);
      const ps = { kind: () => e.model.kind() };
      paneSeries.set(e, ps);
      pane.addSeries(ps);
      register(e);
      const m = e.model;
      const baseAttach = m.attachPrimitive.bind(m);
      const baseDetach = m.detachPrimitive.bind(m);
      m.attachPrimitive = (p): void => {
        baseAttach(p);
        attachSeriesPrimitive(e, p);
      };
      m.detachPrimitive = (p): void => {
        baseDetach(p);
        binder.detach(p as unknown as IPrimitive<H>);
      };
      model.invalidate(UpdateLevel.Layout);
      return { model: m, handle: e.handle };
    },
    destroySeries(m) {
      const e = entries.find((x) => x.model === m);
      if (e !== undefined) destroySeries(e);
    },
    destroyPane(pane) {
      binder.detachOwner(pane);
      for (const e of entries.filter((x) => x.pane === pane)) destroySeries(e);
    },
    createPane: (pane) => paneHandle(pane),
    createTimeScale: timeScaleHandle,
    createPriceScale: (pane, scaleId) => priceScaleHandle(pane, scaleId),
    setCrosshairPosition: (price, horzItem, seriesModel) => {
      const n = timeline.slotCount;
      if (n === 0) return;
      const key = beh.key(horzItem) as unknown as HorzKey;
      const lg = timeline.keyToLogical(key);
      const index = Math.min(n - 1, Math.max(0, lg === null ? timeline.nearestSlotAt(key, 'right') : Math.round(lg)));
      const e = seriesModel === null ? undefined : entries.find((x) => x.model === seriesModel);
      const pane = e?.pane ?? panes()[0]!;
      let p = Number.NaN;
      if (price !== null && e !== undefined) {
        const pf = fs.pane(pane);
        const y = pf.scale(scaleIdOf(e)).toY(e, price);
        p = y === null ? Number.NaN : (pf.defaultScale()?.toPrice(null, y) ?? Number.NaN);
      }
      hover = { paneIndex: paneIndexOf(pane), index, price: p, y: Number.NaN, originX: Number.NaN, originY: Number.NaN };
      model.invalidate(UpdateLevel.Overlay);
      if (events.crosshairMove.hasListeners()) {
        events.crosshairMove.emit(() => [
          {
            time: horzItem,
            logical: index as Logical,
            paneIndex: paneIndexOf(pane),
            seriesData: e !== undefined && price !== null ? new Map([[e.handle, { value: price }]]) : new Map(),
          },
        ] as Parameters<MouseEventHandler<H>>);
      }
    },
    clearCrosshairPosition: () => {
      hover = null;
      model.invalidate(UpdateLevel.Overlay);
    },
    seriesModel(handle) {
      return entries.find((e) => e.handle === handle)?.model ?? null;
    },
    optionsApplied(patch) {
      const p = patch as {
        rightPriceScale?: object;
        leftPriceScale?: object;
        localization?: object;
        timeScale?: { barSpacing?: number; rightOffset?: number };
      };
      // Tick weights depend on the display timezone, which the behavior may read live.
      if (p.localization !== undefined || p.timeScale !== undefined) timeline.refreshWeights();
      for (const pane of panes()) {
        if (p.rightPriceScale !== undefined) pane.priceScale('right')?.applyOptions(p.rightPriceScale as never);
        if (p.leftPriceScale !== undefined) pane.priceScale('left')?.applyOptions(p.leftPriceScale as never);
      }
      if (p.timeScale?.barSpacing !== undefined) nav.setBarSpacing(p.timeScale.barSpacing);
      if (p.timeScale?.rightOffset !== undefined) nav.setRightOffset(p.timeScale.rightOffset);
      model.invalidate(UpdateLevel.Layout);
    },
    events,
  };

  function moveToPane(e: SeriesEntry<H>, paneIndex: number): void {
    const pm = model.panes();
    if (paneIndex < 0 || paneIndex > pm.count()) throw new RangeError(`pane index ${paneIndex} out of bounds`);
    const target = paneIndex === pm.count() ? pm.addPane() : pm.panes()[paneIndex]!;
    const from = e.pane;
    if (target === from) return;
    const primitives = e.model.primitives();
    binder.detachOwner(e.model);
    unregister(e);
    from.removeSeries(paneSeries.get(e)!);
    e.pane = target;
    e.z = paneOrder(target).filter((x) => x !== e).length;
    target.addSeries(paneSeries.get(e)!);
    sceneFor(target);
    register(e);
    for (const p of primitives) attachSeriesPrimitive(e, p);
    renumber(paneOrder(from));
    if (from.isEmpty() && !from.preserveEmptyPane() && pm.count() > 1) {
      binder.detachOwner(from);
      pm.removePane(from);
    }
    model.invalidate(UpdateLevel.Layout);
  }

  chartApi = createChartApi<H>({
    model,
    host: {
      setSize,
      takeScreenshot: (includeCrosshair) => host!.takeScreenshot(includeCrosshair),
      input: () => host!.input(),
      dispose: () => {
        resizeObserver?.disconnect();
        binder.detachAll();
        host!.dispose();
        if (mount.contains(element)) mount.removeChild(element);
      },
    },
    behavior: behavior as IHorzScaleBehavior<H>,
    wiring,
    disposed,
    element,
    barSpacing: () => nav.barSpacing(),
  });
  return chartApi;
}

// --- createChart: the tree-shaken sugar ---------------------------------------------
// The only backend-canvas import in `api`.
import { canvasBackend } from '../backend-canvas';

/** createChart(c, o) ≡ createChartWith(c, canvasBackend(), timeBehavior(), o). */
export function createChart(container: HTMLElement | string, options?: DeepPartial<ChartOptions>): IChart<Time> {
  return createChartWith<Time>(
    container,
    canvasBackend(),
    timeBehavior() as IHorzScaleBehavior<Time, unknown>,
    options,
  );
}

export function version(): string {
  return '1.0.0';
}

export { canvasBackend, timeBehavior };

function resolveContainer(container: HTMLElement | string): HTMLElement {
  if (typeof container !== 'string') return container;
  const doc = typeof document !== 'undefined' ? document : null;
  const el = doc?.getElementById(container) ?? null;
  if (el === null) throwChartError(ChartErrorCode.ContainerNotFound, container);
  return el;
}

// --- primitive binding ----------------------------------------------------------------

interface PrimitiveAttachInit {
  readonly owner: object;
  /** The scene for each surface a primitive source can target (null = nowhere). */
  sceneFor(kind: SurfaceKind): PaneScene | null;
  readonly ownerZ: number;
  readonly ownerId: number;
  readonly placement: OwnerPlacement;
}

/**
 * Drives the primitive lifecycle: attach runs attached(ctx) and registers each source in
 * the scene of the surface it targets (pane, price axis or time axis); detach (explicit,
 * by owner, or all) fires detached() exactly once and unregisters them.
 */
function createPrimitiveBinder<H>(model: ChartModel<H, unknown>): {
  attach(p: IPrimitive<H>, ctx: PrimitiveContext<H>, init: PrimitiveAttachInit): void;
  detach(p: IPrimitive<H>): void;
  detachOwner(owner: object): void;
  detachAll(): void;
  primitivesOf(owner: object): IPrimitive<H>[];
} {
  const live = new Map<IPrimitive<H>, { owner: object; homes: { scene: PaneScene; source: SceneSource }[] }>();
  const detachOne = (p: IPrimitive<H>): void => {
    const entry = live.get(p);
    if (entry === undefined) return;
    live.delete(p);
    for (const h of entry.homes) h.scene.unregister(h.source);
    p.detached?.();
    model.invalidate(UpdateLevel.Render);
  };
  return {
    attach(p, ctx, init): void {
      if (live.has(p)) return;
      p.attached?.(ctx);
      const homes: { scene: PaneScene; source: SceneSource }[] = [];
      for (const raw of p.sources?.() ?? []) {
        const binding = new PrimitiveBinding(raw as unknown as TaggedPrimitiveSource, init.placement);
        const kind = binding.surfaceKey();
        const scene = kind === null ? null : init.sceneFor(kind);
        if (scene === null) continue;
        scene.register(binding.source(), { ownerZ: init.ownerZ, ownerId: init.ownerId });
        homes.push({ scene, source: binding.source() });
      }
      live.set(p, { owner: init.owner, homes });
      model.invalidate(UpdateLevel.Render);
    },
    detach: detachOne,
    detachOwner(owner): void {
      for (const [p, e] of [...live]) if (e.owner === owner) detachOne(p);
    },
    detachAll(): void {
      for (const p of [...live.keys()]) detachOne(p);
    },
    primitivesOf: (owner) => [...live].filter(([, e]) => e.owner === owner).map(([p]) => p),
  };
}
