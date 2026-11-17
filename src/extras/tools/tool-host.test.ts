import { describe, expect, test, vi } from 'vitest';
import { HitPriority, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import type {
  GestureEvent,
  GestureRegistration,
  GestureResponse,
  IChart,
  IPane,
  IPrimitive,
  PrimitiveContext,
} from '../../api';
import {
  createToolHost,
  TrendLineTool,
  trendLineDefaults,
  type Anchor,
  type SerializedShape,
  type ToolHostEvent,
} from './tool-host';

// Five slots at keys 1000..1400, 10 px per slot (x = logical * 10). Keys interpolate
// inside the grid and extrapolate at 100 per slot outside it.
const KEYS = [1000, 1100, 1200, 1300, 1400];
const SPACING = 100;
const BAR_PX = 10;

function makeTimeScale() {
  return {
    coordinateToLogical: (x: number): number | null => x / BAR_PX,
    logicalToCoordinate: (logical: number): number | null => logical * BAR_PX,
    logicalToKey: (logical: number, opts?: { extrapolate?: boolean }): number | null => {
      if (logical >= 0 && logical <= KEYS.length - 1) {
        const lo = Math.floor(logical);
        const frac = logical - lo;
        const hi = Math.min(lo + 1, KEYS.length - 1);
        return KEYS[lo]! + frac * (KEYS[hi]! - KEYS[lo]!);
      }
      if (!opts?.extrapolate) return null;
      if (logical < 0) return KEYS[0]! + logical * SPACING;
      return KEYS[KEYS.length - 1]! + (logical - (KEYS.length - 1)) * SPACING;
    },
    keyToLogical: (key: number, opts?: { extrapolate?: boolean }): number | null => {
      const logical = (key - KEYS[0]!) / SPACING;
      if (logical >= 0 && logical <= KEYS.length - 1) return logical;
      return opts?.extrapolate ? logical : null;
    },
  };
}

// y = 100 - price
function makeSeries() {
  return {
    coordinateToPrice: (y: number): number | null => 100 - y,
    priceToCoordinate: (price: number): number | null => 100 - price,
  };
}

function makePane(id: string, series: ReturnType<typeof makeSeries> | null) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    id: () => id,
    series: () => (series === null ? [] : [series]),
    attachPrimitive: (p: IPrimitive) => void attached.push(p),
    detachPrimitive: (p: IPrimitive) => void detached.push(p),
  };
}

// Records registrations so tests can check the priority and call the handler directly.
function makeRouter() {
  const regs: GestureRegistration[] = [];
  return {
    regs,
    register(reg: GestureRegistration) {
      regs.push(reg);
      return () => {
        const i = regs.indexOf(reg);
        if (i >= 0) regs.splice(i, 1);
      };
    },
  };
}

interface Stub {
  router: ReturnType<typeof makeRouter>;
  panes: ReturnType<typeof makePane>[];
  ts: ReturnType<typeof makeTimeScale>;
  chart: IChart;
}

function makeChart(opts?: { panes?: ReturnType<typeof makePane>[] }): Stub {
  const router = makeRouter();
  const ts = makeTimeScale();
  const panes = opts?.panes ?? [makePane('p0', makeSeries())];
  const chart = {
    timeScale: () => ts,
    input: () => router,
    panes: () => panes,
  } as unknown as IChart;
  return { router, panes, ts, chart };
}

const gesture = (over: Partial<GestureEvent>): GestureEvent =>
  ({
    kind: 'tap',
    phase: 'fire',
    surface: 'pane',
    paneIndex: 0,
    x: 0,
    y: 0,
    startX: 0,
    startY: 0,
    deltaX: 0,
    deltaY: 0,
    pointerType: 'mouse',
    modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    ...over,
  }) as GestureEvent;

const FRAME: ViewFrame = {
  frame: { mediaSize: { width: 300, height: 200 }, bitmapSize: { width: 300, height: 200 }, hr: 1, vr: 1 },
  now: 0,
} as unknown as ViewFrame;

