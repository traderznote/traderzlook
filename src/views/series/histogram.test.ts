import { describe, expect, test } from 'vitest';
import { createHistogramKind } from './histogram';
import type { HistogramItem } from './histogram';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { Coordinate, TimeIndex } from '../../core';

function fakeStore(values: number[]): PlotStoreView {
  const n = values.length;
  return {
    length: n,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => values[i]!,
    min: (i) => values[i]!,
    max: (i) => values[i]!,
    lane: (_n, i) => values[i]!,
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

function setup(values: number[], opts: SeriesOptions = {}, h = horz()) {
  const kind = createHistogramKind(opts);
  const buf = kind.createBuffer();
  const store = fakeStore(values);
  kind.itemsFromStore(store, REPLACE, buf);
  kind.convert(buf, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf, store };
}

function emitRects(kind: ReturnType<typeof createHistogramKind>, buf: ItemBuffer<HistogramItem>): RectsCommand {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  const lists = b.finish();
  expect(lists[0]!.space).toBe('bitmap');
  return lists[0]!.commands[0] as RectsCommand;
}

// At barSpacing 10, hr 2: spacing 2, columnWidth 20 − 2 = 18 (even → half 9, biased
// one px left). item0 spans x 119..136, item1 139..156. tickWidth 2; base 0 →
// baseY 400, topBase 399, bottomBase 401.

describe('histogram.emit — one bitmap rects, §4.11 column geometry (design 03 §8.5.4)', () => {
  test('above-base columns span [round(y·vr) .. bottomBase]; width ≈ barSpacing−gap', () => {
    const { kind, buf } = setup([10, 12]);
    const cmd = emitRects(kind, buf);

    expect(cmd.kind).toBe('rects');
    // item0 top = (200−10)·2 = 380, item1 top = 376; both down to bottomBase 401
    expect(Array.from(cmd.coords)).toEqual([
      119, 380, 18, 21,
      139, 376, 18, 25,
    ]);
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2);
    expect(cmd.runs[0]!.fill).toBe('#26a69a');
  });

  test('column width is ≈ barSpacing − gap, NOT ≈ 0.3·barSpacing (the Bar width)', () => {
    const { kind, buf } = setup([10, 12]);
    const cmd = emitRects(kind, buf);
    const w0 = cmd.coords[2]!;
    expect(w0).toBe(18); // round(10·2) − 2
    expect(w0).toBeGreaterThan(Math.floor(10 * 0.3 * 2));
  });

  test('below-base column straddles: base above the value → [topBase .. y−tickW/2+tickW]', () => {
    // base 15 → baseY 370, topBase 369; value 10 → yc 380, bottom = 380 − 1 + 2 = 381.
    const { kind, buf } = setup([10], { base: 15 });
    const cmd = emitRects(kind, buf);
    expect(Array.from(cmd.coords)).toEqual([119, 369, 18, 12]);
  });

  test('a zero-height column still paints a tickWidth tick at the base line', () => {
    // value == base: yc 400 > topBase 399, so it spans 399..401 (h = tickWidth).
    const { kind, buf } = setup([0]);
    const cmd = emitRects(kind, buf);
    expect(Array.from(cmd.coords)).toEqual([119, 399, 18, 2]);
    expect(cmd.coords[3]).toBe(Math.max(1, Math.floor(2)));
  });

  test('NaN value → no quad emitted (gap), and an explicit colour is honoured', () => {
    const { kind, buf } = setup([10, NaN, 12], { color: '#ff0000' });
    const cmd = emitRects(kind, buf);
    expect(cmd.coords.length).toBe(8);
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(2);
    expect(cmd.runs[0]!.fill).toBe('#ff0000');
  });
});

// Media y: item0 spans [190, 200] (value → base); its slot is x 56..72.
describe('histogram.hitTest — column slot + base-straddle vertical range (study 06 §4.12)', () => {
  test('cursor inside a column → Range hit, distance 0', () => {
    const { kind, buf } = setup([10, 12]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 195 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBe(0);
  });

  test('cursor just above the top within tolerance → Range hit, distance to top edge', () => {
    const { kind, buf } = setup([10, 12]);
    const hit = kind.hitTest(buf, 64 as Coordinate, 188 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Range);
    expect(hit!.distance).toBeCloseTo(2);
  });

  test('cursor far below the column (beyond tolerance) → null', () => {
    const { kind, buf } = setup([10, 12]);
    expect(kind.hitTest(buf, 64 as Coordinate, 210 as Coordinate)).toBeNull();
  });
});

describe('histogram kind — contract', () => {
  test('extendedRange is false (columns are self-contained, no ±1 neighbour)', () => {
    expect(createHistogramKind({}).extendedRange).toBe(false);
  });

  test('decimate (sub-pixel spacing) writes a bitmap rects and leaves the buffer unread', () => {
    const kind = createHistogramKind({});
    const b = new DisplayListBuilder();
    kind.decimate(fakeStore([10, 11, 12]), itemWindow(0, 3), frame(2, 2), horz(0.1), fakePrice(), b);
    const lists = b.finish();
    expect(lists[0]!.space).toBe('bitmap');
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
  });
});
