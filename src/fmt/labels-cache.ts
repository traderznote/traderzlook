// Lazy formatted-label cache: a true LRU via Map reinsertion, so a hit refreshes
// recency. Callers clear() it whenever localization/format options change.
export class FormattedLabelsCache<K> {
  readonly #map = new Map<K, string>();
  readonly #capacity: number;
  readonly #compute: (key: K) => string;

  constructor(compute: (key: K) => string, capacity = 50) {
    this.#compute = compute;
    this.#capacity = capacity;
  }

  format(key: K): string {
    const hit = this.#map.get(key);
    if (hit !== undefined) {
      this.#map.delete(key); // reinsert at the end → most-recently-used
      this.#map.set(key, hit);
      return hit;
    }
    const value = this.#compute(key);
    this.#map.set(key, value);
    if (this.#map.size > this.#capacity) {
      const oldest = this.#map.keys().next().value as K; // least-recently-used = first
      this.#map.delete(oldest);
    }
    return value;
  }

  clear(): void {
    this.#map.clear();
  }

  get size(): number {
    return this.#map.size;
  }
}
