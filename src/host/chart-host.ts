// The root host: owns the root <div>, the surface tree, the frame loop and the input
// pipeline. The render backend is injected; the host never imports a concrete backend.
import type { Rect, Size } from '../core';
import type { Snapshot } from '../gfx';
import type { ChartModel, UpdateMask } from '../model';
// Generic-free slice of the model so ChartHost does not inherit its H/I type params.
type HostModel = Pick<ChartModel, 'panes'>;
import { UpdateLevel, createMask } from '../model';
import { computeLayout, type AxisWidths, type LayoutRects } from './layout';
import { FrameLoop, type FrameDriver, type FrameProfiler, type IFrameScheduler } from './frame-scheduler';
import { InteractionRouter } from './input/router';
import { GestureMachine, type GesturePointer } from './input/gestures';
import type { GestureEvent, SurfaceKind } from './input/types';
import { registerDefaultBehaviors, type DefaultBehaviorPorts } from './input/behaviors';
import { attachDomInput, type DomInputTarget, type WheelIntent } from './input/dom-input';
import type { Unsubscribe, Coordinate } from '../core';
import { captureScreenshot, type SnapshotComposer } from './screenshot';
import { SurfaceHost, type HostElement, type SurfaceConfig, type SurfaceFactory } from './surface-host';

export interface ElementFactory {
  root(): HostElement;
  surfaceMount(): HostElement;
  separator(): HostElement;
}

export type HostBackend = SurfaceFactory & SnapshotComposer;

/** Per-frame model/views work the host drives but does not own. */
export interface ChartHostHooks {
  paneConfigs(): readonly PaneSurfaceConfigs[];
  measure(): MeasuredAxes;
  syncWidgets(): void;
  applyRender(mask: UpdateMask, now: number): void;
  animationRearmLevel(now: number): UpdateLevel;
  /** Hit-test a pointer over a pane and apply it to the crosshair. Returns true when hover state changed. */
  applyHover(paneIndex: number, x: number, y: number, now: number): boolean;
  /** Returns true when state changed. */
  clearHover(): boolean;
  pan(deltaXpx: number): void;
  zoom(step: number, atX: number): void;
  resetPane(paneIndex: number): void;
  priceAxisDrag(paneIndex: number, deltaYpx: number, axis: 'left' | 'right'): void;
  priceScroll(paneIndex: number, deltaYpx: number): void;
  panStart?(): void;
  panEnd?(pointerType: 'mouse' | 'touch' | 'pen'): void;
}

export interface PaneSurfaceConfigs {
  readonly pane: SurfaceConfig;
  readonly leftAxis: SurfaceConfig;
  readonly rightAxis: SurfaceConfig;
}

/** Measured axis dimensions in media px (0 ⇒ that surface is omitted). */
export interface MeasuredAxes {
  readonly axisWidths: AxisWidths;
  readonly timeAxisHeight: number;
  readonly timeAxis: SurfaceConfig;
  readonly leftStub: SurfaceConfig;
  readonly rightStub: SurfaceConfig;
}

export interface ChartHostDeps {
  readonly model: HostModel;
  readonly backend: HostBackend;
  readonly elements: ElementFactory;
  readonly scheduler: IFrameScheduler;
  readonly clock: () => number;
  readonly hooks: ChartHostHooks;
  readonly getDpr: () => number;
  readonly wheelSpeed?: number;
  /** Chromium-on-Windows reports PIXEL wheel deltas scaled by DPR; enables the ÷DPR correction. */
  readonly windowsChromium?: boolean;
  readonly separatorColor?: string;
  /** __TN_PROFILE__-only bench instrumentation; stripped otherwise. */
  readonly profiler?: FrameProfiler;
}

interface PaneRow {
  readonly pane: SurfaceHost;
  readonly leftAxis: SurfaceHost;
  readonly rightAxis: SurfaceHost;
  readonly separator: HostElement | null;
  readonly paneMount: HostElement;
}

