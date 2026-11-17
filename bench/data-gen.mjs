// Seeded, deterministic series generators for the bench: every run sees identical bytes.
// Time is a plain integer index.

export const SEED = 0x7eadbeef;

/** mulberry32 PRNG: floats in [0, 1), identical on every platform (pure uint32 math). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Random walk with a weak pull back toward `base`, so even a 1e6-step walk stays bounded
// and autoscale ranges stay finite.
function* walk(rng, base, step) {
  let v = base;
  for (;;) {
    const drift = (rng() - 0.5) * step;
    const revert = (base - v) * 0.001;
    v += drift + revert;
    yield v;
  }
}

export function lineSeries(n, seed = SEED) {
  const w = walk(mulberry32(seed), 100, 2);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { time: i, value: w.next().value };
  return out;
}

/** open = previous close; high/low add a random wick so the body stays inside [low, high]. */
export function candleSeries(n, seed = SEED) {
  const rng = mulberry32(seed);
  const w = walk(rng, 100, 2);
  const out = new Array(n);
  let open = w.next().value;
  for (let i = 0; i < n; i++) {
    const close = w.next().value;
    const hi = Math.max(open, close) + rng() * 1.5;
    const lo = Math.min(open, close) - rng() * 1.5;
    out[i] = { time: i, open, high: hi, low: lo, close };
    open = close;
  }
  return out;
}

/** Non-negative, volume-like values. */
export function histogramSeries(n, seed = SEED) {
  const w = walk(mulberry32(seed), 50, 4);
  const out = new Array(n);
  for (let i = 0; i < n; i++) out[i] = { time: i, value: Math.abs(w.next().value) };
  return out;
}