// A 2..4-anchor tool whose shape only stores its anchors.
const MultiAnchorTool = {
  type: 'multi-anchor',
  anchors: { min: 2, max: 4 },
  defaultStyle: { color: '#0F0' },
  createShape(initial: readonly Anchor[], style: { color: string }) {
    let anchors: Anchor[] = initial.map((a) => ({ ...a }));
    let selected = false;
    return {
      attached: () => {},
      detached: () => {},
      sources: () => [],
      setAnchors: (next: readonly Anchor[]) => void (anchors = next.map((a) => ({ ...a }))),
      setSelected: (s: boolean) => void (selected = s),
      serialize: () => ({ type: 'multi-anchor', version: 1, anchors: anchors.map((a) => ({ ...a })), style }),
      get _anchors() {
        return anchors;
      },
      get _selected() {
        return selected;
      },
    };
  },
};

function placeTrendLine(stub: Stub, taps: { x: number; y: number }[]): { host: ReturnType<typeof createToolHost>; events: ToolHostEvent[] } {
  const host = createToolHost(stub.chart);
  const events: ToolHostEvent[] = [];
  host.subscribe((e) => events.push(e));
  host.registerTool(TrendLineTool as never);
  host.arm('trend-line');
  for (const t of taps) stub.router.regs[0]!.handler(gesture({ kind: 'tap', x: t.x as never, y: t.y as never }));
  return { host, events };
}

function attachedPrimitive(pane: ReturnType<typeof makePane>): IPrimitive {
  return pane.attached[pane.attached.length - 1]!;
}
function paneSource(p: IPrimitive): SceneSource {
  const srcs = p.sources?.() ?? [];
  return srcs[0]!.source as unknown as SceneSource;
}
function ctxFor(pane: ReturnType<typeof makePane>, chart: IChart): PrimitiveContext {
  const updates: string[] = [];
  return {
    chart,
    pane: pane as unknown as IPane,
    series: undefined,
    requestUpdate: (s: 'overlay' | 'render' | 'layout') => void updates.push(s),
    input: chart.input(),
    images: { create: () => ({}) as never },
    __updates: updates,
  } as unknown as PrimitiveContext;
}

describe('T1 — InteractionRouter priority + claim (the default pan/zoom yield)', () => {
  test('arm registers ONE tool handler at a priority above the priority-0 defaults', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    expect(stub.router.regs.length).toBe(1);
    expect(stub.router.regs[0]!.priority).toBeGreaterThan(0);
    expect(stub.router.regs[0]!.kinds).toContain('tap');
    expect(stub.router.regs[0]!.surfaces).toEqual(['pane']);
  });

  test('while armed the handler CLAIMS taps/hover (so a priority-0 pan never sees them)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    const handler = stub.router.regs[0]!.handler;
    expect(handler(gesture({ kind: 'tap', x: 0 as never, y: 50 as never }))).toBe<GestureResponse>('claim');
    expect(handler(gesture({ kind: 'hover', phase: 'move', x: 20 as never, y: 50 as never }))).toBe('claim');
  });

  test('descending-priority dispatch (the §13.5 rule): the higher-priority tool wins the walk', () => {
    // Simulate the router: walk registrations by descending priority until one claims.
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    let panRan = false;
    const pan: GestureRegistration = { kinds: ['tap'], surfaces: ['pane'], priority: 0, handler: () => ((panRan = true), 'claim') };
    const table = [...stub.router.regs, pan].sort((a, b) => b.priority - a.priority);
    for (const r of table) if (r.handler(gesture({ kind: 'tap', x: 0 as never, y: 50 as never })) === 'claim') break;
    expect(panRan).toBe(false);
  });
});

describe('T2 — coordinateToLogical float + off-grid key conversion', () => {
  test('a tap at x=15 px maps to FLOAT logical 1.5 → interpolated key 1150 (no snap)', () => {
    const stub = makeChart();
    const spyLog = vi.spyOn(stub.ts, 'coordinateToLogical');
    const spyKey = vi.spyOn(stub.ts, 'logicalToKey');
    const { host } = placeTrendLine(stub, [
      { x: 15, y: 50 },
      { x: 25, y: 40 },
    ]);
    expect(spyLog).toHaveBeenCalledWith(15);
    expect(spyKey).toHaveBeenCalledWith(1.5, { extrapolate: true });
    const a = host.shapes()[0]!.anchors[0]!;
    expect(a.key).toBeCloseTo(1150);
    expect(a.price).toBeCloseTo(50);
  });
});

