// End-to-end through createChartWith over a recording stub backend, a fake container +
// ownerDocument (only the DOM methods the join calls) and a fake rAF scheduler.
import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface, Size, SnapshotTile } from '../gfx';
import { timeBehavior } from '../data';
import type { IFrameScheduler } from '../host';
import { ChartError } from './errors';
import { CandlestickSeries, LineSeries } from './series-defs';
import { createChartWith, createLiveNav } from './create-chart';
import { ChartModel, buildHorzGeometry } from '../model';

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

function makeRaf(): IFrameScheduler & { flush(t?: number): void; hasPending(): boolean } {
  let pending: ((n: number) => void) | null = null;
  let n = 0;
  return {
    schedule: (cb) => {
      pending = cb;
      return () => {
        if (pending === cb) pending = null;
      };
    },
    dispose: () => void (pending = null),
    hasPending: () => pending !== null,
    flush: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? n++);
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
  const doc = {
    createElement(): FakeEl {
      return makeEl(doc);
    },
  };
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

function setup() {
  const log: string[] = [];
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeEl(doc);
  const chart = createChartWith(
    container as unknown as HTMLElement,
    makeBackend(log),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  );
  raf.flush(0); // drain the frame armed after the initial synchronous setSize() flush
  return { log, raf, doc, container, chart };
}

const CANDLES = [
  { time: '2026-01-05', open: 10, high: 14, low: 9, close: 13 },
  { time: '2026-01-06', open: 13, high: 17, low: 10, close: 11 },
  { time: '2026-01-07', open: 11, high: 12, low: 8, close: 9 },
];

describe('createChartWith — the join point (design 02 §3.1)', () => {
  test('a string container missing in the document throws container-not-found (§3.1/§16)', () => {
    expect(() => createChartWith('no-such-id', makeBackend([]), timeBehavior())).toThrow(ChartError);
    try {
      createChartWith('no-such-id', makeBackend([]), timeBehavior());
    } catch (e) {
      expect((e as ChartError).code).toBe('container-not-found');
    }
  });

  test('construction mounts the generated div and paints the backend (§7)', () => {
    const { log, container, chart } = setup();
    expect(chart.element()).toBe(container.children[0]);
    expect(log.length).toBeGreaterThan(0); // the initial synchronous flush painted
  });

  test('addSeries + setData drive a well-formed §6 backend stream', () => {
    const { log, raf, chart } = setup();
    const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a' });
    expect(candles.seriesType()).toBe('candlestick');
    const before = log.length;
    candles.setData(CANDLES);
    raf.flush(16);
    const calls = log.slice(before);
    expect(calls.some((l) => l.includes('.beginFrame full'))).toBe(true);
    expect(calls.some((l) => l.includes('.renderLayer base'))).toBe(true);
    expect(calls.some((l) => l.includes('.renderLayer base') && !l.endsWith('cmds=0'))).toBe(true);
    // Every beginFrame is balanced by an endFrame.
    const begins = calls.filter((l) => l.includes('.beginFrame')).length;
    const ends = calls.filter((l) => l.includes('.endFrame')).length;
    expect(begins).toBe(ends);
  });

  test('handle identity law (§2): panes / time-scale / series are cached', () => {
    const { chart } = setup();
    expect(chart.panes()[0]).toBe(chart.panes()[0]);
    expect(chart.timeScale()).toBe(chart.timeScale());
    const s = chart.addSeries(LineSeries);
    expect(chart.panes()[0]).toBe(chart.panes()[0]); // still cached after a structural add
    expect(s.seriesType()).toBe('line');
  });

  test('subscribeCrosshairMove ← setCrosshairPosition delivers a §14.2 payload', () => {
    const { chart } = setup();
    const candles = chart.addSeries(CandlestickSeries);
    candles.setData(CANDLES);
    let received: { paneIndex?: number; seriesData: Map<unknown, unknown>; time?: unknown } | null = null;
    const off = chart.subscribeCrosshairMove((p) => (received = p));
    chart.setCrosshairPosition(9, '2026-01-07' as never, candles);
    expect(received).not.toBeNull();
    const got = received!;
    expect(typeof got.paneIndex).toBe('number');
    expect(got.seriesData instanceof Map).toBe(true);
    expect(got.seriesData.get(candles)).toBeDefined(); // keyed by the user handle
    off();
    received = null;
    chart.setCrosshairPosition(9, '2026-01-07' as never, candles);
    expect(received).toBeNull();
  });

  test('dispose() is idempotent, frees surfaces, and guards later calls (§16.5)', () => {
    const { log, container, chart } = setup();
    const div = chart.element();
    chart.dispose();
    expect(log.some((l) => l.endsWith('.dispose'))).toBe(true);
    expect(container.contains(div as unknown as FakeEl)).toBe(false);
    expect(() => chart.dispose()).not.toThrow();
    expect(() => chart.addSeries(CandlestickSeries)).toThrow(ChartError);
    try {
      chart.timeScale();
    } catch (e) {
      expect((e as ChartError).code).toBe('disposed');
    }
  });
});

describe('createChartWith — §2/§10/§11.1 wiring regressions', () => {
  test('series.priceScale() returns the SAME cached handle each call, not a fresh literal (§2)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    expect(s.priceScale()).toBe(s.priceScale());
  });

  test('series.pane() === series.pane() === chart.panes()[0] (one cached pane handle, §2)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    expect(s.pane()).toBe(s.pane());
    expect(s.pane()).toBe(chart.panes()[0]);
  });

  test('pane.priceScale(id) is cached and consistent with series.priceScale() (§2/§10)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const pane = chart.panes()[0]!;
    const a = pane.priceScale('right');
    expect(pane.priceScale('right')).toBe(a);
    if (a !== null) expect(a).toBe(s.priceScale()); // shared resolver with the series' own scale
  });

  test('removeSeries unregisters the scene source so the series stops painting (§4.4.2)', () => {
    const { chart, log, raf } = setup();
    const base = (): string[] => log.filter((l) => l.includes('renderLayer base'));
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    expect(base().some((l) => !l.endsWith('cmds=1'))).toBe(true);
    log.length = 0;
    chart.removeSeries(s);
    raf.flush(32);
    // Only each surface's background is left.
    expect(base().length).toBeGreaterThan(0);
    expect(base().every((l) => l.endsWith('cmds=1'))).toBe(true);
  });

  test('createPriceLine returns a live handle (NOT a false disposed error); removePriceLine kills it (§11.1)', () => {
    const { chart } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const line = s.createPriceLine({ price: 12 } as never);
    expect(() => line.options()).not.toThrow();
    line.applyOptions({ price: 13 } as never);
    s.removePriceLine(line);
    expect(() => line.applyOptions({ price: 1 } as never)).toThrow();
  });
});

