# Known issues — Traderzlook

- **Bundle size budget.**
  - The root bundle is about 41.8 KB brotli against a 42 KB budget.
  - Lower the target by trimming `api/create-chart.ts` (17 KB minified, the largest file).
- **Tests are not type-checked.**
  - Every `tsconfig.composite.json` excludes `*.test.ts`, and several older tests have type errors.
  - A test tsconfig would close this.
- **`pane.addSeries()` and `pane.series()` return a minimal series type.** Returning the full `ISeries` would create a type-import cycle that the import rules forbid. `chart.addSeries(def, options, paneIndex)` is fully typed.
- **Browser-only gates run in CI only.** The conformance suite and frame-time bench skip locally when Playwright's Chromium isn't installed.
- **Not drawn:**
  - the price-axis border (`borderVisible`)
  - axis tick marks (`ticksVisible`)
  - the price-line `title` text inside the pane
- **The package is private.** `package.json` has `"private": true`, so `npm install traderzlook` doesn't work until it is published.
