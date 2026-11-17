import { describe, expect, test } from 'vitest';
import { createCandlestickKind } from './candlestick';
import type { CandlestickItem } from './candlestick';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

/** Rows are [open, high, low, close]; lane 0 = open. */
function fakeStore(rows: readonly (readonly [number, number, number, number])[]): PlotStoreView {
  return {
    length: rows.length,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => rows[i]![3],
    min: (i) => rows[i]![2],
    max: (i) => rows[i]![1],
    lane: (n, i) => rows[i]![n]!,
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
  return {
    priceToCoordinate: (p) => 200 - p,
    firstValue: null,
    mode: 'normal',
    toLogical: (p) => p,
  };
}

function frame(hr = 2, vr = 2): ViewFrame {
  return {
    frame: { mediaSize: { width: 100, height: 100 }, bitmapSize: { width: 100 * hr, height: 100 * vr }, hr, vr },
    now: 0,
  };
}

const REPLACE: StoreDiff = { kind: 'replace' };

/** Distinct colours per pass so goldens can assert exact run fills. */
const COLORS: SeriesOptions = {
  upColor: '#11aa11',
  downColor: '#cc2222',
  borderUpColor: '#0a800a',
  borderDownColor: '#a01010',
  wickUpColor: '#0d990d',
  wickDownColor: '#b01818',
};

function setup(
  rows: readonly (readonly [number, number, number, number])[],
  opts: SeriesOptions = COLORS,
  h = horz(),
) {
  const kind = createCandlestickKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(rows);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, rows.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

function emitRects(
  kind: ReturnType<typeof createCandlestickKind>,
  buf: ItemBuffer<CandlestickItem>,
  h = horz(),
): RectsCommand[] {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands as RectsCommand[];
}

// At barSpacing 10, hr 2: barWidth 16 (halfBar 8), wickWidth 2 (offset 1), border
// bw 2, and barSpacing·hr = 20 > 2·bw, so borders are hollow frames.
//
// item0 (up, x 128 device): body y 376..380, high 370, low 384; column x 120..135.
// item1 (down, x 148 device): body y 372..376, high 368, low 378; column x 140..155.

describe('candlestick.emit — three passes wicks→borders→bodies, runs by colour (study 06 §4.10)', () => {
  const rows: readonly (readonly [number, number, number, number])[] = [
    [10, 15, 8, 12], // up
    [14, 16, 11, 12], // down
  ];

  test('the pass sequence is exactly [wicks, borders, bodies], all rects', () => {
    const { kind, buf } = setup(rows);
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(3);
    expect(cmds.map((c) => c.kind)).toEqual(['rects', 'rects', 'rects']);
  });

  test('PASS 1 wicks: upper+lower stick per bar, centred + offset, runs by wick colour', () => {
    const { kind, buf } = setup(rows);
    const [wicks] = emitRects(kind, buf);
    expect(Array.from(wicks!.coords)).toEqual([
      127, 370, 2, 6, // item0 upper wick
      127, 381, 2, 4, // item0 lower wick
      147, 368, 2, 4, // item1 upper wick
      147, 377, 2, 2, // item1 lower wick
    ]);
    expect(wicks!.runs.map((r) => [r.count, r.fill])).toEqual([
      [2, '#0d990d'],
      [2, '#b01818'],
    ]);
  });

  test('PASS 2 borders: hollow frame (4 rects/bar) when barSpacing·hr > 2·bw, runs by border colour', () => {
    const { kind, buf } = setup(rows);
    const [, borders] = emitRects(kind, buf);
    expect(Array.from(borders!.coords)).toEqual([
      122, 376, 12, 2, // item0 top edge
      122, 379, 12, 2, // item0 bottom edge
      120, 376, 2, 5, // item0 left edge
      134, 376, 2, 5, // item0 right edge
      142, 372, 12, 2, // item1 top edge
      142, 375, 12, 2, // item1 bottom edge
      140, 372, 2, 5, // item1 left edge
      154, 372, 2, 5, // item1 right edge
    ]);
    expect(borders!.runs.map((r) => [r.count, r.fill])).toEqual([
      [4, '#0a800a'],
      [4, '#a01010'],
    ]);
  });

  test('PASS 3 bodies: open→close rect inset by bw on all sides, runs by body colour', () => {
    const { kind, buf } = setup(rows);
    const [, , bodies] = emitRects(kind, buf);
    expect(Array.from(bodies!.coords)).toEqual([
      122, 378, 12, 1, // item0 body
      142, 374, 12, 1, // item1 body
    ]);
    expect(bodies!.runs.map((r) => [r.count, r.fill])).toEqual([
      [1, '#11aa11'],
      [1, '#cc2222'],
    ]);
  });

  test('up/down colours (previously ignored borderUp/Down, wickUp/Down) are honoured per pass', () => {
    // Bodies span ≥ 8px so the inset never swallows them.
    const { kind, buf } = setup([
      [10, 15, 8, 14],
      [14, 16, 8, 10],
    ]);
    const [wicks, borders, bodies] = emitRects(kind, buf);
    expect(wicks!.runs.map((r) => r.fill)).toEqual(['#0d990d', '#b01818']);
    expect(borders!.runs.map((r) => r.fill)).toEqual(['#0a800a', '#a01010']);
    expect(bodies!.runs.map((r) => r.fill)).toEqual(['#11aa11', '#cc2222']);
  });

  test('wickVisible:false suppresses the wick pass (borders then bodies remain)', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]], { ...COLORS, wickVisible: false });
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(2);
    expect(cmds[0]!.coords.length).toBe(16); // 4 border quads
    expect(cmds[0]!.runs[0]!.fill).toBe('#0a800a');
    expect(cmds[1]!.coords.length).toBe(4); // 1 body quad
    expect(cmds[1]!.runs[0]!.fill).toBe('#11aa11');
  });

  test('borderVisible:false suppresses borders AND drops the body inset (full-width body)', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]], { ...COLORS, borderVisible: false });
    const cmds = emitRects(kind, buf);
    expect(cmds).toHaveLength(2);
    const bodies = cmds[1]!;
    expect(Array.from(bodies.coords)).toEqual([120, 376, 16, 5]);
  });

  test('NaN OHLC → no quad in any pass (gap skipped)', () => {
    const { kind, buf } = setup([
      [10, 15, 8, 12],
      [NaN, NaN, NaN, NaN],
    ]);
    const [wicks, borders, bodies] = emitRects(kind, buf);
    expect(wicks!.coords.length).toBe(8);
    expect(borders!.coords.length).toBe(16);
    expect(bodies!.coords.length).toBe(4);
  });

  test('hollow-frame vs filled body switches on barSpacing·hr ≤ 2·bw', () => {
    // barSpacing 0.8: barWidth 2, bw 2, barSpacing·hr = 1.6 ≤ 4 → one filled border
    // rect per bar, and the body pass is skipped because barWidth ≤ 2·bw.
    const { kind, buf } = setup([[10, 15, 8, 12]], COLORS, horz(0.8));
    const b = new DisplayListBuilder();
    kind.emit(buf, itemWindow(0, 1), frame(), b);
    const cmds = b.finish()[0]!.commands as RectsCommand[];
    expect(cmds).toHaveLength(2);
    const borders = cmds[1]!;
    expect(borders.coords.length).toBe(4);
    expect(borders.runs[0]!.fill).toBe('#0a800a');
  });

  test('a doji body (open == close) collapses to a 1px-tall fill after inset', () => {
    // top == bottom == 376; the bw=2 inset makes top > bottom, so the body is skipped.
    const { kind, buf } = setup([[12, 15, 8, 12]]);
    const [, , bodies] = emitRects(kind, buf);
    expect(bodies!.coords.length).toBe(0);
  });
});

