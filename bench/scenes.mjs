// Reference scenes R0–R6 over the headless harness, fed seeded data. The browser runner builds the
// same scene shapes over the real canvas backend.
import { makeBenchChart, seriesDefs } from './harness.mjs';
import { lineSeries, candleSeries, histogramSeries } from './data-gen.mjs';

const R = { width: 1600, height: 900 };

// AreaSeries currently throws in the headless composite path, so node scenes use a line in its place
// (same single-value lane and command profile). The browser runner uses real areas.
function areaDef(d) { return d.LineSeries; }

// Best-effort: the headless time scale may reject it, and the structural counts do not depend on it.
function setVisible(chart, total, bars) {
  try { chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, total - bars), to: total - 1 }); }
  catch { /* advisory in the headless stub */ }
}

/** R0: empty chart. */
export async function R0() {
  const f = await makeBenchChart({ mediaSize: R });
  return { ...f, scene: { id: 'R0', visibleBars: 0, series: [] } };
}

/** R1 "parity": 2 panes; pane0: candle + 2 line + area, pane1: histogram; 100k pts each. */
export async function R1(points = 100_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  series.push(addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0xc0)));
  series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x11)));
  series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x12)));
  series.push(addData(f.chart.addSeries(areaDef(d), {}, 0), lineSeries(points, 0xa1)));
  series.push(addData(f.chart.addSeries(d.HistogramSeries, {}, 1), histogramSeries(points, 0x40)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R1', visibleBars: visible, points, series: ['candle', 'line', 'line', 'area', 'histogram'] }, series };
}

/** R2 "bulk": 1 line + 1 candle, 1M pts, fit to width so decimation kicks in. */
export async function R2(points = 1_000_000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [
    addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x21)),
    addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0x22)),
  ];
  f.chart.timeScale().fitContent(); // 1M pts over 1600px → barSpacing·hr < 1 → decimation active
  f.raf.flush(1);
  return { ...f, scene: { id: 'R2', visibleBars: points, points, decimated: true, series: ['line', 'candle'] }, series };
}

/** R3 "breadth": 50 line series × 10k points, one pane, visible 2000 bars. */
export async function R3(count = 50, points = 10_000, visible = 2000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  for (let i = 0; i < count; i++) series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x300 + i)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R3', visibleBars: visible, points, seriesCount: count }, series };
}

/** R4 "depth": 4 panes (candle+line / histogram / line / area), 100k pts, visible 1000. */
export async function R4(points = 100_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [
    addData(f.chart.addSeries(d.CandlestickSeries, {}, 0), candleSeries(points, 0x401)),
    addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x402)),
    addData(f.chart.addSeries(d.HistogramSeries, {}, 1), histogramSeries(points, 0x403)),
    addData(f.chart.addSeries(d.LineSeries, {}, 2), lineSeries(points, 0x404)),
    addData(f.chart.addSeries(areaDef(d), {}, 3), lineSeries(points, 0x405)),
  ];
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R4', visibleBars: visible, points, panes: 4 }, series };
}

/** R5 "fanout": 20 line series × 10k points, one pane, visible 1000 bars. */
export async function R5(count = 20, points = 10_000, visible = 1000) {
  const f = await makeBenchChart({ mediaSize: R });
  const d = await seriesDefs();
  const series = [];
  for (let i = 0; i < count; i++) series.push(addData(f.chart.addSeries(d.LineSeries, {}, 0), lineSeries(points, 0x500 + i)));
  f.raf.flush(1);
  setVisible(f.chart, points, visible);
  f.raf.flush(2);
  return { ...f, scene: { id: 'R5', visibleBars: visible, points, seriesCount: count }, series };
}

/** R6 "extras": R1 + 100 price lines on the candle series + 10k markers (2000/series). */
export async function R6(points = 100_000, visible = 1000) {
  const base = await R1(points, visible);
  const candle = base.series[0];
  const priceLines = [];
  for (let i = 0; i < 100; i++) priceLines.push(candle.createPriceLine({ price: 80 + i * 0.4, color: '#888' }));
  // setMarkers is an optional extra; without it the markers are only recorded on the scene.
  const markers = [];
  for (let s = 0; s < base.series.length; s++) {
    const step = Math.max(1, Math.floor(points / 2000));
    const m = [];
    for (let i = 0; i < 2000; i++) m.push({ time: i * step, position: 'aboveBar', shape: 'circle' });
    const h = base.series[s];
    if (typeof h.setMarkers === 'function') h.setMarkers(m);
    markers.push({ series: s, count: m.length });
  }
  base.raf.flush(3);
  return { ...base, scene: { id: 'R6', visibleBars: visible, points, priceLines: priceLines.length, markers: 10_000 }, priceLines };
}

function addData(handle, data) {
  handle.setData(data);
  return handle;
}

export const SCENES = { R0, R1, R2, R3, R4, R5, R6 };