describe('createChartWith — time-scale conversions are LIVE after setData (FIX 6)', () => {
  // UTC-midnight seconds for a yyyy-mm-dd day (the behavior key for CANDLES).
  const keyOf = (iso: string): number => {
    const d = new Date(iso);
    return Math.round(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
  };

  test('coordinateToLogical / logicalToCoordinate return real numbers (not null) after setData', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    const ts = chart.timeScale();
    expect(ts.coordinateToLogical(100)).toBeNull(); // empty scale before data
    s.setData(CANDLES);
    raf.flush(16);
    const lg = ts.coordinateToLogical(300);
    expect(lg).not.toBeNull();
    expect(Number.isFinite(lg as number)).toBe(true);
    const x = ts.logicalToCoordinate(0);
    expect(x).not.toBeNull();
    expect(Number.isFinite(x as number)).toBe(true);
    // Round-trip: the two conversions are continuous inverses.
    const back = ts.coordinateToLogical(x as number);
    expect(back as number).toBeCloseTo(0, 6);
  });

  test('keyToLogical / logicalToKey / keysInRange return real values over the live timeline', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const ts = chart.timeScale();
    const k0 = keyOf('2026-01-05');
    const k2 = keyOf('2026-01-07');
    expect(ts.keyToLogical(k0)).toBe(0);
    expect(ts.keyToLogical(k2)).toBe(2);
    expect(ts.logicalToKey(0)).toBe(k0 as never);
    expect(ts.logicalToKey(2)).toBe(k2 as never);
    const keys = ts.keysInRange({ from: 0, to: 2 });
    expect(keys.length).toBe(3);
    expect(keys[0]).toBe(k0 as never);
    expect(keys[2]).toBe(k2 as never);
  });

  test('timeToCoordinate / timeToLogical / snapToBar resolve through behavior.key → timeline → geometry', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const ts = chart.timeScale();
    expect(ts.timeToLogical('2026-01-06' as never)).toBe(1);
    const c = ts.timeToCoordinate('2026-01-06' as never);
    expect(c).not.toBeNull();
    expect(Number.isFinite(c as number)).toBe(true);
    expect(ts.snapToBar(1.4)).toBe(2); // nearest-slot 'right' of the interpolated key
    expect(ts.getVisibleLogicalRange()).not.toBeNull();
  });
});

