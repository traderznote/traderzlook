import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../../gfx';
import { CandlestickSeries, createChartWith, timeBehavior } from '../../api';
import type { IChart, IFrameScheduler, ITimeScale, MouseEventParams, Time } from '../../api';
import { createSyncGroup, type SyncGroupOptions } from './sync-group';

// Stub chart modelling the public contracts SyncGroup relies on:
//  - setVisibleLogicalRange fires a change event only when the value actually changes;
//  - key = base + logical * spacing (extrapolated outside 0..4); an `empty` chart maps nothing;
//  - setCrosshairPosition calls are recorded.
interface CrosshairCall {
  price: number | null;
  key: number;
  series: unknown;
}

function makeStubChart(cfg?: {
  base?: number;
  spacing?: number;
  empty?: boolean;
  panePrice?: (y: number) => number | null;
  noSeries?: boolean;
  echoCrosshair?: boolean; // re-fire a crosshair move on every programmatic setCrosshairPosition
}) {
  const base = cfg?.base ?? 1000;
  const spacing = cfg?.spacing ?? 100;
  const empty = cfg?.empty ?? false;

  let range: { from: number; to: number } | null = { from: 0, to: 4 };
  const rangeListeners = new Set<(r: { from: number; to: number } | null) => void>();
  const crosshairListeners = new Set<(p: MouseEventParams<Time>) => void>();
  const crosshairCalls: CrosshairCall[] = [];
  let rangeSets = 0; // includes value no-ops
  let rangeFires = 0;
  let crosshairFires = 0;

  const seriesHandle = cfg?.noSeries
    ? null
    : { coordinateToPrice: (y: number): number | null => (cfg?.panePrice ?? ((yy) => 100 - yy))(y) };

  const ts: ITimeScale<Time> = {
    getVisibleLogicalRange: () => (empty ? null : range === null ? null : { ...range }),
    setVisibleLogicalRange: (r: { from: number; to: number }) => {
      rangeSets++;
      if (empty) return;
      if (range !== null && range.from === r.from && range.to === r.to) return;
      range = { from: r.from, to: r.to };
      rangeFires++;
      for (const h of [...rangeListeners]) h({ ...range });
    },
    subscribeVisibleLogicalRangeChange: (h) => {
      rangeListeners.add(h);
      return () => void rangeListeners.delete(h);
    },
    logicalToKey: (logical: number, opts?: { extrapolate?: boolean }) => {
      if (empty) return null;
      if (logical < 0 || logical > 4) return opts?.extrapolate ? base + logical * spacing : null;
      return base + logical * spacing;
    },
    keyToLogical: (key: number, opts?: { extrapolate?: boolean }) => {
      if (empty) return null;
      const logical = (key - base) / spacing;
      if (logical < 0 || logical > 4) return opts?.extrapolate ? logical : null;
      return logical;
    },
  } as unknown as ITimeScale<Time>;

  const keyToLogicalLocal = (key: number): number => (key - base) / spacing;

  const fireCrosshair = (p: MouseEventParams<Time>): void => {
    crosshairFires++;
    for (const h of [...crosshairListeners]) h(p);
  };

  const chart = {
    timeScale: () => ts,
    panes: () => [{ series: () => (seriesHandle === null ? [] : [seriesHandle]) }],
    subscribeCrosshairMove: (h: (p: MouseEventParams<Time>) => void) => {
      crosshairListeners.add(h);
      return () => void crosshairListeners.delete(h);
    },
    setCrosshairPosition: (price: number | null, horzItem: Time, series?: unknown) => {
      crosshairCalls.push({ price, key: horzItem as unknown as number, series: series ?? null });
      if (cfg?.echoCrosshair) fireCrosshair({ logical: keyToLogicalLocal(horzItem as unknown as number) } as MouseEventParams<Time>);
    },
  } as unknown as IChart<Time>;

  return {
    chart,
    ts,
    // A user pan/zoom: set, and fire if changed.
    setRange: (r: { from: number; to: number } | null) => {
      if (r === null) {
        for (const h of [...rangeListeners]) h(null);
        return;
      }
      if (range !== null && range.from === r.from && range.to === r.to) return;
      range = { ...r };
      rangeFires++;
      for (const h of [...rangeListeners]) h({ ...range });
    },
    // A user crosshair move.
    emitCrosshair: (p: Partial<MouseEventParams<Time>>) => {
      fireCrosshair(p as MouseEventParams<Time>);
    },
    getRange: () => range,
    crosshairCalls,
    stats: () => ({ rangeSets, rangeFires, crosshairFires }),
  };
}

