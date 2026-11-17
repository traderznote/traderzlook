import { describe, expect, test } from 'vitest';
import type {
  HorzPoint,
  HorzScaleOptionGroups,
  IChart,
  IPrimitive,
  ITimeScale,
  PrimitiveContext,
  PrimitiveSource,
  Time,
} from '../../api';
import { LineSeries, createChartWith } from '../../api';
import type { DisplayList, IRenderBackend, ISurface, SceneSource } from '../../gfx';
import { priceAxisBehavior, yieldCurveBehavior } from './price-axis-behavior';
import { offsetFor, timezoneTimeBehavior } from './timezone-time-behavior';
import {
  createSessionHighlight,
  sessionHighlightDefaults,
  type SessionSpec,
} from './session-highlight';
import type { PrimitiveTarget } from '../shared';

// Headless harness: a recording stub backend, fake DOM and fake rAF.
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
function makeRaf(): { scheduler: { schedule(cb: (n: number) => void): () => void; dispose(): void }; flush(t?: number): void } {
  let pending: ((n: number) => void) | null = null;
  let n = 0;
  return {
    scheduler: {
      schedule: (cb) => ((pending = cb), () => void (pending === cb && (pending = null))),
      dispose: () => void (pending = null),
    },
    flush: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? n++);
    },
  };
}

describe('S2 — non-time behaviors drop straight onto createChartWith (no bespoke factory)', () => {
  test('a priceAxisBehavior chart builds, takes value-against-price data, and paints', () => {
    const log: string[] = [];
    const raf = makeRaf();
    const doc = makeDoc();
    const container = makeEl(doc);
    const chart = createChartWith<number>(
      container as unknown as HTMLElement,
      makeBackend(log),
      priceAxisBehavior({ precision: 2 }),
      { layout: { textColor: '#191919' } },
      { scheduler: raf.scheduler },
    );
    raf.flush(0);
    expect(log.length).toBeGreaterThan(0);

    // `time` is the horizontal price level, not a date.
    const series = chart.addSeries(LineSeries as never, undefined, undefined) as unknown as {
      setData(d: readonly { time: number; value: number }[]): void;
      seriesType(): string;
    };
    const before = log.length;
    series.setData([
      { time: 100, value: 3 },
      { time: 105, value: 7 },
      { time: 110, value: 5 },
      { time: 120, value: 9 },
    ]);
    raf.flush(16);
    const rendered = log.slice(before);
    expect(rendered.some((l) => l.includes('.beginFrame'))).toBe(true);
    expect(rendered.some((l) => l.includes('.renderLayer base') && !l.endsWith('cmds=0'))).toBe(true);
    chart.dispose();
  });

  test('augmentDefaults runs in the three-layer pipeline (a non-time chart clears the date format)', () => {
    const beh = yieldCurveBehavior();
    const groups = {
      timeScale: {} as never,
      localization: { dateFormat: 'yyyy-MM-dd', locale: 'en-US' } as never,
    } as unknown as HorzScaleOptionGroups<number>;
    beh.augmentDefaults(groups);
    expect(groups.localization.dateFormat).toBe('');
  });
});

