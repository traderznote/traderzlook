import { describe, expect, test } from 'vitest';
import { createBarKind } from './bar';
import type { BarItem } from './bar';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

interface OHLCRow {
  open: number;
  high: number;
  low: number;
  close: number;
}

/** lane 0 = open, max = high, min = low, current = close. */
function fakeStore(rows: OHLCRow[]): PlotStoreView {
  const n = rows.length;
  return {
    length: n,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => rows[i]!.close,
    min: (i) => rows[i]!.low,
    max: (i) => rows[i]!.high,
    lane: (lane, i) => (lane === 0 ? rows[i]!.open : rows[i]!.close),
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

/** indexToCoordinate(ix): ix 0→64, 1→74, 2→84, 3→94 (media px centres). */
function horz(barSpacing = 10): HorzGeometry {
  return createHorzGeometry({ width: 100, barSpacing, rightOffset: 0, baseIndex: 3 });
}

/** priceToCoordinate(price) = 200 − price. */
function fakePrice(): PriceConverter {
  return { priceToCoordinate: (p) => 200 - p, firstValue: null, mode: 'normal', toLogical: (p) => p };
}

function frame(hr = 2, vr = 2): ViewFrame {
  return {
    frame: { mediaSize: { width: 100, height: 100 }, bitmapSize: { width: 100 * hr, height: 100 * vr }, hr, vr },
    now: 0,
  };
}

const REPLACE: StoreDiff = { kind: 'replace' };

function setup(rows: OHLCRow[], opts: SeriesOptions = {}, h = horz()) {
  const kind = createBarKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(rows);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, rows.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

function emitRects(kind: ReturnType<typeof createBarKind>, buf: ItemBuffer<BarItem>): RectsCommand {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands[0] as RectsCommand;
}

// At barSpacing 10, hr 2: column width 6, thin stick 2 (half 1), ticks drawn
// (10 ≥ floor(1.5·2)), sideWidth = ceil(6·1.5) = 9.

describe('bar.emit — one bitmap rects: stick + open/close ticks, runs by colour (design 03 §8.5.5)', () => {
  test('up bars (open ≤ close): 3 quads each (stick, open tick, close tick); one colour run', () => {
    const { kind, buf } = setup([
      { open: 10, high: 15, low: 8, close: 12 },
      { open: 12, high: 16, low: 11, close: 14 },
    ]);
    const cmd = emitRects(kind, buf);
    expect(cmd.kind).toBe('rects');

    // bar0: center 128, left 127; top round(185·2)−1 = 369, bottom round(192·2)+1 = 385.
    //   open tick at round(190·2)−1 = 379 spans x 119..127; close tick at 375 spans 129..137.
    // bar1: center 148, left 147; top 367, bottom 379; open tick y 375, close tick y 371.
    expect(Array.from(cmd.coords)).toEqual([
      127, 369, 2, 16, // bar0 stick
      119, 379, 8, 2, // bar0 open tick
      129, 375, 8, 2, // bar0 close tick
      147, 367, 2, 12, // bar1 stick
      139, 375, 8, 2, // bar1 open tick
      149, 371, 8, 2, // bar1 close tick
    ]);
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(6);
    expect(cmd.runs[0]!.fill).toBe('#26a69a');
  });

  test('down bar (open > close) resolves the down colour', () => {
    const { kind, buf } = setup([{ open: 14, high: 16, low: 9, close: 10 }]);
    const cmd = emitRects(kind, buf);
    expect(cmd.runs[0]!.fill).toBe('#ef5350');
    expect(cmd.coords.length).toBe(12);
  });

  test('openVisible:false suppresses ONLY the open tick (stick + close tick remain)', () => {
    const { kind, buf } = setup([{ open: 10, high: 15, low: 8, close: 12 }], { openVisible: false });
    const cmd = emitRects(kind, buf);
    expect(cmd.coords.length).toBe(8);
    expect(cmd.coords[0]).toBe(127); // stick
    expect(cmd.coords[4]).toBe(129); // close tick
  });

  test('dense spacing (barSpacing < floor(1.5·hr)) drops the ticks → stick only', () => {
    const { kind, buf } = setup([{ open: 10, high: 15, low: 8, close: 12 }], {}, horz(1));
    const b = new DisplayListBuilder();
    kind.emit(buf, itemWindow(0, 1), frame(), b);
    const cmd = b.finish()[0]!.commands[0] as RectsCommand;
    expect(cmd.coords.length).toBe(4);
  });

  test('NaN OHLC (whitespace) → no quad emitted; an explicit colour is honoured', () => {
    const { kind, buf } = setup(
      [
        { open: 10, high: 15, low: 8, close: 12 },
        { open: NaN, high: NaN, low: NaN, close: NaN },
        { open: 12, high: 16, low: 11, close: 14 },
      ],
      { upColor: '#00ff00' },
    );
    const cmd = emitRects(kind, buf);
    expect(cmd.coords.length).toBe(24); // 2 finite bars · 3 quads · 4 floats
    expect(cmd.runs[0]!.fill).toBe('#00ff00');
  });
});

// bar0 spans media y [185, 192]; its slot is x 56..72 (left edge falls back to
// 64 − 5 − 3, right edge is the midpoint with bar1 + 3).
describe('bar.hitTest — column slot + hi–lo vertical range (study 06 §4.12)', () => {
  const rows: OHLCRow[] = [
    { open: 10, high: 15, low: 8, close: 12 },
    { open: 12, high: 16, low: 11, close: 14 },
  ];

  test('cursor inside the hi–lo range → Range hit, distance 0', () => {
    const { kind, buf } = setup(rows);
    const hit = kind.hitTest(buf, 64 as Coordinate, 188 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBe(0);
  });

  test('cursor just above the high within tolerance → distance to top edge', () => {
    const { kind, buf } = setup(rows);
    const hit = kind.hitTest(buf, 64 as Coordinate, 183 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBeCloseTo(2);
  });

  test('cursor far below the low (beyond tolerance) → null', () => {
    const { kind, buf } = setup(rows);
    expect(kind.hitTest(buf, 64 as Coordinate, 200 as Coordinate)).toBeNull();
  });
});

describe('bar kind — contract', () => {
  test('extendedRange is false (a fully off-screen bar contributes nothing, study 06 §3.3)', () => {
    expect(createBarKind({}).extendedRange).toBe(false);
  });

  test('createBuffer uses the OHLC stride-4 extra lane', () => {
    expect(createBarKind({}).createBuffer().laneStride).toBe(4);
  });

  test('decimate (sub-pixel spacing) writes a bitmap rects and leaves the buffer unread', () => {
    const kind = createBarKind({});
    const b = new DisplayListBuilder();
    // barSpacing·hr = 0.1·2 = 0.2 < 1
    kind.decimate(
      fakeStore([
        { open: 10, high: 15, low: 8, close: 12 },
        { open: 12, high: 16, low: 11, close: 14 },
      ]),
      itemWindow(0, 2),
      frame(2, 2),
      horz(0.1),
      fakePrice(),
      b,
    );
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
  });
});
