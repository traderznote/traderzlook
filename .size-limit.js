// Bundle-size budgets (brotli-compressed), measured on the published build (scripts/build.mjs).
export default [
  // Covers validation, multi-series autoscale, magnet, kinetic scroll, animations, axis and
  // crosshair labels, events and the scale APIs. See KNOWN-ISSUES.md.
  {
    name: "E1 — import * from 'traderzlook' (root)",
    path: 'dist/index.mjs',
    limit: '42 KB',
    brotli: true,
  },
  {
    name: 'E5 — traderzlook/gfx subpath',
    path: 'dist/gfx.mjs',
    limit: '4 KB',
    brotli: true,
  },
  // Each plugin is its own bundle so its cap measures only its marginal cost.
  {
    name: 'extras/series-markers',
    path: 'dist/extras/series-markers.mjs',
    limit: '3 KB',
    brotli: true,
  },
  {
    name: 'extras/up-down-markers',
    path: 'dist/extras/up-down-markers.mjs',
    limit: '2 KB',
    brotli: true,
  },
  {
    name: 'extras/text-watermark',
    path: 'dist/extras/text-watermark.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  {
    name: 'extras/image-watermark',
    path: 'dist/extras/image-watermark.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  {
    name: 'extras/tool-host',
    path: 'dist/extras/tool-host.mjs',
    limit: '3 KB',
    brotli: true,
  },
  {
    name: 'extras/sync-group',
    path: 'dist/extras/sync-group.mjs',
    limit: '1 KB',
    brotli: true,
  },
  {
    name: 'extras/ema',
    path: 'dist/extras/ema.mjs',
    limit: '1 KB',
    brotli: true,
  },
  {
    name: 'extras/price-axis',
    path: 'dist/extras/price-axis.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
  {
    name: 'extras/yield-curve',
    path: 'dist/extras/yield-curve.mjs',
    limit: '1.5 KB',
    brotli: true,
  },
];