describe('S3 — open integer weight scale (behavior mints its own bands)', () => {
  function fill(beh: { fillWeights(p: readonly HorzPoint<number>[], s: number): void }, values: number[]): number[] {
    const points: HorzPoint<number>[] = values.map((v) => ({ item: v, key: v as never, weight: 0 }));
    beh.fillWeights(points, 0);
    return points.map((p) => p.weight);
  }

  test('priceAxisBehavior bolds the bigger decade boundary (a Hundred crossing > a Unit crossing)', () => {
    const beh = priceAxisBehavior() as unknown as {
      fillWeights(p: readonly HorzPoint<number>[], s: number): void;
      maxTickWeight(w: readonly number[]): number;
    };
    const w = fill(beh, [99, 100, 101]);
    expect(w[1]!).toBeGreaterThan(w[2]!);
    expect(beh.maxTickWeight(w)).toBe(Math.max(...w));
  });

  test('yieldCurveBehavior mints calendar-tenor bands (a Year crossing > a Day crossing)', () => {
    const beh = yieldCurveBehavior() as unknown as { fillWeights(p: readonly HorzPoint<number>[], s: number): void };
    const w = fill(beh, [364, 365, 366]);
    expect(w[1]!).toBeGreaterThan(w[2]!);
  });

  test('yieldCurveBehavior.formatTick renders human tenors (1Y / 6M / 30D)', () => {
    const beh = yieldCurveBehavior();
    const loc = { priceFormatter: undefined } as never;
    const fmt = {} as never;
    expect(beh.formatTick(365, 40, loc, fmt)).toBe('1Y');
    expect(beh.formatTick(180, 30, loc, fmt)).toBe('6M');
    expect(beh.formatTick(30, 20, loc, fmt)).toBe('1M');
    expect(beh.formatTick(5, 10, loc, fmt)).toBe('5D');
  });
});

describe('S1 — timezoneTimeBehavior: offset hook drives bucketing + labels (extras-only IANA)', () => {
  // 2026-06-15 is in US EDT (UTC−4).
  const NY = 'America/New_York';

  test('offsetFor resolves a real IANA offset (New York EDT = −4h) in extras', () => {
    const off = offsetFor(NY);
    const utc = Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000);
    expect(off(utc)).toBe(-4 * 3600);
    const winter = Math.floor(Date.UTC(2026, 0, 15, 12, 0, 0) / 1000);
    expect(off(winter)).toBe(-5 * 3600);
  });

  test('the timezoneOffset hook is installed and returns seconds at the item instant', () => {
    const beh = timezoneTimeBehavior(NY);
    expect(typeof beh.timezoneOffset).toBe('function');
    const item = { timestamp: Math.floor(Date.UTC(2026, 5, 15, 12, 0, 0) / 1000) } as never;
    expect(beh.timezoneOffset!(item)).toBe(-4 * 3600);
  });

  test('fillWeights buckets on the SHIFTED instant — a LOCAL day boundary bolds where UTC does not', () => {
    const beh = timezoneTimeBehavior(NY);
    // Same UTC date, but straddling local midnight: 23:30 Jun 14 and 00:30 Jun 15 in New York.
    const t1 = Math.floor(Date.UTC(2026, 5, 15, 3, 30, 0) / 1000);
    const t2 = Math.floor(Date.UTC(2026, 5, 15, 4, 30, 0) / 1000);
    const points: HorzPoint<{ timestamp: number }>[] = [
      { item: { timestamp: t1 }, key: t1 as never, weight: 0 },
      { item: { timestamp: t2 }, key: t2 as never, weight: 0 },
    ];
    (beh as unknown as { fillWeights(p: readonly HorzPoint<{ timestamp: number }>[], s: number): void }).fillWeights(
      points,
      0,
    );
    expect(points[1]!.weight).toBeGreaterThanOrEqual(50); // day-or-coarser weight
  });

  test('formatTick renders the LOCAL wall-clock time (not the UTC time)', () => {
    const beh = timezoneTimeBehavior(NY);
    const t = Math.floor(Date.UTC(2026, 5, 15, 16, 0, 0) / 1000);
    const item = { timestamp: t } as never;
    const loc = { tickMarkFormatter: undefined, locale: 'en-US' } as never;
    const fmt = { timeVisible: true, secondsVisible: false, tickMarkFormatter: undefined } as never;
    expect(beh.formatTick(item, 30, loc, fmt)).toBe('12:00');
  });

  test('an unresolvable IANA zone falls back to UTC (offset 0) without throwing', () => {
    const off = offsetFor('Not/AZone');
    expect(off(Math.floor(Date.now() / 1000))).toBe(0);
  });

  test('A-5: timezoneTimeBehavior routes through the CORE timeBehavior seam (FIX 5)', () => {
    const beh = timezoneTimeBehavior(NY);
    // 02:00 UTC Jun 15 is 22:00 Jun 14 in New York, so a day tick shows 14.
    const t = Math.floor(Date.UTC(2026, 5, 15, 2, 0, 0) / 1000);
    const item = { timestamp: t } as never;
    const loc = { tickMarkFormatter: undefined, locale: 'en-US', dateFormat: "dd MMM ''yy" } as never;
    const fmt = { timeVisible: false, secondsVisible: false, tickMarkFormatter: undefined } as never;
    expect(beh.formatTick(item, 50, loc, fmt)).toBe('14');

    const utcBeh = timezoneTimeBehavior('UTC');
    expect(utcBeh.formatTick(item, 50, loc, fmt)).toBe('15');
  });
});