describe("L5 — range sync 'logical' (raw logical range mirrored to peers)", () => {
  test('a pan on A pushes the SAME logical range onto B and C', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const c = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical' });

    a.setRange({ from: 1, to: 5 });
    expect(b.getRange()).toEqual({ from: 1, to: 5 });
    expect(c.getRange()).toEqual({ from: 1, to: 5 });
    group.dispose();
  });

  test('the source is NOT re-set by its own broadcast (no self-forward)', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });
    const before = a.stats().rangeSets;
    a.setRange({ from: 2, to: 6 });
    expect(a.stats().rangeSets).toBe(before);
    expect(b.getRange()).toEqual({ from: 2, to: 6 });
    group.dispose();
  });
});

describe('L3 — echo-free ping-pong converges in one hop (no source field)', () => {
  test('a pan on A settles B once and does NOT bounce back to re-fire A', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });

    const aFiresBefore = a.stats().rangeFires;
    a.setRange({ from: 1, to: 5 });
    expect(b.getRange()).toEqual({ from: 1, to: 5 });
    expect(b.stats().rangeFires).toBe(1);
    // B's broadcast set A to its current value, a no-op, so A fired only the user pan.
    expect(a.stats().rangeFires).toBe(aFiresBefore + 1);
    group.dispose();
  });

  test('three charts all converge to the source range with no runaway', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const c = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical' });
    a.setRange({ from: 0, to: 3 });
    expect(b.getRange()).toEqual({ from: 0, to: 3 });
    expect(c.getRange()).toEqual({ from: 0, to: 3 });
    expect(a.stats().rangeFires).toBe(1);
    expect(b.stats().rangeFires).toBe(1);
    expect(c.stats().rangeFires).toBe(1);
    group.dispose();
  });
});

// Both charts echo every programmatic crosshair set back out as a move event; without the
// guard A→B would bounce forever.
describe('L3 — crosshair ping-pong converges echo-free in one hop (design 05 §6.2)', () => {
  test('a crosshair move on A sets B once and does NOT bounce back to re-fire A', () => {
    const a = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const b = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });

    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });

    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200);
    expect(a.crosshairCalls.length).toBe(0);
    expect(a.stats().crosshairFires).toBe(1);
    expect(b.stats().crosshairFires).toBe(1);
    group.dispose();
  });

  test('symmetric: a move on B settles A once with no runaway (guard works both ways)', () => {
    const a = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const b = makeStubChart({ base: 1000, spacing: 100, echoCrosshair: true });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });
    b.emitCrosshair({ logical: 3 as never, point: { x: 30 as never, y: 50 as never } });
    expect(a.crosshairCalls.length).toBe(1);
    expect(a.crosshairCalls[0]!.key).toBeCloseTo(1300);
    expect(b.crosshairCalls.length).toBe(0);
    expect(b.stats().crosshairFires).toBe(1);
    group.dispose();
  });
});

describe('guard is per-channel: range + crosshair fan-outs do not suppress each other', () => {
  test('a crosshair fired DURING a range fan-out still forwards (not swallowed)', () => {
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const c = makeStubChart({ base: 1000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart, c.chart], { range: 'logical', crosshair: 'time' });

    // Setting B's range fires a crosshair move from inside the range fan-out; a single
    // shared guard would swallow it.
    const realSet = b.ts.setVisibleLogicalRange.bind(b.ts);
    let coupled = false;
    b.ts.setVisibleLogicalRange = (r: { from: number; to: number }) => {
      realSet(r);
      if (!coupled) {
        coupled = true;
        b.emitCrosshair({ logical: 1 as never, point: { x: 10 as never, y: 50 as never } });
      }
    };

    a.setRange({ from: 1, to: 3 });

    expect(b.getRange()).toEqual({ from: 1, to: 3 });
    expect(a.crosshairCalls.length + c.crosshairCalls.length).toBeGreaterThan(0);
    expect(c.crosshairCalls.some((x) => Math.abs(x.key - 1100) < 1e-6)).toBe(true); // logical 1 → key 1100
    group.dispose();
  });
});

describe("L5 — range sync 'time' (HorzKey endpoint mapping across different datasets)", () => {
  test('A (base 1000) and B (base 2000) align by KEY, not by raw logical', () => {
    // A [1,3] → keys [1100, 1300] → B logical [-9, -7].
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 2000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'time' });
    a.setRange({ from: 1, to: 3 });
    const r = b.getRange()!;
    expect(r.from).toBeCloseTo(-9);
    expect(r.to).toBeCloseTo(-7);
    group.dispose();
  });

  test('a target with an EMPTY timeline is skipped (no key to map)', () => {
    const a = makeStubChart({ base: 1000 });
    const empty = makeStubChart({ empty: true });
    const group = createSyncGroup([a.chart, empty.chart], { range: 'time' });
    a.setRange({ from: 1, to: 3 });
    expect(empty.ts.getVisibleLogicalRange()).toBeNull();
    expect(empty.stats().rangeSets).toBe(0);
    group.dispose();
  });

  test("range: 'off' wires no range sync (B never moves)", () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'off' });
    a.setRange({ from: 1, to: 5 });
    expect(b.getRange()).toEqual({ from: 0, to: 4 });
    group.dispose();
  });
});