describe('createChartWith — M11 parity wiring (price-line render + screenshot toggle)', () => {
  test('createPriceLine registers a SceneSource that PAINTS a horizontal line above the series (M9 deferral closed)', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES); // sets the per-frame converter so the line maps price → y
    raf.flush(16);
    const baseBefore = log
      .filter((l) => l.includes('renderLayer base'))
      .map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0));
    const maxBefore = Math.max(0, ...baseBefore);
    log.length = 0;
    // 12 is inside the candle range [9,17], so the line is on-pane and draws.
    s.createPriceLine({ price: 12, color: '#ff0000' } as never);
    raf.flush(32);
    const baseAfter = log
      .filter((l) => l.includes('renderLayer base'))
      .map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0));
    const maxAfter = Math.max(0, ...baseAfter);
    expect(maxAfter).toBeGreaterThan(maxBefore);
  });

  test('removePriceLine unregisters the line source so the line stops painting (§11.1)', () => {
    const { chart, log, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const line = s.createPriceLine({ price: 12, color: '#ff0000' } as never);
    raf.flush(32);
    const withLine = Math.max(
      0,
      ...log.filter((l) => l.includes('renderLayer base')).map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0)),
    );
    log.length = 0;
    s.removePriceLine(line);
    raf.flush(48);
    const without = Math.max(
      0,
      ...log.filter((l) => l.includes('renderLayer base')).map((l) => Number(l.match(/cmds=(\d+)/)?.[1] ?? 0)),
    );
    expect(without).toBeLessThan(withLine);
  });

  test('removeSeries also unregisters its price-line sources (no leak)', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    s.createPriceLine({ price: 12 } as never);
    raf.flush(16);
    expect(() => chart.removeSeries(s)).not.toThrow();
    raf.flush(32);
  });

  test('takeScreenshot forwards includeCrosshair to the backend compositor (§8.6)', () => {
    const composeCalls: boolean[] = [];
    const raf = makeRaf();
    const doc = makeDoc();
    const container = makeEl(doc);
    const backend: IRenderBackend = {
      createSurface: () => makeBackend([]).createSurface(),
      createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
      composeSnapshot: ((_tiles: readonly SnapshotTile[], _size: Size, includeCrosshair?: boolean) => {
        composeCalls.push(includeCrosshair ?? true);
        return { _tag: 'Snapshot' } as never;
      }) as never,
      text: { measure: () => ({ width: 6, ascent: 8, descent: 2 }) } as never,
      dispose: () => {},
    };
    const chart = createChartWith(
      container as unknown as HTMLElement,
      backend,
      timeBehavior(),
      { layout: { textColor: '#191919' } },
      { scheduler: raf },
    );
    raf.flush(0);
    chart.takeScreenshot();
    chart.takeScreenshot({ includeCrosshair: false });
    chart.takeScreenshot({ includeCrosshair: true });
    expect(composeCalls).toEqual([true, false, true]);
  });
});

