import { describe, expect, test } from 'vitest';
import { createPriceGeometry } from './geometry';
import {
  PriceScaleMode,
  toLog,
  fromLog,
  defaultLogFormula,
  toPercent,
  fromPercent,
  toIndexed,
  fromIndexed,
} from './modes';

const BASE = {
  height: 100,
  range: { min: 0, max: 10 },
  scaleMargins: { top: 0.2, bottom: 0.1 },
  marginAbovePx: 0,
  marginBelowPx: 0,
  mode: PriceScaleMode.Normal,
  inverted: false,
  logFormula: defaultLogFormula(),
} as const;

describe('PriceGeometry — unified margins (architecture §4.6)', () => {
  test('marginNearMaxLogical = top·H + marginAbovePx; near-min = bottom·H + marginBelowPx', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    expect(g.marginNearMaxLogical).toBeCloseTo(23, 12);
    expect(g.marginNearMinLogical).toBeCloseTo(17, 12);
  });

  test('non-inverted: topMarginPx = near-max, bottomMarginPx = near-min', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    expect(g.topMarginPx).toBeCloseTo(23, 12);
    expect(g.bottomMarginPx).toBeCloseTo(17, 12);
  });

  test('inverted: the SAME two magnitudes swap orientation (single inversion rule)', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7, inverted: true });
    expect(g.marginNearMaxLogical).toBeCloseTo(23, 12);
    expect(g.marginNearMinLogical).toBeCloseTo(17, 12);
    expect(g.topMarginPx).toBeCloseTo(17, 12);
    expect(g.bottomMarginPx).toBeCloseTo(23, 12);
  });

  test('internal height h = H − topMarginPx − bottomMarginPx (orientation-independent)', () => {
    const a = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7 });
    const b = createPriceGeometry({ ...BASE, marginAbovePx: 3, marginBelowPx: 7, inverted: true });
    expect(a.internalHeight).toBeCloseTo(60, 12);
    expect(b.internalHeight).toBeCloseTo(60, 12);
  });

  test('option margins add the pixel autoscale margins (study 04 §5)', () => {
    const g = createPriceGeometry({ ...BASE, marginAbovePx: 10, marginBelowPx: 0 });
    expect(g.marginNearMaxLogical).toBeCloseTo(0.2 * 100 + 10, 12);
  });
});

describe('PriceGeometry — Normal-mode conversions (study 04 §4.4)', () => {
  test('logical-min sits at invCoord = bottomMarginPx (bottom of band)', () => {
    const g = createPriceGeometry(BASE);
    // bottomMarginPx = 10, h = 70: inv(min) = 10 → coord = 99 − 10
    expect(g.logicalToCoordinate(0)).toBeCloseTo(89, 9);
  });

  test('logical-max sits at invCoord = bottomMarginPx + (h−1) (top of band)', () => {
    const g = createPriceGeometry(BASE);
    // inv(max) = 10 + 69 → coord = 99 − 79
    expect(g.logicalToCoordinate(10)).toBeCloseTo(20, 9);
  });

  test('coordinateToLogical is the exact inverse of logicalToCoordinate', () => {
    const g = createPriceGeometry(BASE);
    for (const l of [0, 2.5, 5, 7.25, 10]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(l))).toBeCloseTo(l, 6);
    }
  });

  test('inverted flips orientation: logical-min now sits near the top', () => {
    const g = createPriceGeometry({ ...BASE, inverted: true });
    // inverted bottomMarginPx = near-max = 20, and coord = inv
    expect(g.logicalToCoordinate(0)).toBeCloseTo(20, 9);
    expect(g.coordinateToLogical(g.logicalToCoordinate(7.5))).toBeCloseTo(7.5, 6);
  });
});

