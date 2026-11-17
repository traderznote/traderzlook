# Traderzlook

**Traderzlook** — a brand-new, **Apache-2.0-licensed**, open-source financial charting library, built from
scratch in TypeScript. Part of the Traderznote platform.

Everything here is original work — concepts, math, and code — free for anyone to use, for any
purpose, under the Apache License 2.0.

## Status

**v1.0.0.** The six series types, time and price scales (normal, log, percentage, indexed-to-100),
multi-pane layouts, the crosshair with magnet modes and axis labels, price lines, pointer and touch
interaction with kinetic scrolling, mouse and range events, the plugins (markers, watermarks,
drawing tools, EMA, multi-chart sync) and screenshots work in a real browser. The Canvas 2D backend
ships in v1; the renderer seam leaves room for a GPU backend.

See [KNOWN-ISSUES.md](./KNOWN-ISSUES.md) for what is still open.

> Quality gates: strict TypeScript project references and dependency-cruiser import walls,
> per-module LOC budgets, brotli byte budgets per entry point, 1350+ unit tests including per-bug
> regression tests, headless end-to-end demos, profiling byte-identity, structural frame counters,
> and micro-benchmark goldens.

## Install

```sh
npm install traderzlook
```

Not yet published to npm: `package.json` is still marked private.

## Quickstart

```ts
import { createChart, CandlestickSeries } from 'traderzlook';

const chart = createChart(document.getElementById('container')!, {
  layout: { textColor: '#191919' },
});

const candles = chart.addSeries(CandlestickSeries, { upColor: '#26a69a', downColor: '#ef5350' });
candles.setData([
  { time: '2026-01-05', open: 10, high: 14, low: 9,  close: 13 },
  { time: '2026-01-06', open: 13, high: 17, low: 10, close: 11 },
  { time: '2026-01-07', open: 11, high: 12, low: 8,  close: 9  },
]);

chart.subscribeCrosshairMove((param) => {
  const bar = param.seriesData.get(candles);
  // param.time, bar, param.paneIndex …
});

chart.timeScale().fitContent();
```

## Features (v1)

- **Six series types** — Line, Area, Baseline, Histogram, Bar, Candlestick.
- **Scales** — a horizontal time scale and price scales in normal / logarithmic / percentage /
  indexed-to-100 modes, multi-pane stacking, a grid, both left/right axes.
- **Crosshair** — free by default, or magnet / magnet-to-OHLC / hidden, with price and time labels
  on the axes, plus last-value and price-line tags.
- **Events** — click, double-click and crosshair move with the bar data under the pointer; visible
  range and size changes.
- **Interaction** — pan, wheel zoom, kinetic fling, axis drag-scale, double-click reset, touch
  gestures, eased scroll/fit animations.
- **Screenshots** — `takeScreenshot()` / `toCanvas()` / `toBlob()`, with optional crosshair.
- **Plugins & extensibility** (`traderzlook/extras`) — series & up/down markers, text &
  image watermarks, a drawing-tool host, an EMA indicator, and an N-chart sync group.
- **Renderer-agnostic** — views emit plain-data draw commands through a backend interface; a Canvas 2D
  backend ships in v1, and a GPU (WebGL/WebGPU) backend can be added later as a new backend only — no
  rewrite.

## Package entry points

Traderzlook ships three tree-shakable subpaths:

| Import | What it is |
| --- | --- |
| `traderzlook` | The chart, series, scales, panes, crosshair, options, and events — the public API. |
| `traderzlook/gfx` | The rendering seam — the draw-command vocabulary + `DisplayListBuilder`, for writing a custom backend or consuming the command stream. |
| `traderzlook/extras` | Optional plugins: markers, watermarks, the drawing-tool host, the EMA indicator, multi-chart sync, and non-time-scale behaviors. Each is independently tree-shakable. |

## Architecture

Views convert model state into renderer-ready **draw commands** (a small, fixed vocabulary); a
**backend** replays those commands. The Canvas 2D backend is the v1 reference implementation. Strict
import walls between layers (`core → fmt → gfx / data → model → views / backend-canvas → host → api →
extras`) are enforced mechanically by TypeScript project references and dependency-cruiser, so the
seam between "what to draw" and "how to draw it" can never erode. Extension seams for drawing tools,
indicators, and multi-chart layouts are designed-in and proven in-tree, so app-level features arrive
as additions, not rework.

## Development

```sh
bun install
bun run build
```

Open `preview.html` through any static file server to see a live chart with real Binance data.

## License

[Apache License 2.0](./LICENSE) — free to use, modify and distribute, with an express patent grant.
