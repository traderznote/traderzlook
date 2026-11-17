import { describe, expect, test } from 'vitest';
import { createGridSource } from './grid';
import { LineStyle, ZBand } from '../../gfx';
import type { PolylineCommand, ViewFrame } from '../../gfx';
import type { GridOptions } from '../../model';

function frame(hr = 2, vr = 2, mw = 100, mh = 80): ViewFrame {
  return {
    frame: { mediaSize: { width: mw, height: mh }, bitmapSize: { width: mw * hr, height: mh * vr }, hr, vr },
    now: 0,
  };
}

function gridOptions(over: Partial<GridOptions> = {}): GridOptions {
  return {
    vertLines: { color: '#aaa', visible: true },
    horzLines: { color: '#bbb', visible: true },
    ...over,
  };
}

function polylines(lists: readonly { space: string; commands: readonly { kind: string }[] }[]): PolylineCommand[] {
  return lists.flatMap((l) => l.commands.filter((c) => c.kind === 'polyline')) as PolylineCommand[];
}

describe('grid — SceneSource contract (design 01 §6)', () => {
  test('registers in band Grid', () => {
    expect(createGridSource(gridOptions()).zBand).toBe(ZBand.Grid);
  });

  test('no ticks fed → empty display lists (nothing to draw)', () => {
    const g = createGridSource(gridOptions());
    g.update(frame());
    expect(g.displayLists()).toHaveLength(0);
  });

  test('a CLEAN source returns the byte-IDENTICAL cached array (perf §4.4.2)', () => {
    const g = createGridSource(gridOptions());
    g.setTicks([10, 20], [5]);
    g.update(frame());
    const a = g.displayLists();
    g.update(frame());
    const b = g.displayLists();
    expect(b).toBe(a);
  });

  test('setTicks dirties → next update maps to a NEW array', () => {
    const g = createGridSource(gridOptions());
    g.setTicks([10], [5]);
    g.update(frame());
    const a = g.displayLists();
    g.setTicks([10, 30], [5]);
    g.update(frame());
    expect(g.displayLists()).not.toBe(a);
  });

  test('a change in crisp inputs (hr/bitmap size) re-emits even without setTicks', () => {
    const g = createGridSource(gridOptions());
    g.setTicks([10], [5]);
    g.update(frame(2, 2));
    const a = g.displayLists();
    g.update(frame(3, 2));
    expect(g.displayLists()).not.toBe(a);
  });
});

describe('grid — vertical lines (study 05 §4.4 crisp; design 03 §8.5.7)', () => {
  test('one bitmap polyline; per tick a crisp X spanning full height ±overdraw', () => {
    const g = createGridSource(gridOptions({ horzLines: { color: '#bbb', visible: false } }));
    g.setTicks([10, 25], []);
    g.update(frame(2, 2, 100, 80)); // bitmap 200×160
    const lists = g.displayLists();
    expect(lists).toHaveLength(1);
    expect(lists[0]!.space).toBe('bitmap');
    const polys = polylines(lists);
    expect(polys).toHaveLength(1);
    const p = polys[0]!;
    // width 2 is even, so no half-pixel shift; overdraw = width = 2
    expect(p.width).toBe(2);
    expect(p.style).toBe(LineStyle.Solid);
    expect(Array.from(p.points)).toEqual([
      20, -2, 20, 162, NaN, NaN, // X=10 line top/bottom/gap
      50, -2, 50, 162, NaN, NaN, // X=25 line
    ]);
    expect(p.runs).toHaveLength(1);
    expect(p.runs[0]!.count).toBe(6);
    expect(p.runs[0]!.fill).toBe('#aaa');
  });

  test('odd line width applies the +0.5 half-pixel shift (crispStrokePos)', () => {
    const g = createGridSource(gridOptions({ horzLines: { color: '#bbb', visible: false } }));
    g.setTicks([10], []);
    g.update(frame(1, 1, 100, 80));
    const p = polylines(g.displayLists())[0]!;
    expect(p.width).toBe(1);
    expect(p.points[0]).toBe(10.5);
    expect(p.points[1]).toBe(-1);
    expect(p.points[3]).toBe(81);
  });
});

describe('grid — horizontal lines', () => {
  test('per tick a crisp Y spanning full width ±overdraw', () => {
    const g = createGridSource(gridOptions({ vertLines: { color: '#aaa', visible: false } }));
    g.setTicks([], [5, 40]);
    g.update(frame(2, 2, 100, 80)); // bitmap 200×160
    const polys = polylines(g.displayLists());
    expect(polys).toHaveLength(1);
    const p = polys[0]!;
    expect(p.width).toBe(2);
    expect(Array.from(p.points)).toEqual([
      -2, 10, 202, 10, NaN, NaN, // Y=5 line left/right/gap
      -2, 80, 202, 80, NaN, NaN, // Y=40 line
    ]);
    expect(p.runs[0]!.fill).toBe('#bbb');
  });
});

describe('grid — both orientations + visibility (design 03 §8.5.7)', () => {
  test('both visible → ONE bitmap list with TWO polylines (vertical then horizontal)', () => {
    const g = createGridSource(gridOptions());
    g.setTicks([10], [5]);
    g.update(frame(2, 2, 100, 80));
    const lists = g.displayLists();
    expect(lists).toHaveLength(1);
    const polys = polylines(lists);
    expect(polys).toHaveLength(2);
    expect(polys[0]!.runs[0]!.fill).toBe('#aaa');
    expect(polys[1]!.runs[0]!.fill).toBe('#bbb');
  });

  test('a hidden side contributes no polyline; both hidden → empty lists', () => {
    const onlyVert = createGridSource(gridOptions({ horzLines: { color: '#bbb', visible: false } }));
    onlyVert.setTicks([10], [5]);
    onlyVert.update(frame());
    expect(polylines(onlyVert.displayLists())).toHaveLength(1);

    const none = createGridSource(gridOptions({ vertLines: { color: '#aaa', visible: false }, horzLines: { color: '#bbb', visible: false } }));
    none.setTicks([10], [5]);
    none.update(frame());
    expect(none.displayLists()).toHaveLength(0);
  });

  test('dash style passes through per side', () => {
    const g = createGridSource({
      vertLines: { color: '#aaa', visible: true, lineStyle: LineStyle.Dashed },
      horzLines: { color: '#bbb', visible: true },
    } as GridOptions);
    g.setTicks([10], [5]);
    g.update(frame());
    const polys = polylines(g.displayLists());
    expect(polys[0]!.style).toBe(LineStyle.Dashed);
    expect(polys[1]!.style).toBe(LineStyle.Solid);
  });
});