describe('PriceGeometry — log-mode conversions (study 04 §4.3/§4.4)', () => {
  const LOG = {
    ...BASE,
    range: { min: toLog(10), max: toLog(1000) },
    mode: PriceScaleMode.Logarithmic,
  };

  test('logicalToCoordinate applies toLog to a non-zero raw price first', () => {
    const g = createPriceGeometry(LOG);
    const linear = createPriceGeometry({ ...LOG, mode: PriceScaleMode.Normal });
    expect(g.logicalToCoordinate(100)).toBeCloseTo(linear.logicalToCoordinate(toLog(100)), 6);
  });

  test('coordinateToLogical returns raw price (fromLog applied)', () => {
    const g = createPriceGeometry(LOG);
    const coord = g.logicalToCoordinate(100);
    expect(g.coordinateToLogical(coord)).toBeCloseTo(100, 4);
  });

  test('round-trips a raw price through coordinate space in log mode', () => {
    const g = createPriceGeometry(LOG);
    for (const p of [12, 50, 100, 500, 999]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(p))).toBeCloseTo(p, 3);
    }
  });

  test('uses the supplied (dynamic) log formula for tiny ranges', () => {
    const formula = { logicalOffset: 6, coordOffset: 1e-6 };
    const g = createPriceGeometry({
      ...BASE,
      mode: PriceScaleMode.Logarithmic,
      range: { min: toLog(5.0, formula), max: toLog(5.01, formula) },
      logFormula: formula,
    });
    const coord = g.logicalToCoordinate(5.005);
    expect(g.coordinateToLogical(coord)).toBeCloseTo(5.005, 6);
    expect(fromLog(toLog(5.005, formula), formula)).toBeCloseTo(5.005, 9);
  });
});

describe('PriceGeometry — empty scale (study 04 §5)', () => {
  test('height 0 → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, height: 0 });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
    expect(g.coordinateToLogical(50)).toBe(0);
  });

  test('null range → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: null });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });

  test('min == max → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: { min: 5, max: 5 } });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });

  test('NaN bound → conversions return 0', () => {
    const g = createPriceGeometry({ ...BASE, range: { min: Number.NaN, max: 10 } });
    expect(g.isEmpty).toBe(true);
    expect(g.logicalToCoordinate(5)).toBe(0);
  });
});

describe('PriceGeometry — percent/indexed map linearly (study 04 §4.4)', () => {
  const PCT = {
    ...BASE,
    range: { min: toPercent(90, 100), max: toPercent(110, 100) },
    mode: PriceScaleMode.Percentage,
  };

  test('percent/indexed geometry does NOT apply a log transform', () => {
    const g = createPriceGeometry(PCT);
    const linear = createPriceGeometry({ ...PCT, mode: PriceScaleMode.Normal });
    expect(g.logicalToCoordinate(5)).toBeCloseTo(linear.logicalToCoordinate(5), 12);
  });

  test('geometry round-trips a percent logical value exactly', () => {
    const g = createPriceGeometry(PCT);
    for (const l of [-10, -3.5, 0, 7.25, 10]) {
      expect(g.coordinateToLogical(g.logicalToCoordinate(l))).toBeCloseTo(l, 6);
    }
  });
});

// The public path is fromMode(coordinateToLogical(logicalToCoordinate(toMode(price, base)))),
// which must be the identity for either sign of base.
describe('PriceGeometry — negative-base price⇄coord composes to identity (§13.10 FIX)', () => {
  test('indexed mode: price → coord → price is identity for a NEGATIVE base', () => {
    const base = -100;
    const range = { min: toIndexed(-110, base), max: toIndexed(-90, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    for (const price of [-110, -100, -97.5, -92.25, -90]) {
      const coord = g.logicalToCoordinate(toIndexed(price, base));
      const back = fromIndexed(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('indexed mode: same path for a POSITIVE base (parity with the positive case)', () => {
    const base = 100;
    const range = { min: toIndexed(90, base), max: toIndexed(110, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    for (const price of [90, 100, 102.5, 110]) {
      const coord = g.logicalToCoordinate(toIndexed(price, base));
      const back = fromIndexed(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('percentage mode: negative-base price → coord → price is identity (no jump)', () => {
    const base = -100;
    const range = { min: toPercent(-110, base), max: toPercent(-90, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.Percentage });
    for (const price of [-110, -100, -95.5, -90]) {
      const coord = g.logicalToCoordinate(toPercent(price, base));
      const back = fromPercent(g.coordinateToLogical(coord), base);
      expect(back).toBeCloseTo(price, 6);
    }
  });

  test('negative-base indexed does NOT drift by 2·base through the full path', () => {
    const base = -100;
    const price = -90;
    const range = { min: toIndexed(-110, base), max: toIndexed(-80, base) };
    const g = createPriceGeometry({ ...BASE, range, mode: PriceScaleMode.IndexedTo100 });
    const back = fromIndexed(g.coordinateToLogical(g.logicalToCoordinate(toIndexed(price, base))), base);
    expect(back).toBeCloseTo(price, 6);
    expect(back).not.toBeCloseTo(price + 2 * base, 4);
  });
});
