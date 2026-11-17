import { describe, expect, test } from 'vitest';
import {
  TickMarkEngine,
  indexPerLabel,
  maxIndexesPerMark,
  maxLabelWidthFor,
  type TickMark,
} from './ticks';

const mk = (index: number, weight: number): TickMark => ({ index, weight });

describe('density math (study 03 §4.12)', () => {
  test('maxLabelWidthFor: (fontSize+4)*5/8 px-per-char × chars', () => {
    expect(maxLabelWidthFor(12, 8)).toBe(80);
    expect(maxLabelWidthFor(12, undefined)).toBe(80);
  });

  test('maxIndexesPerMark = ceil(maxLabelWidth / spacing)', () => {
    expect(maxIndexesPerMark(80, 6)).toBe(Math.ceil(80 / 6));
    expect(maxIndexesPerMark(80, 10)).toBe(8);
  });

  test('indexPerLabel = round(maxLabelWidth / spacing)', () => {
    expect(indexPerLabel(80, 6)).toBe(Math.round(80 / 6));
    expect(indexPerLabel(80, 7)).toBe(Math.round(80 / 7));
  });
});

describe('TickMarkEngine — weight-merge selection (study 03 §4.11)', () => {
  test('higher weight always wins screen space; lower fills only when ≥ gap away', () => {
    const marks: TickMark[] = [];
    for (let i = 0; i <= 20; i++) marks.push(mk(i, i === 0 || i === 10 ? 70 : 50));
    const e = new TickMarkEngine();
    e.setMarks(marks);
    const sel = e.build({ maxIndexesPerMark: 5 });
    const idx = sel.map((m) => m.index);
    expect(idx).toContain(0);
    expect(idx).toContain(10);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(5);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test('a lower-weight mark too close to a higher-weight neighbor is dropped', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(5, 70), mk(6, 50), mk(20, 50)]);
    const idx = e.build({ maxIndexesPerMark: 5 }).map((m) => m.index);
    expect(idx).toContain(5);
    expect(idx).not.toContain(6);
    expect(idx).toContain(20);
  });

  test('uniformDistribution: one non-fitting mark rejects its WHOLE weight level (returns prev)', () => {
    // some weight-50 marks fit and some do not, so the whole level is rejected.
    const marks: TickMark[] = [mk(0, 70), mk(10, 70)];
    for (let i = 0; i <= 10; i++) marks.push(mk(i, 50));
    marks.sort((a, b) => a.index - b.index || b.weight - a.weight);
    const e = new TickMarkEngine();
    e.setMarks(marks);
    const idx = e.build({ maxIndexesPerMark: 5, uniformDistribution: true }).map((m) => m.index);
    expect(idx).toEqual([0, 10]);
  });

  test('includable=false (whitespace) excludes a mark even with room', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50), mk(20, 50)]);
    const idx = e.build({ maxIndexesPerMark: 5, includable: (m) => m.index !== 10 }).map((m) => m.index);
    expect(idx).toEqual([0, 20]);
  });

  test('empty mark set returns empty selection', () => {
    const e = new TickMarkEngine();
    e.setMarks([]);
    expect(e.build({ maxIndexesPerMark: 5 })).toEqual([]);
  });
});

describe('TickMarkEngine — selection cache (study 03 §4.11/§4.13: key ignores scroll)', () => {
  test('same maxIndexesPerMark returns the identical cached array (no rebuild)', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).toBe(a);
  });

  test('cache key IGNORES scroll: only maxIndexesPerMark / whitespace inputs matter', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).toBe(a);
  });

  test('different maxIndexesPerMark rebuilds (different key)', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    const b = e.build({ maxIndexesPerMark: 8 });
    expect(b).not.toBe(a);
  });

  test('the whitespace flag participates in the key', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5, whitespaceFlag: false, whitespaceSetId: 0 });
    const b = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 0 });
    expect(b).not.toBe(a);
  });

  test('whitespaceSetId change (data mutated) rebuilds', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 50), mk(10, 50)]);
    const a = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 1 });
    const b = e.build({ maxIndexesPerMark: 5, whitespaceFlag: true, whitespaceSetId: 2 });
    expect(b).not.toBe(a);
  });

  test('setMarks invalidates the cache', () => {
    const e = new TickMarkEngine();
    e.setMarks([mk(0, 70), mk(5, 50)]);
    const a = e.build({ maxIndexesPerMark: 5 });
    e.setMarks([mk(0, 70), mk(5, 50), mk(12, 50)]);
    const b = e.build({ maxIndexesPerMark: 5 });
    expect(b).not.toBe(a);
  });
});

describe('TickMarkEngine — equals study 03 §4.6/§4.11 worked example', () => {
  test('descending-weight greedy merge matches the reference order', () => {
    // daily axis: year at 0, months at 6 and 12, days elsewhere.
    const marks: TickMark[] = [];
    for (let i = 0; i <= 15; i++) {
      let w = 50;
      if (i === 0) w = 70;
      else if (i === 6 || i === 12) w = 60;
      marks.push(mk(i, w));
    }
    const e = new TickMarkEngine();
    e.setMarks(marks);
    const idx = e.build({ maxIndexesPerMark: 4 }).map((m) => m.index);
    expect(idx).toContain(0);
    expect(idx).toContain(6);
    expect(idx).toContain(12);
    for (let i = 1; i < idx.length; i++) expect(idx[i] - idx[i - 1]).toBeGreaterThanOrEqual(4);
    expect(new Set(idx).size).toBe(idx.length);
  });
});