export class ChartHost implements FrameDriver {
  readonly #deps: ChartHostDeps;
  readonly #root: HostElement;
  readonly #loop: FrameLoop;
  readonly #router = new InteractionRouter();
  readonly #machines = new Map<number, GestureMachine>(); // keyed by #machineKey
  readonly #surfaceTeardown = new Map<SurfaceHost, () => void>(); // mount removal + DOM-input detach
  readonly #rows: PaneRow[] = [];
  #timeAxis: SurfaceHost | null = null;
  #leftStub: SurfaceHost | null = null;
  #rightStub: SurfaceHost | null = null;
  #requested: Size = { width: 0, height: 0 };
  #layout: LayoutRects | null = null;
  #disposed = false;

  constructor(deps: ChartHostDeps) {
    this.#deps = deps;
    this.#root = deps.elements.root();
    const s = this.#root.style;
    s.position = 'relative';
    this.#loop = new FrameLoop(deps.scheduler, this, __TN_PROFILE__ ? deps.profiler : undefined);
    this.#buildTree();
    registerDefaultBehaviors(this.#router, this.#behaviorPorts());
  }

  input(): InteractionRouter {
    return this.#router;
  }

  invalidate(mask: UpdateMask): void {
    this.#loop.invalidate(mask);
  }

  /** Repaints synchronously so there is no one-frame lag between the container and the canvas. */
  setSize(size: Size): void {
    if (this.#disposed) return;
    this.#requested = { width: size.width, height: size.height };
    this.#loop.flushSync(createMask({ level: UpdateLevel.Layout }), this.#deps.clock());
  }

  syncWidgets(): void {
    this.#deps.hooks.syncWidgets();
    this.#reconcileRows();
  }

  computeLayout(): void {
    const m = this.#deps.hooks.measure();
    // One stretch factor per built surface row (default 1), so the layout pane count
    // always matches the surface tree even if the model is ahead of it.
    const modelPanes = this.#deps.model.panes().panes();
    const n = Math.max(this.#rows.length, 1);
    const stretch: number[] = [];
    for (let i = 0; i < n; i++) stretch.push(modelPanes[i]?.stretchFactor() ?? 1);
    this.#layout = computeLayout(this.#requested, stretch, m.axisWidths, m.timeAxisHeight, this.#deps.getDpr());
  }

  applySizes(): void {
    const L = this.#layout;
    if (L === null) return;
    // Absent surfaces get a 0-area rect (hidden).
    for (let i = 0; i < this.#rows.length; i++) {
      const row = this.#rows[i]!;
      const pr = L.panes[i];
      row.pane.setRect(pr?.pane ?? ZERO);
      row.leftAxis.setRect(pr?.leftAxis ?? ZERO);
      row.rightAxis.setRect(pr?.rightAxis ?? ZERO);
      if (row.separator !== null) this.#placeSeparator(row.separator, L.separators[i - 1] ?? ZERO);
    }
    this.#timeAxis?.setRect(L.timeAxis ?? ZERO);
    this.#leftStub?.setRect(L.leftStub ?? ZERO);
    this.#rightStub?.setRect(L.rightStub ?? ZERO);
  }

  applyRender(mask: UpdateMask, now: number): void {
    this.#deps.hooks.applyRender(mask, now);
  }

  paint(level: UpdateLevel, now: number): void {
    if (level === UpdateLevel.None) return;
    for (const sh of this.#allSurfaces()) sh.paint(level, now);
  }

  animationRearmLevel(now: number): UpdateLevel {
    return this.#deps.hooks.animationRearmLevel(now);
  }

  pointerDown(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerDown(p);
  }
  pointerMove(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerMove(p);
  }
  pointerUp(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerUp(p);
  }
  pointerCancel(paneIndex: number, kind: SurfaceKind, p: GesturePointer): void {
    this.#machineFor(paneIndex, kind)?.pointerCancel(p);
  }

  layoutRects(): LayoutRects | null {
    return this.#layout;
  }

  paneElement(index: number): HostElement | null {
    const row = this.#rows[index];
    return row === undefined ? null : row.paneMount;
  }

  /** Pump every gesture machine's clock once per frame (fires the long-press). */
  tickGestures(): void {
    for (const m of this.#machines.values()) m.tick();
  }

  /** Flushes synchronously, then composites every surface. `includeCrosshair: false` omits the overlay layer. */
  takeScreenshot(includeCrosshair = true): Snapshot {
    this.#loop.flushSync(createMask({ level: UpdateLevel.Render }), this.#deps.clock());
    const L = this.#layout ?? this.computeLayoutNow();
    return captureScreenshot(
      this.#deps.backend,
      [...this.#allSurfaces()],
      L.separators,
      this.#deps.separatorColor ?? '#e0e3eb',
      L.chartSize,
      includeCrosshair,
    );
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#loop.dispose();
    this.#router.dispose();
    for (const sh of this.#allSurfaces()) this.#disposeSurface(sh);
    this.#rows.length = 0;
  }

  computeLayoutNow(): LayoutRects {
    this.computeLayout();
    return this.#layout!;
  }

  #onGesture = (e: GestureEvent): void => {
    if (e.kind === 'hover' && e.surface === 'pane') {
      const changed = this.#deps.hooks.applyHover(e.paneIndex, e.x, e.y, this.#deps.clock());
      if (changed) this.#loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
      return; // hover is host-internal; it is not a router gesture
    }
    this.#router.dispatch(e);
  };

  #behaviorPorts(): DefaultBehaviorPorts {
    const h = this.#deps.hooks;
    return {
      pan: (dx) => h.pan(dx),
      zoom: (step, atX) => h.zoom(step, atX),
      resetPane: (i) => h.resetPane(i),
      priceAxisDrag: (i, dy, axis) => h.priceAxisDrag(i, dy, axis),
      priceScroll: (i, dy) => h.priceScroll(i, dy),
      clearHover: () => {
        if (h.clearHover()) this.#loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
      },
      panStart: () => h.panStart?.(),
      panEnd: (pointerType) => h.panEnd?.(pointerType),
    };
  }

  #buildTree(): void {
    const configs = this.#deps.hooks.paneConfigs();
    for (let i = 0; i < configs.length; i++) this.#rows.push(this.#buildRow(configs[i]!, i));
    const m = this.#deps.hooks.measure();
    const f = this.#deps.elements;
    this.#timeAxis = this.#mkSurface(f.surfaceMount(), m.timeAxis, -1);
    this.#leftStub = this.#mkSurface(f.surfaceMount(), m.leftStub, -1);
    this.#rightStub = this.#mkSurface(f.surfaceMount(), m.rightStub, -1);
  }

  #buildRow(c: PaneSurfaceConfigs, index: number): PaneRow {
    const f = this.#deps.elements;
    const sep = index > 0 ? f.separator() : null;
    if (sep !== null) {
      this.#root.appendChild(sep);
      sep.style.position = 'absolute';
    }
    const paneMount = f.surfaceMount();
    return {
      pane: this.#mkSurface(paneMount, c.pane, index),
      leftAxis: this.#mkSurface(f.surfaceMount(), c.leftAxis, index),
      rightAxis: this.#mkSurface(f.surfaceMount(), c.rightAxis, index),
      separator: sep,
      paneMount,
    };
  }

  #disposeSurface(sh: SurfaceHost): void {
    this.#surfaceTeardown.get(sh)?.();
    this.#surfaceTeardown.delete(sh);
    sh.dispose();
  }

  #mkSurface(mount: HostElement, config: SurfaceConfig, paneIndex: number): SurfaceHost {
    this.#root.appendChild(mount);
    mount.style.cursor =
      config.kind === 'price-axis' ? 'ns-resize' : config.kind === 'time-axis' ? 'ew-resize' : PANE_CURSOR;
    const sh = new SurfaceHost(
      mount,
      this.#deps.backend,
      config,
      this.#onResolutionChange,
      __TN_PROFILE__ ? this.#deps.profiler : undefined,
    );
    const machine = new GestureMachine(
      { surface: config.kind, paneIndex },
      this.#deps.clock,
      this.#onGesture,
    );
    this.#machines.set(this.#machineKey(paneIndex, config.kind), machine);
    // Coords are localized to the mount's box so the gesture path stays surface-local.
    // Feature-detected: a headless fake mount (no addEventListener) gets no live input.
    const dom = mount as unknown as Partial<DomInputTarget>;
    let detachInput: Unsubscribe | null = null;
    if (typeof dom.addEventListener === 'function') {
      detachInput = attachDomInput(
        dom as DomInputTarget,
        machine,
        (intent) => this.#onWheel(config.kind, paneIndex, intent),
        () => {
          const r = mount.getBoundingClientRect();
          return { left: r.left, top: r.top };
        },
        {
          wheelSpeed: this.#deps.wheelSpeed,
          windowsChromium: this.#deps.windowsChromium,
          getDpr: this.#deps.getDpr,
          // Clear the crosshair when the pointer leaves, otherwise it lingers.
          onLeave: () => {
            if (this.#deps.hooks.clearHover()) this.#loop.invalidate(createMask({ level: UpdateLevel.Overlay }));
          },
        },
      );
    }
    this.#surfaceTeardown.set(sh, () => {
      detachInput?.();
      this.#root.removeChild(mount);
    });
    return sh;
  }

