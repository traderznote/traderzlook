// Area emission edge cases: the gradient bottom is always the pane height (even when
// inverted), a colour change on the last item emits no degenerate area, and a NaN gap
// drops a pending boundary share.
import { describe, expect, test } from 'vitest';
import { createAreaKind } from './area';
import type { AreaItem, AreaPointColors } from './area';
import { itemWindow } from './window';
import type { ItemBuffer } from './buffer';
import { DisplayListBuilder } from '../../gfx';
import type { AreaCommand, LinearGradientY, ViewFrame } from '../../gfx';
import { createHorzGeometry } from '../../model';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { TimeIndex } from '../../core';

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
  return { priceToCoordinate: (p) => 200 - p, firstValue: null, mode: 'normal', toLogical: (p) => p };
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
  kind.itemsFromStore(fakeStore(values), REPLACE, buffer);
  kind.convert(buffer, itemWindow(0, values.length), frame(), h, fakePrice());
  return { kind, buf: buffer };
}

function emitLists(kind: ReturnType<typeof createAreaKind>['kind'], buf: ItemBuffer<AreaItem>) {
  const b = new DisplayListBuilder();
  kind.emit(buf, itemWindow(0, buf.length), frame(), b);
  return b.finish();
}

const grad = (a: AreaCommand): LinearGradientY => a.fill as LinearGradientY;

describe('area.emit — fill gradient spans topCoordinate → paneHeight, NOT baseY (study 06 §4.6)', () => {
  test('non-inverted: polygon baseY === paneHeight === gradient.to (they coincide here)', () => {
    const { kind, buf } = setup([10, 12]);
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(100);
    const g = grad(area);
    expect(g.from).toBe(0);
    expect(g.to).toBe(100);
  });

  test('INVERTED: polygon closes UP to 0, but the gradient STILL spans 0 → paneHeight', () => {
    const { kind, buf } = setup([10, 12], { invertFilledArea: true });
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(0);
    const g = grad(area);
    expect(g.from).toBe(0);
    expect(g.to).toBe(100);
    expect(g.from).not.toBe(g.to);
  });

  test('INVERTED single point: same — stub closes to 0, gradient to paneHeight', () => {
    const { kind, buf } = setup([10], { invertFilledArea: true });
    const area = emitLists(kind, buf)[0]!.commands[0] as AreaCommand;
    expect(area.baseY).toBe(0);
    expect(grad(area).to).toBe(100);
  });

  test('relativeGradient + inverted: top = min visible y, bottom STILL paneHeight', () => {
    // y = 190, 186 → top 186. For an inverted chart top may sit below bottom; only the
    // coordinates are asserted here.
    const { kind, buf } = setup([10, 14], { invertFilledArea: true, relativeGradient: true });
    const g = grad(emitLists(kind, buf)[0]!.commands[0] as AreaCommand);
    expect(g.from).toBe(186);
    expect(g.to).toBe(100);
  });

  test('inverted does not change the per-point split gradient bottoms', () => {
    const pointColors = (i: number): AreaPointColors | undefined => (i === 1 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors, invertFilledArea: true });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];
    expect(fill).toHaveLength(2);
    expect(grad(fill[0]!).to).toBe(100);
    expect(grad(fill[1]!).to).toBe(100);
    expect(fill[0]!.baseY).toBe(0);
    expect(fill[1]!.baseY).toBe(0);
  });
});

describe('area.emit — guarded final flush (no degenerate single-vertex area, study 06 §4.4)', () => {
  test('a topColor change on the LAST item closes the prior run and emits NO 1-vertex area', () => {
    // The change closes run A at v2 and defers v2 as the next anchor; with no further
    // item that lone boundary vertex must be dropped.
    const pointColors = (i: number): AreaPointColors | undefined => (i === 2 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];

    expect(fill).toHaveLength(1);
    expect(Array.from(fill[0]!.points)).toEqual([64, 190, 74, 188, 84, 189]);
    expect(grad(fill[0]!).stops[0]!.color).toBe('rgba( 46, 220, 135, 0.4)');
  });

  test('a colour change one item before the last still splits into two real areas', () => {
    const pointColors = (i: number): AreaPointColors | undefined => (i === 1 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, 12, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];
    expect(fill).toHaveLength(2);
    expect(fill[0]!.points.length).toBe(4); // v0, v1
    expect(fill[1]!.points.length).toBe(4); // shared v1, v2
  });
});

describe('area.emit — NaN gap drops a pending colour-boundary share (no continuation)', () => {
  test('NaN at index 1 then a topColor change at index 2 opens a fresh run at v2', () => {
    // The gap closes run A (just v0) without a share, so run B opens fresh at v2.
    const pointColors = (i: number): AreaPointColors | undefined => (i === 2 ? { topColor: '#abcdef' } : undefined);
    const { kind, buf } = setup([10, NaN, 11], { pointColors });
    const fill = emitLists(kind, buf)[0]!.commands as AreaCommand[];

    expect(fill).toHaveLength(2);
    expect(Array.from(fill[0]!.points)).toEqual([64, 190]);
    expect(grad(fill[0]!).stops[0]!.color).toBe('rgba( 46, 220, 135, 0.4)');
    expect(Array.from(fill[1]!.points)).toEqual([84, 189]);
    expect(grad(fill[1]!).stops[0]!.color).toBe('#abcdef');
  });
});
