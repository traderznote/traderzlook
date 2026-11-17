// Headless chart harness for the node-run bench scenes: a recording stub backend, a fake rAF the
// scene flushes by hand, and a minimal fake DOM. The library is bundled with profiling on.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Anchored to this file (not cwd) so the bundle resolves ./src from any directory.
const ROOT = fileURLToPath(new URL('..', import.meta.url));

let libModulePromise = null;

function libSource() {
  return `
    export { createChartWith, LineSeries, AreaSeries, BaselineSeries, BarSeries,
             CandlestickSeries, HistogramSeries } from './src/api/index';
    export { timeBehavior } from './src/data/index';
    export { createFrameCounters } from './src/core/index';
  `;
}

async function lib() {
  if (libModulePromise === null) {
    libModulePromise = (async () => {
      const dir = mkdtempSync(join(tmpdir(), 'tnbench-'));
      const out = join(dir, 'lib.mjs');
      await build({
        stdin: { contents: libSource(), resolveDir: ROOT, loader: 'ts', sourcefile: 'bench-lib.ts' },
        outfile: out,
        bundle: true,
        format: 'esm',
        platform: 'node',
        // Unlike the shipped build, keep the profiling counters compiled in.
        define: { __DEV__: 'true', __TN_PROFILE__: 'true' },
        logLevel: 'warning',
      });
      const mod = await import(pathToFileURL(out).href);
      rmSync(dir, { recursive: true, force: true });
      return mod;
    })();
  }
  return libModulePromise;
}

function makeBackend(log) {
  let seq = 0;
  const makeSurface = () => {
    const name = 'surf' + seq++;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize(s) { media = s; },
      beginFrame(scope) {
        log.push({ surface: name, op: 'begin', scope });
        return { mediaSize: media, bitmapSize: { width: media.width, height: media.height }, hr: 1, vr: 1 };
      },
      renderLayer(layer, lists) {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push({ surface: name, op: 'render', layer, lists: lists.length, cmds });
      },
      endFrame() { log.push({ surface: name, op: 'end' }); },
      resolutionChanged: { subscribe() { return () => {}; } },
      snapshot() { return { _tag: 'SurfaceSnapshot' }; },
      dispose() { log.push({ surface: name, op: 'dispose' }); },
    };
  };
  return {
    createSurface() { return makeSurface(); },
    createImage() { return { id: 0, width: 0, height: 0 }; },
    composeSnapshot() { return { _tag: 'Snapshot' }; },
    text: { measure: (t) => ({ width: 6 * String(t.text ?? t).length, ascent: 8, descent: 2 }) },
    dispose() {},
  };
}

// Single-slot rAF: the scene flushes the one pending frame by hand.
function makeRaf() {
  let pending = null;
  let now = 0;
  return {
    scheduler: {
      schedule(cb) { pending = cb; return () => { if (pending === cb) pending = null; }; },
      dispose() { pending = null; },
    },
    hasPending() { return pending !== null; },
    flush(t) { const cb = pending; pending = null; if (cb !== null) cb(t ?? now++); },
  };
}

// Only the DOM surface createChartWith and ChartHost touch.
function makeElement(doc, size) {
  const children = [];
  return {
    ownerDocument: doc,
    style: {},
    children,
    appendChild(c) { children.push(c); return c; },
    removeChild(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return c; },
    contains(c) { return children.includes(c); },
    getBoundingClientRect() { return { left: 0, top: 0, width: size.width, height: size.height }; },
  };
}
function makeDoc(size) { const doc = { createElement() { return makeElement(doc, size); } }; return doc; }

/** Build one headless chart; it has already painted once when returned. */
export async function makeBenchChart(env = {}) {
  const mediaSize = env.mediaSize ?? { width: 1600, height: 900 };
  const { createChartWith, timeBehavior, createFrameCounters } = await lib();

  const backendLog = [];
  const backend = makeBackend(backendLog);
  const raf = makeRaf();
  const doc = makeDoc(mediaSize);
  const container = makeElement(doc, mediaSize);

  const counters = createFrameCounters();
  const frames = [];
  const sink = { onFrame: (stats) => frames.push(stats) };

  const chart = createChartWith(
    container,
    backend,
    timeBehavior(),
    { width: mediaSize.width, height: mediaSize.height, ...(env.options ?? {}) },
    { scheduler: raf.scheduler, perfSink: sink, frameCounters: counters },
  );
  raf.flush(0); // drain the frame armed by the initial synchronous setSize()

  return {
    chart,
    counters, // live FrameCounters; read after a flush
    frames,
    sink,
    raf,
    backendLog,
    mediaSize,
    dispose() { chart.dispose(); },
  };
}

export async function seriesDefs() {
  const m = await lib();
  return {
    LineSeries: m.LineSeries, AreaSeries: m.AreaSeries, BaselineSeries: m.BaselineSeries,
    BarSeries: m.BarSeries, CandlestickSeries: m.CandlestickSeries, HistogramSeries: m.HistogramSeries,
  };
}
