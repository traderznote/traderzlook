// Non-time horizontal-scale behaviors: a price-level x axis and a yield-curve (tenor) x
// axis. Pass one to `createChartWith(container, backend, behavior, ...)`.
import type { HorzKey } from '../../core';
import type { HorzPoint, HorzScaleOptionGroups, IHorzScaleBehavior } from '../../api';

// The tick engine only compares weights, so a behavior may coin its own bands: a larger
// weight is a rounder, more prominent tick.
const PRICE_WEIGHT = {
  Fraction: 5,
  Unit: 10,
  Ten: 20,
  Hundred: 30,
  Thousand: 40,
  TenThousand: 50,
} as const;

/** Largest power-of-ten boundary `v` crosses relative to `prev`, as a weight. */
function priceWeight(v: number, prev: number): number {
  if (Math.floor(v / 10000) !== Math.floor(prev / 10000)) return PRICE_WEIGHT.TenThousand;
  if (Math.floor(v / 1000) !== Math.floor(prev / 1000)) return PRICE_WEIGHT.Thousand;
  if (Math.floor(v / 100) !== Math.floor(prev / 100)) return PRICE_WEIGHT.Hundred;
  if (Math.floor(v / 10) !== Math.floor(prev / 10)) return PRICE_WEIGHT.Ten;
  if (Math.floor(v) !== Math.floor(prev)) return PRICE_WEIGHT.Unit;
  return v !== prev ? PRICE_WEIGHT.Fraction : 0;
}

/**
 * A horizontal scale whose items are price levels. Labels use `precision` decimals,
 * or the `localization.priceFormatter` when set.
 */
export function priceAxisBehavior(options?: { precision?: number }): IHorzScaleBehavior<number, number> {
  const precision = options?.precision ?? 2;
  return numberBehavior({
    weightOf: priceWeight,
    label: (v) => v.toFixed(precision),
    augment: (defaults): void => {
      defaults.localization.dateFormat = '';
    },
  });
}

const TENOR_WEIGHT = {
  Day: 10,
  Week: 20,
  Month: 30,
  Year: 40,
} as const;

function tenorWeight(v: number, prev: number): number {
  if (Math.floor(v / 365) !== Math.floor(prev / 365)) return TENOR_WEIGHT.Year;
  if (Math.floor(v / 30) !== Math.floor(prev / 30)) return TENOR_WEIGHT.Month;
  if (Math.floor(v / 7) !== Math.floor(prev / 7)) return TENOR_WEIGHT.Week;
  return v !== prev ? TENOR_WEIGHT.Day : 0;
}

/** Render a tenor in days as `1Y`, `6M`, `2W` or `30D`. */
function formatTenor(days: number): string {
  if (days >= 365 && days % 365 === 0) return `${days / 365}Y`;
  if (days >= 30 && days % 30 === 0) return `${days / 30}M`;
  if (days >= 7 && days % 7 === 0) return `${days / 7}W`;
  return `${days}D`;
}

/** A horizontal scale whose items are days-to-maturity, labelled `1Y`/`6M`/`30D`. */
export function yieldCurveBehavior(): IHorzScaleBehavior<number, number> {
  return numberBehavior({
    weightOf: tenorWeight,
    label: formatTenor,
    augment: (defaults): void => {
      defaults.localization.dateFormat = '';
    },
  });
}

interface NumberBehaviorInit {
  weightOf(v: number, prev: number): number;
  label(v: number): string;
  augment(defaults: HorzScaleOptionGroups<number>): void;
}

function numberBehavior(init: NumberBehaviorInit): IHorzScaleBehavior<number, number> {
  return {
    // The value is already sortable, so it is its own key.
    key: (item) => item as unknown as HorzKey,
    fromKey: (key) => key as unknown as number,
    cacheKey: (item) => item,
    toInternal: () => (item) => item,
    formatItem: (item, loc) =>
      loc.priceFormatter !== undefined ? loc.priceFormatter(item) : init.label(item),
    formatTick: (item, _weight, loc) =>
      loc.priceFormatter !== undefined ? loc.priceFormatter(item) : init.label(item),
    fillWeights: (points: readonly HorzPoint<number>[], startIndex: number): void => {
      const n = points.length;
      if (n === 0) return;
      let prev: number | null = startIndex > 0 ? points[startIndex - 1]!.item : null;
      for (let i = startIndex; i < n; i++) {
        const cur = points[i]!.item;
        // The first point has no predecessor; weigh it against cur - 1 so it still labels.
        points[i]!.weight = prev === null ? init.weightOf(cur, cur - 1) : init.weightOf(cur, prev);
        prev = cur;
      }
    },
    maxTickWeight: (weights: readonly number[]): number => {
      let max = 0;
      for (const w of weights) if (w > max) max = w;
      return max;
    },
    augmentDefaults: init.augment,
  };
}