describe('T5 — off-grid key↔logical extrapolation (place & render past the last bar)', () => {
  test('a tap at x=60 px (logical 6, two slots past the last) gets a virtual key 1500', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 60, y: 50 },
      { x: 25, y: 40 },
    ]);
    const a = host.shapes()[0]!.anchors[0]!;
    // Two slots past index 4: 1400 + 2*100.
    expect(a.key).toBeCloseTo(1600);
  });

  test('default (no extrapolate) off-grid logicalToKey is null → the tap is rejected', () => {
    const stub = makeChart();
    stub.ts.logicalToKey = (logical: number, opts?: { extrapolate?: boolean }) =>
      logical >= 0 && logical <= 4 ? 1000 + logical * 100 : opts?.extrapolate ? 9999 : null;
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', x: 60 as never, y: 50 as never }));
    expect(host.shapes().length).toBe(0); // 1 of 2 anchors placed
  });

  test('the off-grid endpoint key ROUND-TRIPS and renders at the expected x (T5 inverse property)', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 60, y: 50 },
      { x: 25, y: 40 },
    ]);
    const k = host.shapes()[0]!.anchors[0]!.key;
    expect(k).toBeCloseTo(1600);

    const logical = stub.ts.keyToLogical(k, { extrapolate: true })!;
    expect(logical).toBeCloseTo(6);
    const kBack = stub.ts.logicalToKey(logical, { extrapolate: true })!;
    expect(stub.ts.keyToLogical(kBack, { extrapolate: true })!).toBeCloseTo(6);

    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const lists = paneSource(prim).displayLists();
    expect(lists.length).toBeGreaterThan(0);
    const x0 = firstPolylineX(lists);
    expect(x0).not.toBeNull();
    expect(x0!).toBeCloseTo(stub.ts.logicalToCoordinate(6)!);
  });
});

// PolylineCommand.points holds x,y pairs.
function firstPolylineX(lists: readonly DisplayList[]): number | null {
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string; points?: Float32Array }[]) {
      if (c.kind === 'polyline' && c.points !== undefined && c.points.length >= 2) return c.points[0]!;
    }
  }
  return null;
}

describe('T3 — ranked hit-test (Point handle beats Line body)', () => {
  test('near an endpoint a Point candidate wins; on the body a Line candidate is returned', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    host.select(host.shapes()[0]!.id);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const src = paneSource(prim);
    const atHandle = src.hitTest!(10 as never, 50 as never, FRAME) as HitCandidate;
    expect(atHandle.priority).toBe(HitPriority.Point);
    expect(atHandle.data).toBe(0);
    // (20, 40) lies on the segment.
    const onBody = src.hitTest!(20 as never, 40 as never, FRAME) as HitCandidate;
    expect(onBody.priority).toBe(HitPriority.Line);
    expect(atHandle.priority).toBeGreaterThan(onBody.priority);
  });

  test('a drag starting on a handle re-anchors that endpoint (drag-edit via the ranked hit)', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    host.select(host.shapes()[0]!.id);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    const handler = stub.router.regs[0]!.handler;
    expect(handler(gesture({ kind: 'drag', phase: 'start', x: 10 as never, y: 50 as never }))).toBe('claim');
    handler(gesture({ kind: 'drag', phase: 'move', x: 20 as never, y: 40 as never }));
    handler(gesture({ kind: 'drag', phase: 'end', x: 20 as never, y: 40 as never }));
    const a0 = host.shapes()[0]!.anchors[0]!;
    expect(a0.key).toBeCloseTo(1200);
    expect(a0.price).toBeCloseTo(60);
    expect(events.some((e) => e.kind === 'edited')).toBe(true);
  });

  test('a drag NOT on a shape passes (the default pan keeps the stream — T1 yield back)', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const handler = stub.router.regs[0]!.handler;
    expect(handler(gesture({ kind: 'drag', phase: 'start', x: 200 as never, y: 150 as never }))).toBe('pass');
  });
});

