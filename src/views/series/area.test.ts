import { describe, expect, test } from 'vitest';
import { createAreaKind } from './area';
import type { AreaItem, AreaPointColors } from './area';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder, HitPriority } from '../../gfx';
import type { AreaCommand, LinearGradientY, PolylineCommand, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
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

/** indexToCoordinate: ix 0→64, 1→74, 2→84, 3→94 (media px centres, barSpacing 10). */
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

function setup(values: number[], opts: Parameters<typeof createAreaKind>[0] = {}, h = horz()) {
  const { kind, buffer } = createAreaKind(opts);
  const store = fakeStore(values);
  kind.itemsFromStore(store, REPLACE, buffer);
  kind.convert(buffer, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf: buffer };
}

function emitLists(kind: ReturnType<typeof createAreaKind>['kind'], buf: ItemBuffer<AreaItem>) {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  return b.finish();
}

describe('area.emit — two lists, fill (media) then top line (bitmap)', () => {
  test('list 0 = media area fill with top→bottom LinearGradientY; list 1 = bitmap polyline top line', () => {
    const { kind, buf } = setup([10, 12]); // media (64,190),(74,188)
    const lists = emitLists(kind, buf);

    expect(lists).toHaveLength(2);
    expect(lists[0]!.space).toBe('media');
    expect(lists[1]!.space).toBe('bitmap');

    // media coords are unscaled and the fill closes to the pane height
    const area = lists[0]!.commands[0] as AreaCommand;
    expect(area.kind).toBe('area');
    expect(area.baseY).toBe(100);
    expect(Array.from(area.points)).toEqual([64, 190, 74, 188]);

    const g = area.fill as LinearGradientY;
    expect(g.from).toBe(0);
    expect(g.to).toBe(100);
    expect(g.stops).toHaveLength(2);
    expect(g.stops[0]).toEqual({ offset: 0, color: 'rgba( 46, 220, 135, 0.4)' });
    expect(g.stops[1]).toEqual({ offset: 1, color: 'rgba( 40, 221, 100, 0)' });

    // the top line is ×hr/vr, unrounded
    const poly = lists[1]!.commands[0] as PolylineCommand;
    expect(poly.kind).toBe('polyline');
    expect(poly.join).toBe('round');
    expect(poly.width).toBe(3 * 2); // lineWidth 3 · vr 2
    expect(Array.from(poly.points)).toEqual([128, 380, 148, 376]);
    expect(poly.runs).toHaveLength(1);
    expect(poly.runs[0]!.count).toBe(2);
    expect(poly.runs[0]!.fill).toBe('#33D778');
  });

  test('inverted fill closes to y=0; single point → one-bar-width stub centred', () => {
    const { kind, buf } = setup([10], { invertFilledArea: true });
    const lists = emitLists(kind, buf);
    const area = lists[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(0);
    // stub half-width = barSpacing/2 = 5 around x 64
    expect(Array.from(area.points)).toEqual([59, 190, 69, 190]);
    const poly = lists[1]!.commands[0] as PolylineCommand;
    expect(Array.from(poly.points)).toEqual([118, 380, 138, 380]);
  });
});

describe('area.emit — per-point colour split (adjoining area commands share the boundary vertex)', () => {
  test('a topColor change at index 1 splits the fill into two area commands sharing vertex 1', () => {
    const pointColors = (i: number): AreaPointColors | undefined =>
      i === 1 ? { topColor: '#abcdef' } : undefined;
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const lists = emitLists(kind, buf);
    const fill = lists[0]!.commands as AreaCommand[];

    // run A closes at the change vertex v1; run B re-emits v1 then v2
    expect(fill).toHaveLength(2);
    expect(Array.from(fill[0]!.points)).toEqual([64, 190, 74, 188]);
    expect(Array.from(fill[1]!.points)).toEqual([74, 188, 84, 189]);

    expect((fill[0]!.fill as LinearGradientY).stops[0]!.color).toBe('rgba( 46, 220, 135, 0.4)');
    expect((fill[1]!.fill as LinearGradientY).stops[0]!.color).toBe('#abcdef');

    // lineColor is uniform, so the top line stays one run
    const poly = lists[1]!.commands[0] as PolylineCommand;
    expect(poly.runs).toHaveLength(1);
    expect(poly.runs[0]!.count).toBe(3);
  });

  test('a per-point lineColor change splits the top-line polyline runs (segment-styling rule)', () => {
    const pointColors = (i: number): AreaPointColors | undefined =>
      i >= 1 ? { lineColor: '#ff0000' } : undefined;
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const poly = emitLists(kind, buf)[1]!.commands[0] as PolylineCommand;
    expect(poly.runs).toHaveLength(2);
    expect(poly.runs[0]!.fill).toBe('#33D778');
    expect(poly.runs[0]!.count).toBe(1);
    expect(poly.runs[1]!.fill).toBe('#ff0000');
    expect(poly.runs[1]!.count).toBe(2);
  });
});

describe('area.hitTest — Simple line geometry over the converted buffer', () => {
  test('cursor 3px above the segment midpoint → Line hit within radius', () => {
    const { kind, buf } = setup([10, 12]);
    const hit = kind.hitTest(buf, 69 as Coordinate, (189 - 3) as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Line);
    expect(hit!.distance).toBeLessThanOrEqual(4.5); // lineWidth/2 (1.5) + tolerance (3)
  });

  test('cursor far from the line → null', () => {
    const { kind, buf } = setup([10, 12]);
    expect(kind.hitTest(buf, 69 as Coordinate, 100 as Coordinate)).toBeNull();
  });

  test('single point stub is hittable across its bar-width span, reports Point priority', () => {
    const { kind, buf } = setup([10]); // stub spans x 59..69
    const hit = kind.hitTest(buf, 61 as Coordinate, 190 as Coordinate);
    expect(hit).not.toBeNull();
    expect(hit!.priority).toBe(HitPriority.Point);
    expect(hit!.distance).toBeCloseTo(0);
  });

  test('returns null on the decimated path — itemsFromStore without convert (buffer unfilled, §6.3)', () => {
    const { kind, buffer } = createAreaKind({});
    kind.itemsFromStore(fakeStore([10, 11, 12]), REPLACE, buffer);
    // Without convert the lanes are zeroed and the window is empty, so there must be
    // no false hit on the zeroed lanes.
    expect(kind.hitTest(buffer, 0 as Coordinate, 0 as Coordinate)).toBeNull();
    expect(kind.hitTest(buffer, 64 as Coordinate, 190 as Coordinate)).toBeNull();
  });
});
