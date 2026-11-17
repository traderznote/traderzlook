import { describe, expect, test, vi } from 'vitest';
import { ZBand, HitPriority } from '../../gfx';
import type { DrawCommand, SceneSource, ViewFrame } from '../../gfx';
import type { Coordinate } from '../../core';
import {
  createSeriesMarkers,
  defaultSeriesMarkersOptions,
  type SeriesMarker,
} from './series-markers';

// 5 OHLC bars at logical 0..4 with times '0'..'4'.
const BARS = [
  { time: '0', open: 10, high: 14, low: 9, close: 13 },
  { time: '1', open: 13, high: 17, low: 10, close: 11 },
  { time: '2', open: 11, high: 12, low: 8, close: 9 },
  { time: '3', open: 9, high: 15, low: 9, close: 14 },
  { time: '4', open: 14, high: 16, low: 13, close: 15 },
];

function makeStore() {
  return {
    length: BARS.length,
    timeIndex: (i: number) => i,
    current: (i: number) => BARS[i].close,
    min: (i: number) => BARS[i].low,
    max: (i: number) => BARS[i].high,
    lane: (_n: number, i: number) => BARS[i].close,
    firstIndexAt: () => null,
    nearestIndexAt: () => 0,
  };
}

// Non-inverted price scale: y = 100 - price.
function makeSeries() {
  const dataChangedHandlers: Array<() => void> = [];
  const attached: unknown[] = [];
  const detached: unknown[] = [];
  const series = {
    attached,
    detached,
    fireDataChanged(): void {
      for (const h of dataChangedHandlers.slice()) h();
    },
    dataChangedCount(): number {
      return dataChangedHandlers.length;
    },
    store: makeStore,
    data: () => BARS,
    dataByIndex: (logical: number, _mismatch: string) => {
      const clamped = Math.max(0, Math.min(BARS.length - 1, Math.round(logical)));
      return BARS[clamped];
    },
    priceToCoordinate: (price: number) => (100 - price) as Coordinate,
    attachPrimitive: (p: unknown): void => {
      attached.push(p);
    },
    detachPrimitive: (p: unknown): void => {
      detached.push(p);
    },
    subscribeDataChanged: (h: () => void) => {
      dataChangedHandlers.push(h);
      return () => {
        const i = dataChangedHandlers.indexOf(h);
        if (i >= 0) dataChangedHandlers.splice(i, 1);
      };
    },
  };
  return series;
}

// x = logical * barSpacing + 10; nearest modes clamp the time into [0, length-1].
function makeTimeScale(opts?: { barSpacing?: number }) {
  const bs = opts?.barSpacing ?? 20;
  const ts = {
    barSpacing: () => bs,
    rightOffset: () => 0,
    logicalToCoordinate: (logical: number) => (logical * bs + 10) as Coordinate,
    timeToLogical: (time: unknown, mismatch: string) => {
      const n = Number(time);
      if (!Number.isFinite(n)) return null;
      if (mismatch === 'none') {
        return Number.isInteger(n) && n >= 0 && n < BARS.length ? n : null;
      }
      return Math.max(0, Math.min(BARS.length - 1, n));
    },
  };
  return ts;
}

function makeChart(ts: ReturnType<typeof makeTimeScale>) {
  return { timeScale: () => ts };
}

function frame(hr = 1, vr = 1, bitmapH = 400): ViewFrame {
  return {
    frame: { mediaSize: { width: 400, height: bitmapH }, bitmapSize: { width: 400, height: bitmapH }, hr, vr },
    now: 0,
  } as unknown as ViewFrame;
}

function sourceOf(series: ReturnType<typeof makeSeries>): SceneSource {
  const prim = series.attached[0] as { sources(): ReadonlyArray<{ source: SceneSource }> };
  return prim.sources()[0].source;
}

function commandsOf(src: SceneSource): DrawCommand[] {
  return src.displayLists().flatMap((l) => l.commands as DrawCommand[]);
}

// autoscale lives on the primitive, not the handle.
function primitiveOf(series: ReturnType<typeof makeSeries>): {
  autoscale?: (r: never) => { priceRange: unknown; margins?: { above: number; below: number } } | null;
} {
  return series.attached[0] as never;
}

function setup(markers?: readonly SeriesMarker<string>[], options?: Parameters<typeof createSeriesMarkers>[3]) {
  const series = makeSeries();
  const ts = makeTimeScale();
  const chart = makeChart(ts);
  const handle = createSeriesMarkers(
    chart as never,
    series as never,
    markers as never,
    options,
  );
  return { series, ts, chart, handle };
}