describe('createLiveNav — pan/zoom/reset drive the live geometry (model-navigator math)', () => {
  // A bare model is enough: createLiveNav reads only model.options().timeScale.
  const makeNav = (n: number, width = 540) => {
    const model = new ChartModel({ behavior: timeBehavior(), invalidate: () => {} });
    return createLiveNav(model, () => n, () => width);
  };
  const geomOf = (nav: ReturnType<typeof makeNav>, n: number, width = 540) =>
    buildHorzGeometry({ width, barSpacing: nav.barSpacing(), rightOffset: nav.rightOffset(), baseIndex: n - 1 });

  test('pan changes rightOffset and shifts indexToCoordinate by the pan distance', () => {
    const n = 20;
    const nav = makeNav(n);
    const before = nav.rightOffset();
    const xBefore = geomOf(nav, n).indexToCoordinate(n - 1);
    nav.pan(30); // drag content right by 30 media px
    const after = nav.rightOffset();
    // ΔR = −dx/S: dragging right reduces the right offset.
    expect(after).toBeLessThan(before);
    const xAfter = geomOf(nav, n).indexToCoordinate(n - 1);
    expect(xAfter - xBefore).toBeCloseTo(30, 5);
  });

  test('pan is clamped by the navigator right-offset bound (cannot scroll past the extreme)', () => {
    const n = 20;
    const nav = makeNav(n);
    for (let i = 0; i < 1000; i++) nav.pan(100);
    const r = nav.rightOffset();
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeGreaterThan(-(n + 10));
  });

  test('zoom in increases barSpacing; zoom out decreases it (clamped both ways)', () => {
    const nav = makeNav(20);
    const s0 = nav.barSpacing();
    nav.zoom(1, 200);
    const sIn = nav.barSpacing();
    expect(sIn).toBeGreaterThan(s0);
    nav.zoom(-1, 200);
    nav.zoom(-1, 200);
    expect(nav.barSpacing()).toBeLessThan(sIn);
    for (let i = 0; i < 200; i++) nav.zoom(-1, 200);
    expect(nav.barSpacing()).toBeGreaterThanOrEqual(0.5); // minBarSpacing floor
  });

  test('fit sets barSpacing to W/N and rightOffset to 0 (fitContentWithPixels, px=0)', () => {
    const n = 18;
    const width = 540;
    const nav = makeNav(n, width);
    nav.zoom(1, 100); // perturb away from the fitted spacing first
    nav.pan(40);
    nav.fit();
    expect(nav.barSpacing()).toBeCloseTo(width / n, 6);
    expect(nav.rightOffset()).toBeCloseTo(0, 6);
  });

  test('setVisibleRange pins the right edge to `to` and shows ~the requested span (range presets)', () => {
    const n = 300;
    const width = 860;
    const nav = makeNav(n, width);
    nav.fit();
    const fullSpan = (() => { const v = geomOf(nav, n, width).visibleLogicalRange()!; return (v.to as number) - (v.from as number); })();
    nav.setVisibleRange(n - 24, n - 1); // e.g. a "1D" preset over 1h bars
    const v = geomOf(nav, n, width).visibleLogicalRange()!;
    expect(v.to as number).toBeCloseTo(n - 1, 0);
    const span = (v.to as number) - (v.from as number);
    expect(span).toBeGreaterThan(20); // ~24 bars (±1 from the geometry's inclusive edges)
    expect(span).toBeLessThan(28);
    expect(span).toBeLessThan(fullSpan);
  });

  test('reset restores the option-default spacing/offset then re-fits (double-click §10)', () => {
    const n = 18;
    const width = 540;
    const nav = makeNav(n, width);
    nav.zoom(1, 100);
    nav.zoom(1, 100);
    nav.pan(120);
    const movedS = nav.barSpacing();
    nav.reset();
    expect(nav.barSpacing()).not.toBe(movedS);
    expect(nav.barSpacing()).toBeCloseTo(width / n, 6);
    expect(nav.rightOffset()).toBeCloseTo(0, 6);
  });

  test('an empty timeline (N=0) is inert: pan/zoom/fit do not throw or produce NaN', () => {
    const nav = makeNav(0);
    expect(() => {
      nav.pan(50);
      nav.zoom(1, 100);
      nav.fit();
      nav.reset();
    }).not.toThrow();
    expect(Number.isFinite(nav.barSpacing())).toBe(true);
    expect(Number.isFinite(nav.rightOffset())).toBe(true);
  });
});

