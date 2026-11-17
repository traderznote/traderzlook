function boundSearch<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  lower: boolean,
  start: number,
  to: number,
): number {
  let count = to - start;
  while (count > 0) {
    const half = count >> 1;
    const mid = start + half;
    if (compare(arr[mid], value) === lower) {
      start = mid + 1;
      count -= half + 1;
    } else {
      count = half;
    }
  }
  return start;
}

/**
 * First index in `[start, to)` whose element is NOT `< value` (first of any equal run).
 * `compare(item, value)` must return `item < value`.
 */
export function lowerBound<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  start = 0,
  to: number = arr.length,
): number {
  return boundSearch(arr, value, compare, true, start, to);
}

/**
 * First index in `[start, to)` whose element IS `> value` (just past any equal run).
 * `compare(item, value)` must return `item > value`.
 */
export function upperBound<T, V>(
  arr: ArrayLike<T>,
  value: V,
  compare: (item: T, value: V) => boolean,
  start = 0,
  to: number = arr.length,
): number {
  return boundSearch(arr, value, compare, false, start, to);
}
