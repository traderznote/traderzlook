// Regression tests for the chart join layer, driven through the public API over a recording
// backend (no browser).
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../gfx';
import { timeBehavior } from '../data';
import { ChartError } from './errors';
import { CandlestickSeries, HistogramSeries, LineSeries } from './series-defs';
import { createChartWith, createLiveNav } from './create-chart';
import { ChartModel, buildHorzGeometry } from '../model';

interface Surface {
  size: { width: number; height: number };
  base: DisplayList[];
  overlay: DisplayList[];
}

type Listener = (e: unknown) => void;
interface FakeEl {
  ownerDocument: { createElement(): FakeEl };
  style: Record<string, string>;
  listeners: Record<string, Listener[]>;
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(c: FakeEl): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  addEventListener(type: string, l: Listener): void;
  removeEventListener(type: string, l: Listener): void;
}

function setup(options: Record<string, unknown> = {}, behavior = timeBehavior()) {
  const surfaces: Surface[] = [];
  const mounts: FakeEl[] = [];
  const copy = (lists: readonly DisplayList[]): DisplayList[] =>
    lists.map((l) => ({ ...l, commands: l.commands.map((c) => ({ ...c })) }));
  const backend: IRenderBackend = {
    createSurface: () => {
      const s: Surface = { size: { width: 0, height: 0 }, base: [], overlay: [] };
      surfaces.push(s);
      return {
        setMediaSize: (m: { width: number; height: number }) => void (s.size = m),
        beginFrame: () => ({ mediaSize: s.size, bitmapSize: s.size, hr: 1, vr: 1 }),
        renderLayer: (layer: string, lists: readonly DisplayList[]) => {
          if (layer === 'base') s.base = copy(lists);
          else s.overlay = copy(lists);
        },
        endFrame: () => {},
        resolutionChanged: { subscribe: () => () => {} },
        snapshot: () => ({}),
        dispose: () => {},
      } as unknown as ISurface;
    },
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({}) as never,
    text: { measure: (t: string) => ({ width: 6 * t.length, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
  let pending: ((t: number) => void)[] = [];
  let t = 0;
  const flush = (): void => {
    for (let i = 0; i < 5 && pending.length > 0; i++) {
      const run = pending;
      pending = [];
      for (const cb of run) cb((t += 16));
    }
  };
  const makeEl = (): FakeEl => {
    const el: FakeEl = {
      ownerDocument: { createElement: () => makeEl() },
      style: {},
      listeners: {},
      appendChild: (c) => c,
      removeChild: (c) => c,
      contains: () => true,
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 500 }),
      addEventListener: (type, l) => void (el.listeners[type] ??= []).push(l),
      removeEventListener: () => {},
    };
    mounts.push(el);
    return el;
  };
  const chart = createChartWith(
    makeEl() as unknown as HTMLElement,
    backend,
    behavior,
    options as never,
    { scheduler: { schedule: (cb) => (pending.push(cb), () => {}), dispose: () => {} } },
  );
  flush();
  // Surface mounts in build order: per pane row [pane, left axis, right axis], then time axis, stubs.
  const paneMount = (): FakeEl => mounts.find((m) => (m.listeners['pointermove']?.length ?? 0) > 0)!;
  const pointer = (type: string, x: number, y: number, buttons = 0): void => {
    const e = { pointerId: 1, clientX: x, clientY: y, buttons, pointerType: 'mouse', ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
    for (const l of paneMount().listeners[type] ?? []) l(e);
  };
  const paneSurface = (): Surface =>
    surfaces.filter((s) => s.size.height > 40).sort((a, b) => b.size.width - a.size.width)[0]!;
  const rightAxis = (): Surface =>
    surfaces.filter((s) => s.size.height > 40 && s.size.width > 0).sort((a, b) => a.size.width - b.size.width)[0]!;
  const timeAxis = (): Surface =>
    surfaces.filter((s) => s.size.height > 0 && s.size.height <= 40).sort((a, b) => b.size.width - a.size.width)[0]!;
  return { chart, flush, surfaces, pointer, paneSurface, rightAxis, timeAxis };
}

const texts = (lists: readonly DisplayList[]): string[] =>
  lists.flatMap((l) =>
    l.commands.flatMap((c) => (c.kind === 'text' ? (c as { items: readonly { text: string }[] }).items.map((i) => i.text) : [])),
  );

const DAY = 86400;
const T0 = 1767225600; // 2026-01-01
const candles = (n: number, base = 100) =>
  Array.from({ length: n }, (_, i) => {
    const c = base + 10 * Math.sin(i / 5);
    return { time: T0 + i * DAY, open: c - 1, high: c + 2, low: c - 2, close: c + 1 };
  });

describe('overlays share one price scale and the shared timeline', () => {
  test('a partial-range line maps prices exactly like the candles it overlays', () => {
    const { chart, flush } = setup();
    const c = chart.addSeries(CandlestickSeries);
    const bars = candles(300);
    c.setData(bars);
    const line = chart.addSeries(LineSeries);
    line.setData(bars.slice(-60).map((b) => ({ time: b.time, value: b.close })));
    chart.timeScale().fitContent();
    flush();
    for (const p of [95, 100, 108]) expect(line.priceToCoordinate(p)).toBe(c.priceToCoordinate(p));
  });

  test('a series covering only the last bars is drawn inside the pane', () => {
    const { chart, flush, paneSurface } = setup();
    const bars = candles(300);
    chart.addSeries(CandlestickSeries).setData(bars);
    const line = chart.addSeries(LineSeries, { color: '#123456' });
    line.setData(bars.slice(-60).map((b) => ({ time: b.time, value: b.close })));
    chart.timeScale().fitContent();
    flush();
    const pane = paneSurface();
    const lineCmds = pane.base.flatMap((l) => l.commands).filter((c) => c.kind === 'polyline' && JSON.stringify(c).includes('#123456'));
    expect(lineCmds.length).toBeGreaterThan(0);
    const xs = Array.from((lineCmds[0] as unknown as { points: Float32Array }).points).filter((v, i) => i % 2 === 0 && Number.isFinite(v));
    expect(Math.max(...xs)).toBeLessThanOrEqual(pane.size.width);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(0);
  });

  test('adding an overlay does not relabel the axes', () => {
    const { chart, flush, rightAxis, timeAxis } = setup();
    const bars = candles(300);
    chart.addSeries(CandlestickSeries).setData(bars);
    chart.timeScale().fitContent();
    flush();
    const priceBefore = texts(rightAxis().base).filter((t) => !t.includes('.') || t.length < 7);
    const timeBefore = texts(timeAxis().base);
    chart.addSeries(LineSeries).setData(bars.slice(-60).map((b) => ({ time: b.time, value: b.close })));
    flush();
    expect(texts(timeAxis().base)).toEqual(timeBefore);
    for (const label of priceBefore) expect(texts(rightAxis().base)).toContain(label);
  });
});

describe('streaming updates', () => {
  test('same time replaces the forming bar, newer appends, older throws', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const bars = candles(10);
    s.setData(bars);
    const last = bars[9]!;
    s.update({ ...last, close: last.close + 1, high: last.high + 1 });
    expect(s.data()).toHaveLength(10);
    expect((s.data()[9] as { close: number }).close).toBe(last.close + 1);
    s.update({ time: last.time + DAY, open: 1, high: 2, low: 0.5, close: 1.5 });
    expect(s.data()).toHaveLength(11);
    expect(() => s.update(bars[3]!)).toThrow(ChartError);
    s.update({ ...bars[3]!, close: bars[3]!.close + 0.5 }, { historical: true });
    expect((s.data()[3] as { close: number }).close).toBe(bars[3]!.close + 0.5);
  });

  test('a new bar on one series keeps the other series aligned to its own slots', () => {
    const { chart } = setup();
    const a = chart.addSeries(LineSeries);
    const b = chart.addSeries(LineSeries);
    a.setData([T0, T0 + 2 * DAY, T0 + 4 * DAY].map((time, i) => ({ time, value: i })));
    b.setData([T0 + DAY, T0 + 3 * DAY].map((time, i) => ({ time, value: 10 + i })));
    const slot = chart.timeScale().timeToLogical((T0 + 2 * DAY) as never)!;
    expect(slot).toBe(2);
    expect((a.dataByIndex(slot) as { value: number }).value).toBe(1);
    expect((b.dataByIndex(3) as { value: number }).value).toBe(11);
  });
});

describe('coordinate and data APIs', () => {
  test('price ⇄ coordinate round-trips and data lookups return real values', () => {
    const { chart, flush } = setup();
    const s = chart.addSeries(CandlestickSeries, { priceFormat: { type: 'price', precision: 4, minMove: 0.0001 } });
    const bars = candles(50);
    s.setData(bars);
    chart.timeScale().fitContent();
    flush();
    const y = s.priceToCoordinate(101)!;
    expect(y).not.toBeNull();
    expect(s.coordinateToPrice(y)).toBeCloseTo(101, 6);
    expect(s.dataByIndex(10)).toEqual(bars[10]);
    expect(s.dataByIndex(99, 'nearest-left')).toEqual(bars[49]);
    expect(s.dataByIndex(99)).toBeNull();
    expect(s.priceFormatter().format(1.23456)).toBe('1.2346');
    const info = s.barsInLogicalRange({ from: 5, to: 20 } as never)!;
    expect(info.barsBefore).toBe(5);
    expect(info.barsAfter).toBe(29);
    const lv = s.lastValue(true);
    expect(lv.noData).toBe(false);
    expect((lv as { color: string }).color).not.toBe('');
  });
});

describe('data validation', () => {
  test('unsorted and non-finite data are rejected with ChartError codes', () => {
    const { chart } = setup();
    const s = chart.addSeries(LineSeries);
    const bad = (items: unknown[]): string => {
      try {
        s.setData(items as never);
        return 'accepted';
      } catch (e) {
        return (e as ChartError).code;
      }
    };
    expect(bad([{ time: T0 + DAY, value: 1 }, { time: T0, value: 2 }])).toBe('invalid-data-order');
    expect(bad([{ time: T0, value: Number.NaN }])).toBe('non-finite-value');
  });
});

describe('mouse events', () => {
  test('hover fires crosshairMove with the bar, a tap fires click, leaving clears', () => {
    const { chart, flush, pointer } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const bars = candles(30);
    s.setData(bars);
    chart.timeScale().fitContent();
    flush();
    const moves: { time?: unknown; point?: unknown; bar?: unknown }[] = [];
    const clicks: unknown[] = [];
    chart.subscribeCrosshairMove((p) => moves.push({ time: p.time, point: p.point, bar: p.seriesData.get(s) }));
    chart.subscribeClick((p) => clicks.push(p.time));
    pointer('pointermove', 300, 200);
    expect(moves.length).toBeGreaterThan(0);
    const m = moves.at(-1)!;
    expect(m.bar).toEqual(bars.find((b) => b.time === m.time));
    pointer('pointerdown', 300, 200, 1);
    pointer('pointerup', 300, 200, 0);
    expect(clicks).toHaveLength(1);
    const paneMountLeave = moves.length;
    pointer('pointerleave', 0, 0);
    expect(moves.length).toBeGreaterThan(paneMountLeave);
    expect(moves.at(-1)!.point).toBeUndefined();
  });
});

describe('panes', () => {
  test('a pane added after creation renders, can be sized, and series can move and reorder', () => {
    const { chart, flush, surfaces } = setup();
    const bars = candles(40);
    chart.addSeries(CandlestickSeries).setData(bars);
    const vol = chart.addSeries(HistogramSeries, { color: '#abcdef' }, 1);
    vol.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    flush();
    expect(chart.panes()).toHaveLength(2);
    const painted = surfaces.some((s) => s.base.some((l) => l.commands.some((c) => JSON.stringify(c).includes('#abcdef'))));
    expect(painted).toBe(true);
    chart.panes()[1]!.setHeight(120);
    flush();
    expect(Math.abs(chart.panes()[1]!.height() - 120)).toBeLessThan(2);
    const line = chart.addSeries(LineSeries);
    line.setData(bars.map((b) => ({ time: b.time, value: b.close })));
    expect(line.order()).toBe(1);
    line.setOrder(0);
    expect(line.order()).toBe(0);
    line.moveToPane(1);
    expect(line.pane().index()).toBe(1);
  });
});

describe('options reach the rendering', () => {
  test('series.applyOptions and the background color change what is drawn', () => {
    const { chart, flush, paneSurface } = setup({ layout: { background: { type: 'solid', color: '#fafafa' } } });
    const line = chart.addSeries(LineSeries, { color: '#111111' });
    line.setData(candles(20).map((b) => ({ time: b.time, value: b.close })));
    flush();
    const drawn = (): string => JSON.stringify(paneSurface().base);
    expect(drawn()).toContain('#fafafa');
    expect(drawn()).toContain('#111111');
    line.applyOptions({ color: '#222222' });
    flush();
    expect(drawn()).toContain('#222222');
    line.applyOptions({ visible: false });
    flush();
    expect(drawn()).not.toContain('#222222');
  });
});

describe('price scales', () => {
  test('log mode spaces decades evenly', () => {
    const { chart, flush } = setup();
    const s = chart.addSeries(LineSeries);
    s.setData(Array.from({ length: 100 }, (_, i) => ({ time: T0 + i * DAY, value: Math.pow(1.07, i) })));
    chart.priceScale('right').applyOptions({ mode: 1 });
    chart.timeScale().fitContent();
    flush();
    const d1 = s.priceToCoordinate(1)! - s.priceToCoordinate(10)!;
    const d2 = s.priceToCoordinate(10)! - s.priceToCoordinate(100)!;
    expect(d1).toBeGreaterThan(20);
    expect(d1).toBeCloseTo(d2, 1);
  });

  test('axis labels use the series precision and the axis is wide enough for them', () => {
    const { chart, flush, rightAxis } = setup();
    const s = chart.addSeries(LineSeries, { priceFormat: { type: 'price', precision: 8, minMove: 0.00000001 } });
    s.setData(Array.from({ length: 50 }, (_, i) => ({ time: T0 + i * DAY, value: 0.000012 + 0.000001 * Math.sin(i) })));
    chart.timeScale().fitContent();
    flush();
    const labels = texts(rightAxis().base);
    expect(labels.length).toBeGreaterThan(2);
    for (const l of labels) expect(l).toMatch(/^0\.0000\d{4}$/);
    const widest = Math.max(...labels.map((l) => 6 * l.length));
    expect(chart.priceScale('right').width()).toBeGreaterThanOrEqual(widest);
  });

  test('an overlay scale honors scale margins (volume at the bottom)', () => {
    const { chart, flush } = setup();
    const bars = candles(40);
    chart.addSeries(CandlestickSeries).setData(bars);
    const vol = chart.addSeries(HistogramSeries, { priceScaleId: '' });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    vol.setData(bars.map((b, i) => ({ time: b.time, value: 100 + i })));
    chart.timeScale().fitContent();
    flush();
    const h = chart.panes()[0]!.height();
    expect(vol.priceToCoordinate(139)! / h).toBeCloseTo(0.8, 2);
  });

  test('a price range can be pinned and read back', () => {
    const { chart, flush } = setup();
    chart.addSeries(LineSeries).setData(candles(20).map((b) => ({ time: b.time, value: b.close })));
    flush();
    chart.priceScale('right').setVisibleRange({ from: 50, to: 150 });
    expect(chart.priceScale('right').getVisibleRange()).toEqual({ from: 50, to: 150 });
  });
});

describe('time scale', () => {
  test('visible time range, coordinate → time and range events are live', () => {
    const { chart, flush } = setup();
    const bars = candles(30);
    chart.addSeries(CandlestickSeries).setData(bars);
    let events = 0;
    chart.timeScale().subscribeVisibleLogicalRangeChange(() => events++);
    chart.timeScale().fitContent();
    flush();
    expect(events).toBeGreaterThan(0);
    expect(chart.timeScale().getVisibleRange()).toEqual({ from: bars[0]!.time, to: bars[29]!.time });
    const x = chart.timeScale().timeToCoordinate(bars[12]!.time as never)!;
    expect(chart.timeScale().coordinateToTime(x)).toBe(bars[12]!.time);
  });

  test('wheel zoom keeps the bar under the cursor in place', () => {
    const model = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
    const nav = createLiveNav(model, () => 200, () => 600);
    nav.fit();
    const geom = () => buildHorzGeometry({ width: 600, barSpacing: nav.barSpacing(), rightOffset: nav.rightOffset(), baseIndex: 199 });
    const before = geom().coordinateToLogical(150);
    nav.zoom(1, 150);
    expect(geom().coordinateToLogical(150)).toBeCloseTo(before, 4);
  });

  test('changing the timezone offset relabels the axis without a rebuild', () => {
    let offset = 0;
    const { flush, timeAxis, chart } = setup({}, timeBehavior({ timezoneOffset: () => offset }));
    chart.addSeries(LineSeries).setData(Array.from({ length: 72 }, (_, i) => ({ time: T0 + i * 3600, value: i })));
    chart.timeScale().fitContent();
    flush();
    const before = texts(timeAxis().base);
    expect(before.length).toBeGreaterThan(0);
    offset = 5 * 3600;
    chart.applyOptions({ localization: {} });
    flush();
    const after = texts(timeAxis().base);
    expect(after.length).toBeGreaterThan(0);
    expect(after).not.toEqual(before);
  });
});

describe('crosshair', () => {
  test('setCrosshairPosition draws the lines and the axis labels', () => {
    const { chart, flush, paneSurface, rightAxis, timeAxis } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const bars = candles(30);
    s.setData(bars);
    chart.timeScale().fitContent();
    flush();
    chart.setCrosshairPosition(100, bars[10]!.time as never, s);
    flush();
    expect(paneSurface().overlay.flatMap((l) => l.commands).some((c) => c.kind === 'polyline')).toBe(true);
    expect(texts(rightAxis().overlay)).toHaveLength(1);
    expect(texts(timeAxis().overlay)).toHaveLength(1);
    chart.clearCrosshairPosition();
    flush();
    expect(texts(timeAxis().overlay)).toHaveLength(0);
  });
});

describe('autoSize', () => {
  test('the chart follows its container through a ResizeObserver', () => {
    const g = globalThis as { ResizeObserver?: unknown };
    const saved = g.ResizeObserver;
    let fire: ((entries: { contentRect: { width: number; height: number } }[]) => void) | null = null;
    g.ResizeObserver = class {
      constructor(cb: typeof fire) {
        fire = cb;
      }
      observe(): void {}
      disconnect(): void {}
    };
    try {
      const { chart, flush } = setup({ autoSize: true });
      chart.addSeries(LineSeries).setData(candles(20).map((b) => ({ time: b.time, value: b.close })));
      flush();
      const before = chart.panes()[0]!.size();
      fire!([{ contentRect: { width: 1000, height: 600 } }]);
      flush();
      const after = chart.panes()[0]!.size();
      expect(after.width).toBeGreaterThan(before.width);
      expect(after.height).toBeGreaterThan(before.height);
    } finally {
      g.ResizeObserver = saved;
    }
  });
});

describe('per-point colors', () => {
  test('a bar item color overrides the series color', () => {
    const { chart, flush, paneSurface } = setup();
    const vol = chart.addSeries(HistogramSeries, { color: '#999999' });
    vol.setData(candles(20).map((b, i) => ({ time: b.time, value: b.close, ...(i % 2 === 0 && { color: '#00aa00' }) })));
    chart.timeScale().fitContent();
    flush();
    const drawn = JSON.stringify(paneSurface().base);
    expect(drawn).toContain('#00aa00');
    expect(drawn).toContain('#999999');
  });
});

describe('free crosshair', () => {
  const polylines = (lists: readonly DisplayList[]) =>
    lists.flatMap((l) => l.commands).filter((c) => c.kind === 'polyline') as unknown as { points: Float32Array }[];

  test('the horizontal line and price tag follow the pointer, not the bar close', () => {
    const { chart, flush, pointer, paneSurface, rightAxis } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(candles(30));
    chart.timeScale().fitContent();
    flush();
    pointer('pointermove', 300, 123);
    flush();
    const ys = polylines(paneSurface().overlay).map((p) => p.points[1]!);
    expect(ys.some((y) => Math.abs(y - 123) <= 1)).toBe(true);
    const tag = texts(rightAxis().overlay)[0]!;
    expect(Number(tag)).toBeCloseTo(s.coordinateToPrice(123)!, 1);
  });

  test('the vertical line moves past the last bar and labels the future time', () => {
    const { chart, flush, pointer, paneSurface, timeAxis } = setup();
    const bars = candles(30);
    chart.addSeries(CandlestickSeries).setData(bars);
    chart.timeScale().setVisibleLogicalRange({ from: 0, to: 59 } as never);
    flush();
    let logical = -1;
    chart.subscribeCrosshairMove((p) => (logical = p.logical as number));
    const x = chart.timeScale().logicalToCoordinate(45 as never)!;
    pointer('pointermove', x, 150);
    flush();
    expect(logical).toBe(45);
    const xs = polylines(paneSurface().overlay).map((p) => p.points[0]!);
    expect(xs.some((v) => Math.abs(v - x) <= 1)).toBe(true);
    expect(texts(timeAxis().overlay)).toHaveLength(1);
  });
});

describe('charts created hidden (zero width)', () => {
  test('a range set before the chart has a width is applied once it does', () => {
    const { chart, flush } = setup({ width: 1, height: 1 });
    chart.resize(0, 0);
    chart.addSeries(LineSeries).setData(candles(300).map((b) => ({ time: b.time, value: b.close })));
    chart.timeScale().setVisibleLogicalRange({ from: 200, to: 340 } as never);
    chart.resize(800, 500);
    flush();
    const r = chart.timeScale().getVisibleLogicalRange()!;
    expect(r.from).toBeCloseTo(200, 3);
    expect(r.to).toBeCloseTo(340, 3);
  });
});