describe('T4 — the unified IPrimitive seam (pane-attach + overlay + ctx.input + auto-detach)', () => {
  test('the committed shape is pane-attached and registers ONE pane scene source', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    expect(stub.panes[0]!.attached.length).toBeGreaterThan(0);
    const prim = attachedPrimitive(stub.panes[0]!);
    const srcs = prim.sources!();
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.target).toBe('pane');
    expect((srcs[0]!.source as unknown as SceneSource).zBand).toBe(ZBand.AboveSeries);
  });

  test('attached(ctx) carries `input`; setSelected requests an OVERLAY-only update', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    const ctx = ctxFor(stub.panes[0]!, stub.chart);
    prim.attached!(ctx);
    expect(ctx.input).toBe(stub.chart.input());
    (prim as { setSelected(s: boolean): void }).setSelected(true);
    expect((ctx as unknown as { __updates: string[] }).__updates).toContain('overlay');
  });

  test('detached() clears the context (auto-detach on pane/series removal, §2.2)', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    prim.attached!(ctxFor(stub.panes[0]!, stub.chart));
    prim.detached!();
    expect(paneSource(prim).displayLists().length).toBe(0);
  });

  test('host.remove() detaches the primitive from its pane', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const id = host.shapes()[0]!.id;
    host.remove(id);
    expect(stub.panes[0]!.detached.length).toBeGreaterThan(0);
    expect(host.shapes().length).toBe(0);
  });
});

describe('T6 — pane-attached primitive axis labels render', () => {
  test('the trend line contributes one price-axis label per anchor', () => {
    const stub = makeChart();
    placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const prim = attachedPrimitive(stub.panes[0]!);
    const labels = prim.priceAxisLabels!();
    expect(labels.length).toBe(2);
    expect(labels[0]!.coordinate()).toBeCloseTo(50);
    expect(labels[1]!.coordinate()).toBeCloseTo(70);
    expect(typeof labels[0]!.text()).toBe('string');
    expect(labels[0]!.visible!()).toBe(true);
  });
});