describe("L5 — crosshair sync 'time' (time-line-only, addressed by key not pixel)", () => {
  test('a crosshair move on A places a time-line (price null) on B at the mapped key', () => {
    const a = makeStubChart({ base: 1000, spacing: 100 });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200); // by key, not pixel x=20
    expect(b.crosshairCalls[0]!.series).toBeNull();
    group.dispose();
  });

  test('a crosshair with no logical (off-scale/leave) forwards nothing', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { crosshair: 'time', range: 'off' });
    a.emitCrosshair({ point: { x: 5 as never, y: 5 as never } });
    expect(b.crosshairCalls.length).toBe(0);
    group.dispose();
  });

  test("crosshair: 'off' wires no crosshair sync", () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { crosshair: 'off', range: 'off' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 50 as never } });
    expect(b.crosshairCalls.length).toBe(0);
    group.dispose();
  });
});

describe("L5 — crosshair sync 'time-price' (source price derivation + no-series fallback)", () => {
  test('the source price (coordinateToPrice on point.y) is placed on B at the mapped key', () => {
    // y = 40 → price 60.
    const a = makeStubChart({ base: 1000, spacing: 100, panePrice: (y) => 100 - y });
    const b = makeStubChart({ base: 1000, spacing: 100 });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeCloseTo(60);
    expect(b.crosshairCalls[0]!.key).toBeCloseTo(1200);
    expect(b.crosshairCalls[0]!.series).not.toBeNull();
    group.dispose();
  });

  test('a target with NO pane-0 series falls back to the time-line-only form (SyncGroup-selected)', () => {
    const a = makeStubChart({ panePrice: (y) => 100 - y });
    const b = makeStubChart({ noSeries: true });
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    expect(b.crosshairCalls[0]!.series).toBeNull();
    group.dispose();
  });

  test('a move with NO point (leave/programmatic) falls back to the time-line-only form', () => {
    const a = makeStubChart({ panePrice: (y) => 100 - y });
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    group.dispose();
  });

  test('a source with NO pane-0 series (no derivable price) falls back to the time-line-only form', () => {
    const a = makeStubChart({ noSeries: true });
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    group.dispose();
  });

  test('an off-scale source price (coordinateToPrice null) falls back to the time-line-only form', () => {
    const a = makeStubChart({ panePrice: () => null });
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'off', crosshair: 'time-price' });
    a.emitCrosshair({ logical: 2 as never, point: { x: 20 as never, y: 40 as never } });
    expect(b.crosshairCalls.length).toBe(1);
    expect(b.crosshairCalls[0]!.price).toBeNull();
    group.dispose();
  });
});

describe('L1 — logical-range value objects are independent (no shared mutable state)', () => {
  test('the range forwarded to B is a distinct object from A`s live range', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical' });
    a.setRange({ from: 1, to: 5 });
    const ar = a.getRange()!;
    const br = b.getRange()!;
    expect(br).toEqual(ar);
    expect(br).not.toBe(ar);
    group.dispose();
  });
});

describe('SyncGroup.dispose — idempotent teardown drops all subscriptions', () => {
  test('after dispose a pan on A does not move B', () => {
    const a = makeStubChart();
    const b = makeStubChart();
    const group = createSyncGroup([a.chart, b.chart], { range: 'logical', crosshair: 'time' });
    group.dispose();
    group.dispose();
    a.setRange({ from: 1, to: 5 });
    a.emitCrosshair({ logical: 2 as never, point: { x: 1 as never, y: 1 as never } });
    expect(b.getRange()).toEqual({ from: 0, to: 4 });
    expect(b.crosshairCalls.length).toBe(0);
  });
});