describe('createSeriesMarkers — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches ONE primitive to the series (the §2.2 attach)', () => {
    const { series } = setup([]);
    expect(series.attached).toHaveLength(1);
    expect(series.detached).toHaveLength(0);
  });

  test('the registered source sits in band AboveSeries (below crosshair — §2.3/§9.3)', () => {
    const { series } = setup([{ time: '1', position: 'aboveBar', shape: 'circle', color: '#f00', id: 'm1' }]);
    expect(sourceOf(series).zBand).toBe(ZBand.AboveSeries);
  });

  test('detach() is idempotent + total AND tears down the data-changed subscription (§2.7)', () => {
    const { series, handle } = setup([]);
    expect(series.dataChangedCount()).toBe(1);
    handle.detach();
    expect(series.detached).toEqual(series.attached);
    expect(series.dataChangedCount()).toBe(0);
    handle.detach();
    handle.detach();
    expect(series.detached).toHaveLength(1);
    expect(() => series.fireDataChanged()).not.toThrow();
  });

  test('AUTO-detach via primitive.detached() tears down the data-changed handler (no leak — FIX 1)', () => {
    // The host calls primitive.detached() on series/pane removal and chart.dispose.
    const { series } = setup([]);
    const prim = series.attached[0] as { detached(): void };
    expect(series.dataChangedCount()).toBe(1);
    prim.detached();
    expect(series.dataChangedCount()).toBe(0);
    expect(() => prim.detached()).not.toThrow();
    expect(series.dataChangedCount()).toBe(0);
  });
});

describe('createSeriesMarkers — index resolution (study 08 §4.4 + §13.14 nearest-search)', () => {
  test('a marker time past the last bar attaches to the END bar (§13.14 clamp)', () => {
    // Clamps to bar 4: x = 4*20+10 = 90, inBar y = 100 - close 15 = 85.
    const { series } = setup([{ time: '9', position: 'inBar', shape: 'circle', color: '#f00', id: 'late' }]);
    const src = sourceOf(series);
    src.update(frame());
    const hit = src.hitTest!(90 as Coordinate, 85 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('late');
  });

  test('a marker time before the first bar snaps RIGHT to bar 0 (§4.4 NearestRight)', () => {
    const { series } = setup([{ time: '-5', position: 'inBar', shape: 'circle', color: '#f00', id: 'early' }]);
    const src = sourceOf(series);
    src.update(frame());
    // Bar 0: x = 10, y = 100 - 13 = 87.
    const hit = src.hitTest!(10 as Coordinate, 87 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('early');
  });
});

describe('createSeriesMarkers — emit (study 08 §4.4 shapes + bands)', () => {
  test('each shape kind emits its own command; text emits a media-space text command', () => {
    const { series } = setup([
      { time: '0', position: 'aboveBar', shape: 'circle', color: '#0a0', id: 'c', text: 'hi' },
      { time: '1', position: 'belowBar', shape: 'square', color: '#a00', id: 's' },
      { time: '2', position: 'aboveBar', shape: 'arrowUp', color: '#00a', id: 'a' },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    const kinds = commandsOf(src).map((c) => c.kind);
    expect(kinds).toContain('circles');
    expect(kinds).toContain('rects');
    expect(kinds).toContain('path');
    expect(kinds).toContain('text');
    const spaces = src.displayLists().map((l) => l.space);
    expect(spaces).toContain('bitmap');
    expect(spaces).toContain('media');
  });

  test('an atPriceTop marker WITH a price renders at the resolved center (FIX 2 — typed price)', () => {
    // price 12 → y = 88; minus the circle's half-height 9 (bs=20) → center y = 79; x = 30.
    const { series } = setup([
      { time: '1', position: 'atPriceTop', shape: 'circle', color: '#f00', id: 'ap', price: 12 },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    expect(commandsOf(src).map((c) => c.kind)).toContain('circles');
    const hit = src.hitTest!(30 as Coordinate, 79 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.externalId).toBe('ap');
    expect(hit!.distance).toBe(0);
  });

  test('visible:false emits nothing', () => {
    const { series, handle } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'x' }]);
    handle.applyOptions({ visible: false });
    const src = sourceOf(series);
    src.update(frame());
    expect(commandsOf(src)).toHaveLength(0);
  });
});

describe('createSeriesMarkers — hit testing (design 05 §2.4/§2.7 — real distances, Point priority)', () => {
  test('a hit returns Point priority + the marker id as externalId; distance 0 at the center', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'mid' }]);
    const src = sourceOf(series);
    src.update(frame());
    // Bar 1: x = 30, y = 100 - 11 = 89.
    const hit = src.hitTest!(30 as Coordinate, 89 as Coordinate, frame());
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
    expect(hit!.externalId).toBe('mid');
    expect(hit!.distance).toBe(0);
  });

  test('a far-away point misses (null), proving distance is real, not implicit 0', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'mid' }]);
    const src = sourceOf(series);
    src.update(frame());
    expect(src.hitTest!(300 as Coordinate, 300 as Coordinate, frame())).toBeNull();
  });

  test('first marker in array order wins among markers (no distance ranking among them)', () => {
    const { series } = setup([
      { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'first' },
      { time: '1', position: 'inBar', shape: 'circle', color: '#0f0', id: 'second' },
    ]);
    const src = sourceOf(series);
    src.update(frame());
    const hit = src.hitTest!(30 as Coordinate, 89 as Coordinate, frame());
    expect(hit!.externalId).toBe('first');
  });
});

