import { describe, expect, test } from 'vitest';
import { decimateColumns, shouldDecimate } from './decimate';
import { itemWindow } from './window';
import { DisplayListBuilder } from '../../gfx';
import type { PolylineCommand, RectsCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { PlotStoreView } from '../../data';
import type { TimeIndex } from '../../core';

/** timeIndex(i) == i, so rows map left→right monotonically. */
function fakeStore(mins: number[], maxs: number[], currents = mins): PlotStoreView {
  const n = mins.length;
  return {
    length: n,
    timeIndex: (i) => i as TimeIndex,
    current: (i) => currents[i]!,
    min: (i) => mins[i]!,
    max: (i) => maxs[i]!,
    lane: (_n, i) => currents[i]!,
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

/** Y = 1000 − price. */
function fakePrice(): PriceConverter {
  return {
    priceToCoordinate: (price) => 1000 - price,
    firstValue: null,
    mode: 'normal',
    toLogical: (price) => price,
  };
}

function frame(bitmapWidth: number, hr: number): ViewFrame {
  return {
    frame: {
      mediaSize: { width: bitmapWidth / hr, height: 400 },
      bitmapSize: { width: bitmapWidth, height: 400 * hr },
      hr,
      vr: hr,
    },
    now: 0,
  };
}

function horz(barSpacing: number, baseIndex: number, width: number): HorzGeometry {
  return createHorzGeometry({ width, barSpacing, rightOffset: 0, baseIndex });
}

describe('shouldDecimate', () => {
  test('active iff barSpacing·hr < 1 (the perf §6.3 / study 10 §4.14 threshold)', () => {
    expect(shouldDecimate(0.4, 2)).toBe(true);
    expect(shouldDecimate(0.5, 2)).toBe(false); // exactly 1.0 is not sub-pixel
    expect(shouldDecimate(2, 1)).toBe(false);
    expect(shouldDecimate(0.1, 1)).toBe(true);
  });
});

describe('decimateColumns — path selection', () => {
  test('returns null (inactive) on the normal path (barSpacing·hr ≥ 1) — engine runs convert→emit', () => {
    const store = fakeStore([10, 11, 12], [10, 11, 12]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 3),
      frame(300, 1),
      horz(2, 2, 300),
      fakePrice(),
      b,
      { shape: 'line', color: '#0af' },
    );
    expect(res).toBeNull();
  });

  test('is active and emits geometry on the decimated path (barSpacing·hr < 1)', () => {
    const store = fakeStore([10, 11, 12], [10, 11, 12]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 3),
      frame(300, 1),
      horz(0.1, 2, 300),
      fakePrice(),
      b,
      { shape: 'line', color: '#0af' },
    );
    expect(res).not.toBeNull();
    expect(res!.rowsScanned).toBe(3);
  });
});

describe('decimateColumns — ≤ deviceWidth segments', () => {
  test('collapses many rows into at most ceil(deviceWidth) columns', () => {
    const N = 2000;
    const mins: number[] = [];
    const maxs: number[] = [];
    for (let i = 0; i < N; i++) {
      mins.push(100 + (i % 7)); // wiggle so columns have a real min/max spread
      maxs.push(110 + (i % 5));
    }
    const store = fakeStore(mins, maxs);
    const bitmapWidth = 150;
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, N),
      frame(bitmapWidth, 1),
      horz(150 / N, N - 1, 150),
      fakePrice(),
      b,
      { shape: 'line', color: '#0af' },
    );
    expect(res).not.toBeNull();
    expect(res!.rowsScanned).toBe(N);
    expect(res!.columns).toBeLessThanOrEqual(Math.ceil(bitmapWidth));
    expect(res!.columns).toBeGreaterThan(0);
  });

  test('column min/max bracket maps to a vertical polyline segment per column (line)', () => {
    const store = fakeStore([10, 30], [10, 30]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 2),
      frame(50, 1),
      horz(0.01, 1, 50), // both rows land in the same column
      fakePrice(),
      b,
      { shape: 'line', color: '#0af', lineWidth: 1 },
    );
    expect(res!.columns).toBe(1);
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    expect(cmd.kind).toBe('polyline');
    // two vertices + a gap = 6 floats
    expect(cmd.points.length).toBe(6);
    // top (price 30) = 970, bottom (price 10) = 990
    expect(cmd.points[1]).toBeCloseTo(970);
    expect(cmd.points[3]).toBeCloseTo(990);
    expect(Number.isNaN(cmd.points[4]!)).toBe(true);
  });

  test('barlike shape emits a 1-px-wide hi–lo quad per column', () => {
    const store = fakeStore([10], [40]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 1),
      frame(50, 1),
      horz(0.01, 0, 50),
      fakePrice(),
      b,
      { shape: 'barlike', color: '#f50' },
    );
    expect(res!.columns).toBe(1);
    const cmd = b.finish()[0]!.commands[0] as RectsCommand;
    expect(cmd.kind).toBe('rects');
    expect(cmd.coords.length).toBe(4);
    expect(cmd.coords[1]).toBeCloseTo(960); // 1000 − 40
    expect(cmd.coords[3]).toBeCloseTo(30); // (1000−10) − (1000−40)
  });

  test('emits DEVICE-px geometry into the bitmap list when hr/vr ≠ 1 (perf §6.3)', () => {
    // With hr = vr = 2 the column is 1 device px wide and Y is scaled by 2.
    const store = fakeStore([10], [40]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 1),
      frame(100, 2),
      horz(0.01, 0, 50),
      fakePrice(),
      b,
      { shape: 'barlike', color: '#f50' },
    );
    expect(res!.columns).toBe(1);
    const cmd = b.finish()[0]!.commands[0] as RectsCommand;
    expect(cmd.coords[1]).toBeCloseTo(1920); // (1000−40)·2
    expect(cmd.coords[2]).toBe(1);
    expect(cmd.coords[3]).toBeCloseTo(60); // ((1000−10)−(1000−40))·2
  });

  test('skips NaN (gap/whitespace) rows', () => {
    const store = fakeStore([NaN, 20, NaN], [NaN, 25, NaN]);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(
      store,
      itemWindow(0, 3),
      frame(50, 1),
      horz(0.01, 1, 50),
      fakePrice(),
      b,
      { shape: 'line', color: '#0af' },
    );
    expect(res!.rowsScanned).toBe(1);
    expect(res!.columns).toBe(1);
  });
});