// Integration: two real charts sharing one scheduler paint in a single flush.
function makeBackend(log: string[]): IRenderBackend {
  let seq = 0;
  const makeSurface = (): ISurface => {
    const name = `surf${seq++}`;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize: (s) => void (media = s),
      beginFrame: (scope) => {
        log.push(`${name}.beginFrame ${scope}`);
        return { mediaSize: media, bitmapSize: media, hr: 1, vr: 1 };
      },
      renderLayer: (layer, lists: readonly DisplayList[]) => {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push(`${name}.renderLayer ${layer} cmds=${cmds}`);
      },
      endFrame: () => log.push(`${name}.endFrame`),
      resolutionChanged: { subscribe: () => () => {} },
      snapshot: () => ({ _tag: 'SurfaceSnapshot' }),
      dispose: () => log.push(`${name}.dispose`),
    } as unknown as ISurface;
  };
  return {
    createSurface: () => makeSurface(),
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({ _tag: 'Snapshot' }) as never,
    text: { measure: () => ({ width: 6, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
}

// Queues every armed callback; one flush runs all of them.
function makeSharedRaf(): IFrameScheduler & { flush(t?: number): void; pendingCount(): number } {
  let pending: ((n: number) => void)[] = [];
  let n = 0;
  return {
    schedule: (cb) => {
      pending.push(cb);
      return () => {
        pending = pending.filter((p) => p !== cb);
      };
    },
    dispose: () => void (pending = []),
    pendingCount: () => pending.length,
    flush: (t) => {
      const run = pending;
      pending = [];
      for (const cb of run) cb(t ?? n++);
    },
  };
}

interface FakeEl {
  ownerDocument: { createElement(): FakeEl };
  style: Record<string, string>;
  children: FakeEl[];
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(c: FakeEl): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
function makeDoc(): { createElement(): FakeEl } {
  const doc = { createElement: (): FakeEl => makeEl(doc) };
  return doc;
}
function makeEl(doc: { createElement(): FakeEl }): FakeEl {
  const children: FakeEl[] = [];
  return {
    ownerDocument: doc,
    style: {},
    children,
    appendChild: (c) => (children.push(c), c),
    removeChild: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    contains: (c) => children.includes(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  };
}

const CANDLES = [
  { time: '2026-01-05' as unknown as Time, open: 10, high: 14, low: 9, close: 13 },
  { time: '2026-01-06' as unknown as Time, open: 13, high: 17, low: 10, close: 11 },
  { time: '2026-01-07' as unknown as Time, open: 11, high: 12, low: 8, close: 9 },
  { time: '2026-01-08' as unknown as Time, open: 9, high: 15, low: 9, close: 14 },
  { time: '2026-01-09' as unknown as Time, open: 14, high: 16, low: 13, close: 15 },
];

function makeRealChart(raf: IFrameScheduler, log: string[]): IChart<Time> {
  const doc = makeDoc();
  const container = makeEl(doc);
  return createChartWith(
    container as unknown as HTMLElement,
    makeBackend(log),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  ) as unknown as IChart<Time>;
}

describe('L2 — two grouped charts sharing one IFrameScheduler paint in one tick', () => {
  test('both charts arm on the ONE shared scheduler and a SINGLE flush paints both', () => {
    const raf = makeSharedRaf();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = makeRealChart(raf, logA);
    const b = makeRealChart(raf, logB);
    raf.flush(0);

    const group = createSyncGroup([a, b], { range: 'logical', crosshair: 'time' });

    const sa = a.addSeries(CandlestickSeries);
    const sb = b.addSeries(CandlestickSeries);
    logA.length = 0;
    logB.length = 0;
    sa.setData(CANDLES);
    sb.setData(CANDLES);
    expect(raf.pendingCount()).toBeGreaterThanOrEqual(1);

    raf.flush(1);
    expect(logA.some((l) => l.includes('.beginFrame'))).toBe(true);
    expect(logB.some((l) => l.includes('.beginFrame'))).toBe(true);
    expect(raf.pendingCount()).toBe(0);

    group.dispose();
    a.dispose();
    b.dispose();
  });

  test('the shared scheduler is the SAME object both charts scheduled onto (one tick, not two)', () => {
    const raf = makeSharedRaf();
    const logA: string[] = [];
    const logB: string[] = [];
    const a = makeRealChart(raf, logA);
    const b = makeRealChart(raf, logB);
    raf.flush(0);
    const group = createSyncGroup([a, b], { range: 'logical', crosshair: 'off' });

    a.addSeries(CandlestickSeries).setData(CANDLES);
    b.addSeries(CandlestickSeries).setData(CANDLES);
    logA.length = 0;
    logB.length = 0;
    const ticks = drainTicks(raf);
    expect(ticks).toBe(1);
    expect(logA.some((l) => l.includes('.endFrame'))).toBe(true);
    expect(logB.some((l) => l.includes('.endFrame'))).toBe(true);

    group.dispose();
    a.dispose();
    b.dispose();
  });
});

// Flush until nothing re-arms; returns the number of flushes.
function drainTicks(raf: { flush(t?: number): void; pendingCount(): number }): number {
  let ticks = 0;
  while (raf.pendingCount() > 0 && ticks < 10) {
    raf.flush();
    ticks++;
  }
  return ticks;
}

const _modes: SyncGroupOptions[] = [
  { range: 'logical', crosshair: 'time' },
  { range: 'time', crosshair: 'time-price' },
  { range: 'off', crosshair: 'off' },
];
void _modes;