describe('createSeriesMarkers — autoscale margins (study 08 §4.4 — MAX-merge participation)', () => {
  test('aboveBar markers contribute the full above margin; below is 0', () => {
    const { series } = setup([{ time: '0', position: 'aboveBar', shape: 'circle', color: '#f00', id: 'a' }]);
    const info = primitiveOf(series).autoscale!({ from: 0, to: 4 } as never);
    // At bs=20: shapeHeight = 18, shapeMargin = 3, so ml = 18*1.5 + 3*2 = 33.
    expect(info).not.toBeNull();
    expect(info!.priceRange).toBeNull();
    expect(info!.margins).toEqual({ above: 33, below: 0 });
  });

  test('inBar-only markers contribute ceil(ml/2) to BOTH sides', () => {
    const { series } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'i' }]);
    const info = primitiveOf(series).autoscale!({ from: 0, to: 4 } as never);
    expect(info!.margins).toEqual({ above: Math.ceil(33 / 2), below: Math.ceil(33 / 2) });
  });

  test('autoScale:false OR no markers → no contribution (null)', () => {
    const { series } = setup([], undefined);
    expect(primitiveOf(series).autoscale!({ from: 0, to: 4 } as never)).toBeNull();
    const { series: s2 } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'i' }], {
      autoScale: false,
    });
    expect(primitiveOf(s2).autoscale!({ from: 0, to: 4 } as never)).toBeNull();
  });
});

describe('createSeriesMarkers — validation (design 05 §2.7 item 1)', () => {
  test("setMarkers rejects unsorted input under default 'throw' validation", () => {
    const { handle } = setup([]);
    expect(() =>
      handle.setMarkers([
        { time: '3', position: 'inBar', shape: 'circle', color: '#f00', id: 'b' },
        { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' },
      ]),
    ).toThrow(/ascending/);
  });

  test("validation:'skip' drops the out-of-order marker instead of throwing", () => {
    const { handle } = setup([], { validation: 'skip' });
    handle.setMarkers([
      { time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' },
      { time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'dropped' },
      { time: '2', position: 'inBar', shape: 'circle', color: '#f00', id: 'c' },
    ]);
    expect(handle.markers().map((m) => m.id)).toEqual(['a', 'c']);
  });

  test('an atPrice* marker without a price throws (study 08 §4.4)', () => {
    const { handle } = setup([]);
    expect(() =>
      handle.setMarkers([{ time: '1', position: 'atPriceTop', shape: 'circle', color: '#f00', id: 'p' }]),
    ).toThrow(/price/);
  });
});

describe('createSeriesMarkers — options + setMarkers/markers (design 02 §12.4 adapter)', () => {
  test('defaults match the kept reference defaults', () => {
    expect(defaultSeriesMarkersOptions.visible).toBe(true);
    expect(defaultSeriesMarkersOptions.validation).toBe('throw');
    expect(defaultSeriesMarkersOptions.autoScale).toBe(true);
  });

  test('markers() returns the current set; setMarkers replaces it', () => {
    const { handle } = setup([{ time: '0', position: 'inBar', shape: 'circle', color: '#f00', id: 'a' }]);
    expect(handle.markers().map((m) => m.id)).toEqual(['a']);
    handle.setMarkers([{ time: '2', position: 'inBar', shape: 'square', color: '#0f0', id: 'b' }]);
    expect(handle.markers().map((m) => m.id)).toEqual(['b']);
  });

  test('a data-changed event invalidates the resolved-index memo (re-resolves next frame)', () => {
    const { series } = setup([{ time: '1', position: 'inBar', shape: 'circle', color: '#f00', id: 'm' }]);
    const src = sourceOf(series);
    src.update(frame());
    expect(src.hitTest!(30 as Coordinate, 89 as Coordinate, frame())).not.toBeNull();
    series.fireDataChanged();
    const f2 = frame();
    // A different bitmap height changes the signature so update() rebuilds.
    src.update(frame(1, 1, 401));
    expect(() => src.hitTest!(30 as Coordinate, 89 as Coordinate, f2)).not.toThrow();
  });
});
