import { describe, expect, test } from 'vitest';
import { FormattedLabelsCache } from './labels-cache';

describe('FormattedLabelsCache — true Map-reinsertion LRU', () => {
  test('computes on miss, returns the cached string on hit', () => {
    let calls = 0;
    const c = new FormattedLabelsCache<number>((k) => {
      calls++;
      return `v${k}`;
    });
    expect(c.format(1)).toBe('v1');
    expect(c.format(1)).toBe('v1');
    expect(calls).toBe(1);
  });

  test('a hit refreshes recency, so the re-used key survives eviction (LRU, not FIFO)', () => {
    const computed: number[] = [];
    const c = new FormattedLabelsCache<number>((k) => {
      computed.push(k);
      return `v${k}`;
    }, 2);
    c.format(1);
    c.format(2);
    c.format(1); // hit refreshes 1
    c.format(3); // evicts 2
    expect(computed).toEqual([1, 2, 3]);
    c.format(1); // still cached
    expect(computed).toEqual([1, 2, 3]);
    c.format(2); // recomputed
    expect(computed).toEqual([1, 2, 3, 2]);
  });

  test('clear() drops everything (e.g. on a localization change)', () => {
    let calls = 0;
    const c = new FormattedLabelsCache<number>((k) => {
      calls++;
      return `v${k}`;
    });
    c.format(1);
    c.clear();
    c.format(1);
    expect(calls).toBe(2);
  });
});
