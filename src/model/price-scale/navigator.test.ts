import { describe, expect, test } from 'vitest';
import { PriceScaleMode } from './modes';
import { PriceNavigator } from './navigator';

const make = (over?: Partial<ConstructorParameters<typeof PriceNavigator>[0]>): PriceNavigator =>
  new PriceNavigator({
    range: { min: 0, max: 100 },
    autoScale: false,
    mode: PriceScaleMode.Normal,
    inverted: false,
    height: 100,
    ...over,
  });

describe('PriceNavigator — scale (study 04 §4.8)', () => {
  test('scaleTo with no start is a no-op', () => {
    const nav = make();
    nav.scaleTo(50);
    expect(nav.range()).toEqual({ min: 0, max: 100 });
  });

  test('the first scale move pins the range (autoScale → false)', () => {
    const nav = make({ autoScale: true });
    nav.startScale(0);
    nav.scaleTo(50);
    expect(nav.isAutoScale()).toBe(false);
  });

  test('zoom-in is capped at 10× by the 0.1 coeff floor', () => {
    const nav = make();
    nav.startScale(200);
    nav.scaleTo(0);
    const r = nav.range()!;
    expect(r.min).toBeCloseTo(45, 6);
    expect(r.max).toBeCloseTo(55, 6);
  });

  test('zoom-out is unbounded (range widens past the original)', () => {
    const nav = make();
    nav.startScale(0);
    nav.scaleTo(100);
    const r = nav.range()!;
    expect(r.max - r.min).toBeGreaterThan(100);
    expect((r.min + r.max) / 2).toBeCloseTo(50, 6);
  });

  test('Percentage / Indexed-to-100 refuse every scale entry point', () => {
    for (const mode of [PriceScaleMode.Percentage, PriceScaleMode.IndexedTo100]) {
      const nav = make({ mode });
      nav.startScale(0);
      nav.scaleTo(100);
      nav.endScale();
      expect(nav.range()).toEqual({ min: 0, max: 100 });
    }
  });
});

describe('PriceNavigator — scroll (study 04 §3.3/§4.8)', () => {
  test('scroll shifts the range by Δpx · length/(h−1) and force-sets it', () => {
    const nav = make();
    nav.startScroll(50);
    nav.scrollTo(60);
    const r = nav.range()!;
    expect(r.min).toBeCloseTo(10 * (100 / 99), 6);
    expect(r.max).toBeCloseTo(100 + 10 * (100 / 99), 6);
  });

  test('inverted flips the scroll sign', () => {
    const nav = make({ inverted: true });
    nav.startScroll(50);
    nav.scrollTo(60);
    const r = nav.range()!;
    expect(r.min).toBeCloseTo(-10 * (100 / 99), 6);
  });

  test('scroll is a no-op while autoScale is on', () => {
    const nav = make({ autoScale: true });
    nav.startScroll(50);
    nav.scrollTo(60);
    expect(nav.range()).toEqual({ min: 0, max: 100 });
  });
});

describe('PriceNavigator — the shared snapshot slot blocks the other gesture', () => {
  test('a scroll in progress blocks a scale start', () => {
    const nav = make();
    nav.startScroll(50);
    nav.startScale(50);
    nav.scaleTo(0);
    expect(nav.range()).toEqual({ min: 0, max: 100 });
  });

  test('a scale in progress blocks a scroll start', () => {
    const nav = make();
    nav.startScale(50);
    nav.startScroll(50);
    nav.scrollTo(60);
    expect(nav.range()).toEqual({ min: 0, max: 100 });
  });
});
