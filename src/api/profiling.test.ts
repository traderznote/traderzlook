// Frame-counter propagation on a headless stub-backend chart. Needs __TN_PROFILE__ = true,
// so run it under vitest.profile.config.ts. Reads exact counters, not timings.
import { describe, it, expect } from 'vitest';
import { createChartWith, CandlestickSeries, timeBehavior } from '../api';
import type { ChartEnvironment } from '../api';
import { createFrameCounters } from '../core';
import type { IFrameCounters } from '../core';
import type { FrameStats, IPerfSink } from '../host';

function makeBackend(): { backend: unknown } {
  let seq = 0;
  const makeSurface = (): unknown => {
    let media = { width: 0, height: 0 };
    return {
      setMediaSize(s: { width: number; height: number }) {
        media = s;
      },
      beginFrame() {
        return { mediaSize: media, bitmapSize: { width: media.width, height: media.height }, hr: 1, vr: 1 };
      },
      renderLayer() {},
      endFrame() {},
      resolutionChanged: { subscribe: () => () => {} },
      snapshot: () => ({ _tag: 'SurfaceSnapshot' }),
      dispose() {},
    };
  };
  return {
    backend: {
      createSurface: () => (seq++, makeSurface()),
      createImage: () => ({ id: 0, width: 0, height: 0 }),
      composeSnapshot: () => ({ _tag: 'Snapshot' }),
      text: { measure: (t: { text?: string }) => ({ width: 6 * String(t.text ?? '').length, ascent: 8, descent: 2 }) },
      dispose() {},
    },
  };
}

function makeRaf(): { scheduler: unknown; flush: (t?: number) => void; hasPending: () => boolean } {
  let pending: ((now: number) => void) | null = null;
  let now = 0;
  return {
    scheduler: {
      schedule(cb: (now: number) => void) {
        pending = cb;
        return () => {
          if (pending === cb) pending = null;
        };
      },
      dispose() {
        pending = null;
      },
    },
    hasPending: () => pending !== null,
    flush(t?: number) {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? now++);
    },
  };
}

function makeElement(doc: unknown): unknown {
  const children: unknown[] = [];
  const el: Record<string, unknown> = {
    ownerDocument: doc,
    style: {},
    children,
    appendChild: (c: unknown) => (children.push(c), c),
    removeChild: (c: unknown) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    contains: (c: unknown) => children.includes(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  };
  return el;
}
function makeDoc(): unknown {
  const doc: Record<string, unknown> = {};
  doc.createElement = () => makeElement(doc);
  return doc;
}

interface Harness {
  chart: ReturnType<typeof createChartWith>;
  raf: ReturnType<typeof makeRaf>;
  counters: IFrameCounters;
  frames: FrameStats[];
}

function makeChart(): Harness {
  const { backend } = makeBackend();
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeElement(doc);
  const counters = createFrameCounters();
  const frames: FrameStats[] = [];
  const sink: IPerfSink = { onFrame: (s) => frames.push(s) };
  const env: ChartEnvironment = { scheduler: raf.scheduler as never, perfSink: sink, frameCounters: counters };
  const chart = createChartWith(
    container as never,
    backend as never,
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    env,
  );
  raf.flush(0); // drain the frame armed by the initial synchronous setSize() flush
  return { chart, raf, counters, frames };
}

const DATA = [
  { time: '2026-01-05', open: 10, high: 14, low: 9, close: 13 },
  { time: '2026-01-06', open: 13, high: 17, low: 10, close: 11 },
  { time: '2026-01-07', open: 11, high: 12, low: 8, close: 9 },
  { time: '2026-01-08', open: 9, high: 15, low: 9, close: 14 },
  { time: '2026-01-09', open: 14, high: 16, low: 13, close: 15 },
];

describe('counter propagation (perf §9.6)', () => {
  it('builds with __TN_PROFILE__ enabled so the guards are live', () => {
    // Under the default config every assertion below would be vacuous; fail loudly instead.
    expect(__TN_PROFILE__).toBe(true);
  });

  it('emits exactly one FrameStats per painted frame, read at endFrame (clauses 3)', () => {
    const h = makeChart();
    const candles = h.chart.addSeries(CandlestickSeries, { upColor: '#26a69a' });
    const before = h.frames.length;
    candles.setData(DATA);
    expect(h.raf.hasPending()).toBe(true);
    h.raf.flush(16);
    expect(h.frames.length).toBe(before + 1);
    const stats = h.frames[h.frames.length - 1]!;
    expect(stats.displayLists).toBeGreaterThan(0);
    expect(stats.drawCommands).toBeGreaterThan(0);
    expect(stats.sourcesReEmitted).toBeGreaterThan(0); // the dirty candlestick re-emitted
    h.chart.dispose();
  });

  it('the view lanes are produced in-frame by the lower layers (clause 2)', () => {
    const h = makeChart();
    const candles = h.chart.addSeries(CandlestickSeries);
    candles.setData(DATA);
    h.raf.flush(16);
    const stats = h.frames[h.frames.length - 1]!;
    expect(stats.drawCommands).toBeGreaterThanOrEqual(stats.displayLists);
    expect(stats.sourcesReEmitted + stats.sourcesCached).toBeGreaterThan(0);
    expect(stats.cachedListIdentityViolations).toBe(0);
    h.chart.dispose();
  });

  it('the scheduler resets the accumulator at frame entry — no cross-frame bleed (clause 1)', () => {
    const h = makeChart();
    const candles = h.chart.addSeries(CandlestickSeries);
    candles.setData(DATA);
    h.raf.flush(16);
    const first = h.frames[h.frames.length - 1]!;
    expect(first.drawCommands).toBeGreaterThan(0);

    // Stale cross-frame garbage that the frame-entry reset must wipe.
    h.counters.drawCommands = 999_999;
    h.counters.displayLists = 999_999;
    h.counters.bufferReallocs = 7;

    h.chart.subscribeCrosshairMove(() => {});
    h.chart.setCrosshairPosition(9, '2026-01-07', candles); // arms an Overlay frame
    h.raf.flush(32);
    const overlay = h.frames[h.frames.length - 1]!;
    expect(overlay.drawCommands).toBeLessThan(999_999);
    expect(overlay.bufferReallocs).toBe(0);
    h.chart.dispose();
  });

  it('a frame touching no data/model leaves the data lanes at 0 (clause 4 / §4.4.4)', () => {
    const h = makeChart();
    const candles = h.chart.addSeries(CandlestickSeries);
    candles.setData(DATA);
    h.raf.flush(16);

    h.chart.subscribeCrosshairMove(() => {});
    h.chart.setCrosshairPosition(9, '2026-01-07', candles);
    h.raf.flush(32);
    const overlay = h.frames[h.frames.length - 1]!;
    expect(overlay.timelineRebuilds).toBe(0);
    expect(overlay.chunkRecomputes).toBe(0);
    h.chart.dispose();
  });

  it('FrameStats carries the resolved level and the host *Ms brackets', () => {
    const h = makeChart();
    const candles = h.chart.addSeries(CandlestickSeries);
    candles.setData(DATA);
    h.raf.flush(16);
    const stats = h.frames[h.frames.length - 1]!;
    expect(typeof stats.level).toBe('number');
    expect(stats.totalMs).toBeGreaterThanOrEqual(0);
    expect(stats.replayMs).toBeGreaterThanOrEqual(0);
    expect(stats.emitMs).toBeGreaterThanOrEqual(0);
    expect(stats.inputLagFrames).toBe(0); // no input drove a programmatic frame
    h.chart.dispose();
  });
});