describe('createChartWith — timeScale().fitContent() drives the live geometry (Part B)', () => {
  test('fitContent() widens the live barSpacing to fit all bars and zeroes the right offset', () => {
    const { chart, raf } = setup();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const ts = chart.timeScale();
    const before = ts.barSpacing(); // the 6px option default
    ts.fitContent();
    raf.flush(32);
    // 3 bars across the ~540px pane → W/N ≈ 180px.
    expect(ts.barSpacing()).toBeGreaterThan(before);
    expect(ts.scrollPosition()).toBeCloseTo(0, 6);
    const x = ts.logicalToCoordinate(2);
    expect(x).not.toBeNull();
    expect(Number.isFinite(x as number)).toBe(true);
  });
});

// Records per surface its media size and the command kinds each layer rendered, so tests
// can find the right axis (narrowest), the time axis (28px tall) and the pane.
interface SurfaceRec {
  readonly name: string;
  size: { width: number; height: number };
  baseKinds: string[];
  overlayKinds: string[];
  baseLists: readonly DisplayList[];
}
function makeRecordingBackend(recs: SurfaceRec[]): IRenderBackend {
  let seq = 0;
  const makeSurface = (): ISurface => {
    const rec: SurfaceRec = {
      name: `surf${seq++}`,
      size: { width: 0, height: 0 },
      baseKinds: [],
      overlayKinds: [],
      baseLists: [],
    };
    recs.push(rec);
    return {
      setMediaSize: (s) => void (rec.size = s),
      beginFrame: () => ({ mediaSize: rec.size, bitmapSize: rec.size, hr: 1, vr: 1 }),
      renderLayer: (layer, lists: readonly DisplayList[]) => {
        const kinds: string[] = [];
        for (const l of lists) for (const c of l.commands) kinds.push(c.kind);
        if (layer === 'base') {
          rec.baseKinds = kinds;
          // Copy now: the builder pools its arrays.
          rec.baseLists = lists.map((l) => ({ ...l, commands: l.commands.map((c) => ({ ...c })) }));
        } else rec.overlayKinds = kinds;
      },
      endFrame: () => {},
      resolutionChanged: { subscribe: () => () => {} },
      snapshot: () => ({ _tag: 'SurfaceSnapshot' }),
      dispose: () => {},
    } as unknown as ISurface;
  };
  return {
    createSurface: () => makeSurface(),
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({ _tag: 'Snapshot' }) as never,
    // Width ∝ text length so labels (and the axis width) measure sensibly.
    text: { measure: (t: string) => ({ width: 6 * String(t).length, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
}
// One 'text' command carries N items, so count items (labels), not commands.
function countTextItems(lists: readonly DisplayList[]): number {
  let n = 0;
  for (const l of lists) {
    for (const c of l.commands) {
      if (c.kind === 'text') n += (c as { items: readonly unknown[] }).items.length;
    }
  }
  return n;
}
function textXs(lists: readonly DisplayList[]): number[] {
  const xs: number[] = [];
  for (const l of lists) {
    for (const c of l.commands) {
      if (c.kind === 'text') for (const it of (c as { items: readonly { x: number }[] }).items) xs.push(it.x);
    }
  }
  return xs;
}
// Numbers parsed from the text items: the prices the axis is actually showing.
function textValues(lists: readonly DisplayList[]): number[] {
  const vals: number[] = [];
  for (const l of lists) {
    for (const c of l.commands) {
      if (c.kind !== 'text') continue;
      for (const it of (c as { items: readonly { text?: string }[] }).items) {
        const v = Number(String(it.text ?? '').replace(/[^0-9.\-]/g, ''));
        if (Number.isFinite(v) && String(it.text ?? '').trim() !== '') vals.push(v);
      }
    }
  }
  return vals;
}

// The narrowest visible surface in a pane row (the pane itself is wider).
function rightAxisOf(recs: SurfaceRec[]): SurfaceRec | undefined {
  return recs.filter((r) => r.size.height > 28 && r.size.width > 0).sort((a, b) => a.size.width - b.size.width)[0];
}

function setupFurniture() {
  const recs: SurfaceRec[] = [];
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeEl(doc);
  const chart = createChartWith(
    container as unknown as HTMLElement,
    makeRecordingBackend(recs),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  );
  raf.flush(0);
  return { recs, raf, chart };
}

describe('createChartWith — AXIS FURNITURE wired into the live axis/pane scenes', () => {
  test('the right price-axis scene emits ≥2 price-label text commands after setData', () => {
    const { recs, raf, chart } = setupFurniture();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    chart.timeScale().fitContent();
    raf.flush(16);
    const rightAxis = rightAxisOf(recs);
    expect(rightAxis).toBeDefined();
    expect(countTextItems(rightAxis!.baseLists)).toBeGreaterThanOrEqual(2);
  });

  test('the bottom time-axis scene emits ≥2 time-label text commands after setData', () => {
    const { recs, raf, chart } = setupFurniture();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    chart.timeScale().fitContent(); // spread the 3 bars so >1 tick is visible
    raf.flush(16);
    const timeAxis = recs.filter((r) => r.size.height === 28).sort((a, b) => b.size.width - a.size.width)[0];
    expect(timeAxis).toBeDefined();
    expect(countTextItems(timeAxis!.baseLists)).toBeGreaterThanOrEqual(2);
  });

  test('the pane scene has a grid source emitting polyline lines after setData', () => {
    const { recs, raf, chart } = setupFurniture();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    chart.timeScale().fitContent();
    raf.flush(16);
    const pane = recs.filter((r) => r.size.height > 28).sort((a, b) => b.size.width - a.size.width)[0];
    expect(pane).toBeDefined();
    expect(pane!.baseKinds).toContain('polyline');
  });

  test('after a geometry change (fitContent), the time-label coordinates shift (live tracking)', () => {
    const { recs, raf, chart } = setupFurniture();
    const s = chart.addSeries(CandlestickSeries);
    s.setData(CANDLES);
    raf.flush(16);
    const findTimeAxis = (): SurfaceRec => recs.filter((r) => r.size.height === 28).sort((a, b) => b.size.width - a.size.width)[0]!;
    const before = textXs(findTimeAxis().baseLists);
    expect(before.length).toBeGreaterThan(0);
    chart.timeScale().fitContent();
    raf.flush(32);
    const after = textXs(findTimeAxis().baseLists);
    expect(after.length).toBeGreaterThan(0);
    // Either more ticks fit or the positions moved; either way the vector differs.
    expect(JSON.stringify(after)).not.toBe(JSON.stringify(before));
  });

  test('REGRESSION: the price axis fits the FULL visible window, not the 60px right-axis surface', () => {
    // Autoscale's visible-bar window must come from the pane width, not the 60px axis
    // surface. The first half of the data (≈200) sits far above the last half (≈100), so
    // at full view the axis must span both; the bug showed only the last bars (≈100).
    const { recs, raf, chart } = setupFurniture();
    const s = chart.addSeries(CandlestickSeries);
    const base = Math.floor(Date.UTC(2026, 0, 1) / 1000);
    const bars = Array.from({ length: 100 }, (_, i) => {
      const c = i < 50 ? 200 : 100;
      return { time: base + i * 86400, open: c, high: c + 1, low: c - 1, close: c };
    });
    s.setData(bars);
    chart.timeScale().fitContent();
    raf.flush(16);
    const rightAxis = rightAxisOf(recs)!;
    const vals = textValues(rightAxis.baseLists);
    expect(vals.length).toBeGreaterThan(0);
    expect(Math.max(...vals)).toBeGreaterThan(160);
    expect(Math.min(...vals)).toBeLessThan(140);
  });
});