function makeStubPane(): PrimitiveTarget & { size(): { width: number; height: number }; attached: IPrimitive[] } {
  const attached: IPrimitive[] = [];
  return {
    attached,
    attachPrimitive: (p) => void attached.push(p),
    detachPrimitive: (p) => {
      const i = attached.indexOf(p);
      if (i >= 0) attached.splice(i, 1);
    },
    size: () => ({ width: 600, height: 400 }),
  };
}

// keysInRange returns the keys whose index is in [ceil(from), floor(to)]; keys are placed
// linearly at 10px per slot.
function makeStubTimeScale(keys: number[], range: { from: number; to: number } | null): ITimeScale {
  return {
    getVisibleLogicalRange: () => (range === null ? null : { from: range.from as never, to: range.to as never }),
    keysInRange: (r: { from: number; to: number }) => {
      const from = Math.max(0, Math.ceil(r.from));
      const to = Math.min(keys.length - 1, Math.floor(r.to));
      const out: number[] = [];
      for (let i = from; i <= to; i++) out.push(keys[i]!);
      return out as never;
    },
    keyToLogical: (key: number) => {
      const i = keys.indexOf(key);
      return (i < 0 ? null : i) as never;
    },
    logicalToCoordinate: (logical: number) => (logical * 10) as never,
  } as unknown as ITimeScale;
}

function attachAndContext(
  paneSource: SceneSource,
  pane: { size(): { width: number; height: number } },
): { ctx: PrimitiveContext; frame: { frame: { mediaSize: { width: number; height: number }; bitmapSize: { width: number; height: number }; hr: number; vr: number }; now: number } } {
  let updates = 0;
  const ctx = {
    pane: pane as never,
    requestUpdate: () => void updates++,
  } as unknown as PrimitiveContext;
  void paneSource;
  const frame = {
    frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 },
    now: 0,
  };
  return { ctx, frame };
}

