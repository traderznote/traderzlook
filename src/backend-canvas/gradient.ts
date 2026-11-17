// Per-surface LRU of CanvasGradients. Gradient coords are list-space and part of the
// key, so a resize or zoom that moves `from`/`to` invalidates naturally.
import type { FillStyle, LinearGradientY } from '../gfx';

const CAPACITY = 16;

function isGradient(fill: FillStyle): fill is LinearGradientY {
  return typeof fill !== 'string';
}

function keyOf(g: LinearGradientY): string {
  let k = `${g.from}:${g.to}`;
  for (const s of g.stops) k += `:${s.offset},${s.color}`;
  return k;
}

export class GradientCache {
  // Map keeps insertion order: delete+set on a hit moves the entry to the end,
  // so the first key is always the least recently used.
  readonly #cache = new Map<string, CanvasGradient>();

  resolve(fill: FillStyle, ctx: CanvasRenderingContext2D): string | CanvasGradient {
    if (!isGradient(fill)) return fill;
    const key = keyOf(fill);
    const hit = this.#cache.get(key);
    if (hit !== undefined) {
      this.#cache.delete(key);
      this.#cache.set(key, hit);
      return hit;
    }
    const grad = ctx.createLinearGradient(0, fill.from, 0, fill.to);
    for (const s of fill.stops) grad.addColorStop(s.offset, s.color);
    this.#cache.set(key, grad);
    if (this.#cache.size > CAPACITY) {
      const oldest = this.#cache.keys().next().value as string;
      this.#cache.delete(oldest);
    }
    return grad;
  }

  clear(): void {
    this.#cache.clear();
  }
}