describe('T7 — ToolHost end-to-end (arm → place → commit → serialize/deserialize)', () => {
  test('arm + two taps commits ONE shape and fires the added event', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    expect(host.shapes().length).toBe(1);
    const added = events.filter((e) => e.kind === 'added');
    expect(added.length).toBe(1);
    expect((added[0] as { id: string }).id).toBe(host.shapes()[0]!.id);
    expect(host.shapes()[0]!.type).toBe('trend-line');
  });

  test('select(id) fires a selected event; select(null) deselects; a re-select is a value no-op', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const id = host.shapes()[0]!.id;
    events.length = 0;
    host.select(id);
    host.select(id);
    host.select(null);
    const sel = events.filter((e) => e.kind === 'selected');
    expect(sel.length).toBe(2);
    expect((sel[0] as { id: string | null }).id).toBe(id);
    expect((sel[1] as { id: string | null }).id).toBe(null);
  });

  test('exportAll → importAll round-trips anchors + style as plain JSON (no live coords)', () => {
    const stub = makeChart();
    const { host } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    const dump = host.exportAll();
    expect(dump.length).toBe(1);
    const json = JSON.parse(JSON.stringify(dump)) as SerializedShape[];
    expect(json[0]!.type).toBe('trend-line');
    expect(json[0]!.anchors.length).toBe(2);
    expect(json[0]!.anchors[0]!.key).toBeCloseTo(1100);
    expect(json[0]!.anchors[0]!.paneId).toBe('p0');
    const stub2 = makeChart();
    const host2 = createToolHost(stub2.chart);
    host2.registerTool(TrendLineTool as never);
    host2.importAll(json);
    expect(host2.shapes().length).toBe(1);
    expect(host2.shapes()[0]!.anchors[0]!.key).toBeCloseTo(1100);
    expect(stub2.panes[0]!.attached.length).toBe(1);
  });

  test('importAll of an unknown tool type is skipped with a warn (round-trips opaquely)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    host.importAll([{ type: 'fib-unknown', version: 1, anchors: [], style: {} }]);
    expect(host.shapes().length).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('importAll of an unknown paneId remaps to pane 0 with a warn (§4.1)', () => {
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const anchors: Anchor[] = [
      { key: 1100, price: 50, paneId: 'p99' },
      { key: 1300, price: 70, paneId: 'p99' },
    ];
    host.importAll([{ type: 'trend-line', version: 1, anchors, style: trendLineDefaults }]);
    expect(host.shapes().length).toBe(1);
    expect(host.shapes()[0]!.anchors[0]!.paneId).toBe('p0');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test('a max>min tool keeps collecting anchors past min and commits at max (multi-anchor FSM)', () => {
    // Regression: committing at `min` made anchors past `min` unreachable.
    const stub = makeChart();
    const host = createToolHost(stub.chart);
    host.registerTool(MultiAnchorTool as never);
    const events: ToolHostEvent[] = [];
    host.subscribe((e) => events.push(e));
    host.arm('multi-anchor');
    const handler = stub.router.regs[0]!.handler;
    const tap = (x: number): GestureResponse => handler(gesture({ kind: 'tap', x: x as never, y: 50 as never }));

    tap(10);
    tap(20); // reaches min, not max: still placing
    expect(host.shapes().length).toBe(0);
    expect(events.some((e) => e.kind === 'added')).toBe(false);
    tap(30);
    expect(host.shapes().length).toBe(0);
    tap(40); // reaches max: commits
    expect(host.shapes().length).toBe(1);
    expect(host.shapes()[0]!.anchors.length).toBe(4);
    expect(events.filter((e) => e.kind === 'added').length).toBe(1);
  });

  test('applyStyle re-runs createShape semantics and fires an edited event', () => {
    const stub = makeChart();
    const { host, events } = placeTrendLine(stub, [
      { x: 10, y: 50 },
      { x: 30, y: 30 },
    ]);
    events.length = 0;
    host.shapes()[0]!.applyStyle({ color: '#FF0000' } as never);
    expect((host.shapes()[0]!.style as { color: string }).color).toBe('#FF0000');
    expect(events.some((e) => e.kind === 'edited')).toBe(true);
  });
});

describe('T8 — IPane.id() is the anchor/serialization key (chart-unique, stable)', () => {
  test('a shape placed on pane 1 serializes that pane id; distinct panes have distinct ids', () => {
    const p0 = makePane('p0', makeSeries());
    const p2 = makePane('p2', makeSeries()); // as if 'p1' had been removed
    const stub = makeChart({ panes: [p0, p2] });
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 10 as never, y: 50 as never }));
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 30 as never, y: 30 as never }));
    expect(host.shapes().length).toBe(1);
    const dump = host.exportAll();
    expect(dump[0]!.anchors[0]!.paneId).toBe('p2');
    expect(p0.id()).not.toBe(p2.id());
    expect(host.shapes()[0]!.anchors[0]!.paneId).toBe('p2');
  });

  test('id() is stable across pane SWAP + remove/re-add: anchors resolve by ID, not index', () => {
    // Mutating the live panes array simulates layout changes; import must resolve by id.
    const p0 = makePane('p0', makeSeries());
    const p2 = makePane('p2', makeSeries());
    const livePanes = [p0, p2];
    const stub = makeChart({ panes: livePanes });
    const host = createToolHost(stub.chart);
    host.registerTool(TrendLineTool as never);
    host.arm('trend-line');
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 10 as never, y: 50 as never }));
    stub.router.regs[0]!.handler(gesture({ kind: 'tap', paneIndex: 1, x: 30 as never, y: 30 as never }));
    const dump = host.exportAll();
    expect(dump[0]!.anchors[0]!.paneId).toBe('p2');

    // Swap: 'p2' moves to index 0.
    livePanes.reverse();
    expect(stub.panes[1]!.id()).toBe('p0');
    const host2 = createToolHost(stub.chart);
    host2.registerTool(TrendLineTool as never);
    host2.importAll(dump);
    expect(host2.shapes().length).toBe(1);
    expect(host2.shapes()[0]!.anchors[0]!.paneId).toBe('p2');
    expect(p2.attached.length).toBeGreaterThan(0);

    // Remove 'p2': import falls back to pane 0 with a warn.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    livePanes.length = 0;
    livePanes.push(p0);
    const host3 = createToolHost(stub.chart);
    host3.registerTool(TrendLineTool as never);
    host3.importAll(dump);
    expect(host3.shapes()[0]!.anchors[0]!.paneId).toBe('p0');
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