// item0 spans media y [185, 192]; its slot is x 56..72.
describe('candlestick.hitTest — column slot + hi–lo vertical range (study 06 §4.12)', () => {
  test('cursor inside a candle hi–lo span → Range hit, distance 0', () => {
    const { kind, buf } = setup([
      [10, 15, 8, 12],
      [14, 16, 11, 12],
    ]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 188 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBe(0);
  });

  test('cursor just above the high within tolerance → distance to top edge', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 183 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBeCloseTo(2);
  });

  test('cursor far below the low (beyond tolerance) → null', () => {
    const { kind, buf } = setup([[10, 15, 8, 12]]);
    expect(kind.hitTest(buf, 64 as Coordinate, 210 as Coordinate)).toBeNull();
  });
});

describe('candlestick kind — contract', () => {
  test('extendedRange is false (a candle is self-contained, no ±1 neighbour)', () => {
    expect(createCandlestickKind({}).extendedRange).toBe(false);
  });

  test('createBuffer uses the OHLC stride-4 extra lane', () => {
    expect(createCandlestickKind({}).createBuffer().laneStride).toBe(4);
  });

  test('decimate (sub-pixel spacing) writes a bitmap rects and leaves the buffer unread', () => {
    const kind = createCandlestickKind({});
    const b = new DisplayListBuilder();
    kind.decimate(fakeStore([[10, 11, 9, 10]]), itemWindow(0, 1), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
  });
});