  // The gesture machine does not recognize wheel; the DOM adapter normalizes it and the
  // host builds a discrete 'wheel' GestureEvent routed through the same sink.
  #onWheel(kind: SurfaceKind, paneIndex: number, intent: WheelIntent): void {
    const zoom = intent.ctrlKey && intent.zoom === 0 ? 0 : intent.zoom;
    const e: GestureEvent = {
      kind: 'wheel',
      phase: 'fire',
      surface: kind,
      paneIndex,
      x: intent.x as Coordinate,
      y: intent.y as Coordinate,
      startX: intent.x as Coordinate,
      startY: intent.y as Coordinate,
      deltaX: 0,
      deltaY: 0,
      wheelDeltaX: intent.scroll,
      wheelDeltaY: zoom,
      pointerType: 'mouse',
      modifiers: { ctrl: intent.ctrlKey, alt: false, shift: false, meta: false },
    };
    this.#onGesture(e);
  }

  #onResolutionChange = (): void => {
    this.#loop.invalidate(createMask({ level: UpdateLevel.Layout }));
  };

  #machineKey(paneIndex: number, kind: SurfaceKind): number {
    const k = kind === 'pane' ? 0 : kind === 'price-axis' ? 1 : 2;
    return (paneIndex + 1) * 4 + k;
  }

  #machineFor(paneIndex: number, kind: SurfaceKind): GestureMachine | undefined {
    return this.#machines.get(this.#machineKey(paneIndex, kind));
  }

  // Rebuild the pane rows whenever the panes' scenes no longer match row for row.
  #reconcileRows(): void {
    const configs = this.#deps.hooks.paneConfigs();
    const rows = this.#rows;
    const same =
      configs.length === rows.length &&
      configs.every(
        (c, i) =>
          rows[i]!.pane.scene() === c.pane.scene &&
          rows[i]!.leftAxis.scene() === c.leftAxis.scene &&
          rows[i]!.rightAxis.scene() === c.rightAxis.scene,
      );
    if (same) return;
    for (const row of rows) {
      this.#disposeSurface(row.pane);
      this.#disposeSurface(row.leftAxis);
      this.#disposeSurface(row.rightAxis);
      if (row.separator !== null) this.#root.removeChild(row.separator);
    }
    rows.length = 0;
    for (const k of [...this.#machines.keys()]) if (k >= 4) this.#machines.delete(k); // pane-row machines
    for (let i = 0; i < configs.length; i++) rows.push(this.#buildRow(configs[i]!, i));
  }

  #placeSeparator(sep: HostElement, rect: Rect): void {
    const s = sep.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
  }

  *#allSurfaces(): IterableIterator<SurfaceHost> {
    for (const row of this.#rows) {
      yield row.pane;
      yield row.leftAxis;
      yield row.rightAxis;
    }
    if (this.#timeAxis !== null) yield this.#timeAxis;
    if (this.#leftStub !== null) yield this.#leftStub;
    if (this.#rightStub !== null) yield this.#rightStub;
  }
}

const ZERO: Rect = { x: 0, y: 0, width: 0, height: 0 };

// Thin ash-grey '+' cursor (hotspot 12,12) that reads on light and dark backgrounds;
// falls back to the native 'crosshair'.
const PANE_CURSOR =
  "url(\"data:image/svg+xml,%3Csvg%20xmlns='http://www.w3.org/2000/svg'%20width='24'%20height='24'%3E%3Cpath%20d='M12%200V24M0%2012H24'%20stroke='%238a8a8a'%20stroke-width='1'/%3E%3C/svg%3E\") 12 12, crosshair";
