// Browser-side bench driver: bundled to an IIFE by run.mjs and run in a throttled Chromium page
// (CI browser job only). Exposes window.__tnBench for the runner.
import { createChart, LineSeries, AreaSeries, CandlestickSeries, HistogramSeries }
  from '../../src/api/index';
import type { IChart, ISeries, SeriesType } from '../../src/api/index';
import type { Time } from '../../src/data/index';
import type { FrameStats, IPerfSink } from '../../src/host/profiling';
import { lineSeries, candleSeries, histogramSeries } from '../data-gen.mjs';
import { SCENARIOS } from '../scenarios';
import type { BenchChart, BenchHarness, SceneId } from '../gates';

declare global {
  interface Window {
    __tnFrames: FrameStats[];
    __tnBench: {
      scenarios(): string[];
      probeLabels(id: string): string[];
      run(id: string, runIndex: number): Promise<FrameStats[]>;
    };
  }
}

const SIZE = { width: 1600, height: 900 };

function buildScene(scene: SceneId): { chart: IChart<Time>; series: ISeries<SeriesType, Time>[]; container: HTMLElement } {
  const container = document.createElement('div');
  container.style.cssText = `position:relative;width:${SIZE.width}px;height:${SIZE.height}px`;
  document.body.appendChild(container);
  const chart = createChart(container, { width: SIZE.width, height: SIZE.height });
  const series: ISeries<SeriesType, Time>[] = [];
  const add = (def: Parameters<IChart<Time>['addSeries']>[0], data: readonly unknown[], pane: number): void => {
    const h = chart.addSeries(def, {}, pane);
    h.setData(data as never);
    series.push(h);
  };
  const P = scenePoints(scene);
  switch (scene) {
    case 'R0': break;
    case 'R1':
    case 'R6':
      add(CandlestickSeries, candleSeries(P, 0xc0), 0);
      add(LineSeries, lineSeries(P, 0x11), 0);
      add(LineSeries, lineSeries(P, 0x12), 0);
      add(AreaSeries, lineSeries(P, 0xa1), 0);
      add(HistogramSeries, histogramSeries(P, 0x40), 1);
      break;
    case 'R2':
      add(LineSeries, lineSeries(P, 0x21), 0);
      add(CandlestickSeries, candleSeries(P, 0x22), 0);
      chart.timeScale().fitContent();
      break;
    case 'R3':
      for (let i = 0; i < 50; i++) add(LineSeries, lineSeries(10_000, 0x300 + i), 0);
      break;
    case 'R4':
      add(CandlestickSeries, candleSeries(P, 0x401), 0);
      add(LineSeries, lineSeries(P, 0x402), 0);
      add(HistogramSeries, histogramSeries(P, 0x403), 1);
      add(LineSeries, lineSeries(P, 0x404), 2);
      add(AreaSeries, lineSeries(P, 0x405), 3);
      break;
    case 'R5':
      for (let i = 0; i < 20; i++) add(LineSeries, lineSeries(10_000, 0x500 + i), 0);
      break;
    case 'smoke':
      add(LineSeries, lineSeries(5_000_000, 0x701), 0);
      break;
  }
  if (scene === 'R6') {
    for (let i = 0; i < 100; i++) series[0].createPriceLine({ price: 80 + i * 0.4 });
  }
  return { chart, series, container };
}

function scenePoints(scene: SceneId): number {
  if (scene === 'R2') return 1_000_000;
  if (scene === 'smoke') return 5_000_000;
  return 100_000;
}

function nextPaint(frames: FrameStats[]): Promise<void> {
  const before = frames.length;
  return new Promise((resolve) => {
    const tick = (): void => { if (frames.length > before) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  });
}

function adapt(built: ReturnType<typeof buildScene>, frames: FrameStats[]): BenchChart {
  const { chart, series } = built;
  const dispatch = (type: string, x: number, y: number, extra?: Record<string, number>): void => {
    const el = chart.element();
    el.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, ...extra }));
  };
  return {
    setData: (i, data) => series[i]?.setData(data as never),
    update: (i, point) => series[i]?.update(point as never),
    async crosshairMove(x, y) { dispatch('mousemove', x, y); await nextPaint(frames); },
    async wheel(x, y, deltaY) {
      chart.element().dispatchEvent(new WheelEvent('wheel', { clientX: x, clientY: y, deltaY, bubbles: true }));
      await nextPaint(frames);
    },
    async pan(dxBars) {
      const ts = chart.timeScale();
      ts.scrollToPosition(ts.scrollPosition() - dxBars, false);
      await nextPaint(frames);
    },
    frame: () => nextPaint(frames),
  };
}

window.__tnBench = {
  scenarios: () => SCENARIOS.map((s) => s.id),
  probeLabels(id) {
    // Probe order depends only on the script, so run it over a no-op chart to record the labels.
    const spec = SCENARIOS.find((s) => s.id === id);
    if (!spec) return [];
    const labels: string[] = [];
    const harness: BenchHarness = { probe: async (l) => void labels.push(l) };
    const noop = new Proxy({}, { get: () => async () => {} }) as unknown as BenchChart;
    void spec.script(noop, harness);
    return labels;
  },
  async run(id) {
    const spec = SCENARIOS.find((s) => s.id === id);
    if (!spec) throw new Error(`unknown scenario ${id}`);
    const frames: FrameStats[] = [];
    window.__tnFrames = frames;
    const sink: IPerfSink = { onFrame: (s) => frames.push(s) };
    // The profiling build of createChart reads the sink from this global.
    (window as unknown as { __tnSink?: IPerfSink }).__tnSink = sink;
    const built = buildScene(spec.scene);
    const chart = adapt(built, frames);
    const harness: BenchHarness = { probe: async () => { await nextPaint(frames).catch(() => {}); } };
    await spec.script(chart, harness);
    built.chart.dispose();
    built.container.remove();
    return frames;
  },
};
