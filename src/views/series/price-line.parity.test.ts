// Price-line edge cases: the off-pane gate uses the crisp-rounded device y, the line
// spans exactly [0, bitmapWidth] with no overdraw, and crisp y is keyed on vr.
import { describe, expect, test } from 'vitest';
import { createPriceLineSource } from './price-line';
import type { PriceLineState } from './price-line';
import { crispRound, crispStrokePos, crispWidth } from '../../gfx';
import type { DisplayList, PolylineCommand, ViewFrame } from '../../gfx';

function frame(hr = 2, vr = 2, w = 100, h = 100): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

function poly(lists: readonly DisplayList[]): PolylineCommand {
  for (const l of lists) for (const c of l.commands) if (c.kind === 'polyline') return c;
  throw new Error('no polyline');
}

const at = (y: number | null): PriceLineState => ({ y, barColor: '#abc123', text: '' });

describe('price-line — off-pane gate compares round(y·vpr) (study 06 §4.13 / §8.5.8)', () => {
  test('y whose raw ·vr is in (−0.5, 0) rounds to device 0 → ON-PANE, draws', () => {
    // raw −0.4 rounds to 0
    const src = createPriceLineSource(() => at(-0.2));
    src.update(frame(2, 2));
    const cmd = poly(src.displayLists());
    expect(cmd.points[1]).toBe(0);
    expect(cmd.points[3]).toBe(0);
  });

  test('y whose raw ·vr is in (bh, bh+0.5] rounds to bh → ON-PANE, draws', () => {
    // raw 200.4 rounds to bh = 200
    const src = createPriceLineSource(() => at(100.2));
    src.update(frame(2, 2));
    expect(poly(src.displayLists()).points[1]).toBe(200);
  });

  test('y rounding to −1 (raw ·vr ≤ −0.5) is still suppressed', () => {
    const src = createPriceLineSource(() => at(-0.3));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('y rounding past bh (raw ·vr > bh+0.5) is suppressed', () => {
    // raw 200.6 rounds to 201 > 200
    const src = createPriceLineSource(() => at(100.3));
    src.update(frame(2, 2));
    expect(src.displayLists()).toHaveLength(0);
  });

  test('exact top edge (y 0) and exact bottom edge (y == mediaHeight) both draw', () => {
    const top = createPriceLineSource(() => at(0));
    top.update(frame(2, 2));
    expect(top.displayLists()).toHaveLength(1);
    const bottom = createPriceLineSource(() => at(100));
    bottom.update(frame(2, 2));
    expect(bottom.displayLists()).toHaveLength(1);
  });
});

describe('price-line — full-width line spans exactly [0, bitmapWidth] (study 06 §4.13)', () => {
  test('the two vertices sit at x=0 and x=bitmapWidth (no ±lineWidth overdraw)', () => {
    // Unlike the grid, which overdraws its lines by ±lineWidth.
    const src = createPriceLineSource(() => at(30));
    src.update(frame(2, 2, 100, 100));
    const cmd = poly(src.displayLists());
    expect(cmd.points[0]).toBe(0);
    expect(cmd.points[2]).toBe(200);
  });

  test('a wider line still spans exactly [0, bitmapWidth] (width affects thickness only)', () => {
    const src = createPriceLineSource(() => at(30), { lineWidth: 3 });
    src.update(frame(2, 2, 100, 100));
    const cmd = poly(src.displayLists());
    expect(cmd.points[0]).toBe(0);
    expect(cmd.points[2]).toBe(200);
    expect(cmd.width).toBe(crispWidth(3, 2));
  });
});

describe('price-line — crisp y == crispStrokePos(y, vr, crispWidth(lineWidth, vr))', () => {
  test('even device width (DPR 2, lineWidth 1) → no +0.5 shift; y = round(y·vr)', () => {
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(2, 2));
    const w = crispWidth(1, 2);
    expect(poly(src.displayLists()).points[1]).toBe(crispStrokePos(y, 2, w));
  });

  test('odd device width (DPR 1, lineWidth 1) → +0.5 shift', () => {
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(1, 1));
    const w = crispWidth(1, 1);
    expect(poly(src.displayLists()).points[1]).toBe(crispStrokePos(y, 1, w));
  });

  test('the gate y (round(y·vr)) and the drawn y agree on the integer part (parity ref = vr)', () => {
    // A horizontal line's thickness/parity is keyed on vr; hr must not matter.
    const y = 30;
    const src = createPriceLineSource(() => at(y));
    src.update(frame(3, 2));
    const w = crispWidth(1, 2);
    const drawn = poly(src.displayLists()).points[1]!;
    expect(drawn).toBe(crispStrokePos(y, 2, w));
    expect(Math.trunc(drawn)).toBe(crispRound(y, 2));
  });
});