describe('S4/S5 — session-highlight: BelowSeries rects per span over keysInRange + time-axis breaks', () => {
  // One key per hour on Monday 2026-06-15 (UTC); the session is 00:00–08:00, so hours 0..7
  // are in session.
  const DAY0 = Math.floor(Date.UTC(2026, 5, 15, 0, 0, 0) / 1000);
  const HOUR = 3600;
  const KEYS = Array.from({ length: 24 }, (_, h) => DAY0 + h * HOUR);
  const SPEC: SessionSpec = { days: [1], openMinutes: 0, closeMinutes: 8 * 60, tz: 'UTC' };

  function setup(range: { from: number; to: number } | null) {
    const pane = makeStubPane();
    const chart = { timeScale: () => makeStubTimeScale(KEYS, range) } as { timeScale(): ITimeScale };
    const handle = createSessionHighlight(chart, pane, SPEC);
    expect(pane.attached.length).toBe(1);
    const primitive = pane.attached[0]!;
    const sources = (primitive.sources?.() ?? []) as readonly PrimitiveSource[];
    return { pane, handle, primitive, sources };
  }

  test('the primitive registers TWO sources: a BelowSeries pane band + a time-axis source (S5)', () => {
    const { sources } = setup({ from: 0, to: 23 });
    const targets = sources.map((s) => (s as unknown as { target: string }).target);
    expect(targets).toContain('pane');
    expect(targets).toContain('time-axis');
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    expect(paneSrc.zBand).toBe(2); // ZBand.BelowSeries
  });

  test('keysInRange (whitespace-inclusive) → ONE rect for the contiguous in-session run (S4)', () => {
    const { sources, primitive } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    const { frame } = attachAndContext(paneSrc, { size: () => ({ width: 600, height: 400 }) });
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(frame as never);
    const lists = paneSrc.displayLists();
    const rectCmds = countRects(lists);
    expect(rectCmds).toBe(1);
  });

  test('the in-session band covers the FULL span: half a bar wider than center→center (S4)', () => {
    // Slot centers 0..7 sit at x = 0..70; widening by half a bar (5px) each side gives
    // x = -5, w = 80 (8 full bars) instead of the 70px center-to-center span.
    const { sources, primitive } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    const quad = firstRectQuad(paneSrc.displayLists());
    expect(quad).not.toBeNull();
    const [x, , w] = quad!;
    expect(x).toBeCloseTo(-5);
    expect(w).toBeCloseTo(80);
  });

  test('an out-of-session-only visible range yields NO rects (no false highlight)', () => {
    const { sources, primitive } = setup({ from: 10, to: 20 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    expect(countRects(paneSrc.displayLists())).toBe(0);
  });

  test('a null visible range (empty scale) yields no rects', () => {
    const { sources, primitive } = setup(null);
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) } } as never as PrimitiveContext);
    paneSrc.update(
      { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never,
    );
    expect(countRects(paneSrc.displayLists())).toBe(0);
  });

  test('the time-axis break source emits a tick at the session OPEN (S5), and showBreaks:false silences it', () => {
    const { sources, primitive, handle } = setup({ from: 0, to: 23 });
    const paneSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'pane') as unknown as {
      source: SceneSource;
    }).source;
    const axisSrc = (sources.find((s) => (s as unknown as { target: string }).target === 'time-axis') as unknown as {
      source: SceneSource;
    }).source;
    primitive.attached?.({ pane: { size: () => ({ width: 600, height: 400 }) }, requestUpdate: () => {} } as never as PrimitiveContext);
    const frame = { frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 }, now: 0 } as never;
    paneSrc.update(frame); // the pane source rebuilds both caches
    expect(countRects(axisSrc.displayLists())).toBe(1);

    handle.applyOptions({ showBreaks: false });
    paneSrc.update(frame);
    expect(countRects(axisSrc.displayLists())).toBe(0);
    expect(countRects(paneSrc.displayLists())).toBe(1);
  });

  test('detach is idempotent and removes the primitive from the pane', () => {
    const { pane, handle } = setup({ from: 0, to: 23 });
    handle.detach();
    expect(pane.attached.length).toBe(0);
    handle.detach();
    expect(pane.attached.length).toBe(0);
  });

  test('defaults are the §7.1 kept values', () => {
    expect(sessionHighlightDefaults.visible).toBe(true);
    expect(sessionHighlightDefaults.showBreaks).toBe(true);
  });
});

function countRects(lists: readonly DisplayList[]): number {
  let n = 0;
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string }[]) {
      if (c.kind === 'rects') n++;
    }
  }
  return n;
}

// The first rect's [x, y, w, h] (RectsCommand.coords holds x,y,w,h quads).
function firstRectQuad(lists: readonly DisplayList[]): [number, number, number, number] | null {
  for (const l of lists) {
    for (const c of l.commands as readonly { kind: string; coords?: Float32Array }[]) {
      if (c.kind === 'rects' && c.coords !== undefined && c.coords.length >= 4) {
        return [c.coords[0]!, c.coords[1]!, c.coords[2]!, c.coords[3]!];
      }
    }
  }
  return null;
}

const _types: [IChart<Time> | null, SceneSource | null] = [null, null];
void _types;
