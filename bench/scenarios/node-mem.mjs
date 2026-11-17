// Node approximation of the S12 memory gates (run with `node --expose-gc`). Absolute budgets are only
// reported; it gates the probe protocol and that candles cost more per point than lines.
import { build } from 'esbuild';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { makeBenchChart, seriesDefs } from '../harness.mjs';
import { lineSeries, candleSeries } from '../data-gen.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// Smaller than the browser run's 1M: at 1M node's heapUsed over-counts large-object-space
// fragmentation, while a much smaller N under-counts as reused buffers are reclaimed.
const POINTS = Number(process.env.TN_S12_POINTS ?? 200_000);

async function loadS12() {
  const dir = mkdtempSync(join(tmpdir(), 'tns12-'));
  const out = join(dir, 's12.mjs');
  await build({
    entryPoints: [join(here, 'S12.ts')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'es2022',
    define: { __DEV__: 'true', __TN_PROFILE__: 'true' },
    logLevel: 'warning',
  });
  const mod = await import(pathToFileURL(out).href);
  rmSync(dir, { recursive: true, force: true });
  return mod.default;
}

async function buildMemFixture() {
  const f = await makeBenchChart({ mediaSize: { width: 1600, height: 900 } });
  const d = await seriesDefs();
  const handles = [
    f.chart.addSeries(d.LineSeries, {}, 0), // slot 0: line A
    f.chart.addSeries(d.LineSeries, {}, 0), // slot 1: line B
    f.chart.addSeries(d.CandlestickSeries, {}, 0), // slot 2: candle
  ];
  f.raf.flush(1);
  // Generated inside setData and not retained, so after gc() the heap delta measures only the
  // retained lanes, not the input row objects.
  const gen = [
    () => lineSeries(POINTS, 0x21),
    () => lineSeries(POINTS, 0x22),
    () => candleSeries(POINTS, 0x23),
  ];
  return { f, handles, gen };
}

function makeMemChart({ f, handles, gen }, probes) {
  const chart = {
    setData(i, data) {
      // The script passes [] (the runner re-feeds); the generated rows must not outlive this call.
      const provided = Array.isArray(data) && data.length > 0 ? data : null;
      handles[i]?.setData(provided ?? gen[i]());
      f.raf.flush(100 + i);
    },
    update() {}, // unused by S12
    async crosshairMove() {}, async wheel() {}, async pan() {},
    async frame() { f.raf.flush(200); },
  };
  const harness = {
    async probe(label) {
      global.gc();
      global.gc(); // twice: the second pass settles young→old promotion
      probes[label] = process.memoryUsage().heapUsed;
    },
  };
  return { chart, harness };
}

// Same arithmetic as run.mjs reduceProbe.
function probeValue(spec, probes) {
  let d = probes[spec.to] - probes[spec.from];
  if (spec.from2 !== undefined && spec.to2 !== undefined) d -= probes[spec.to2] - probes[spec.from2];
  if (spec.perFrames) d /= spec.perFrames;
  if (spec.perPoints) d /= spec.perPoints;
  return d;
}

async function run() {
  if (typeof global.gc !== 'function') {
    console.error('node-mem: run with `node --expose-gc bench/scenarios/node-mem.mjs` (the §6.2 GC-floor bridge).');
    process.exit(2);
  }
  const spec = await loadS12();
  const repeats = Math.max(...spec.gates.map((g) => g.probe?.repeats ?? 1), 1);

  const runProbes = [];
  for (let r = 0; r < repeats; r++) {
    const fixture = await buildMemFixture();
    const probes = {};
    const { chart, harness } = makeMemChart(fixture, probes);
    await spec.script(chart, harness);
    runProbes.push(probes);
    fixture.f.dispose();
  }

  const labels = ['empty', 'afterA', 'afterB', 'afterC'];
  for (const l of labels) {
    if (runProbes.every((p) => typeof p[l] === 'number')) continue;
    console.error(`node-mem: FAIL — S12 did not probe('${l}') (the §6.2 protocol is malformed).`);
    process.exit(1);
  }

  // The floor column is the exact per-point size of the store's lanes; the heap delta is a noisy
  // approximation of it.
  console.log(`node-mem: S12 per-point byte attribution (node approx, POINTS=${POINTS.toLocaleString()}, min of ${repeats}):`);
  let monotoneOk = true;
  const named = [
    ['line   (Δ afterA→afterB)', spec.gates[0], '8 B lane + 4 B i32 index'],
    ['candle (Δ afterB→afterC)', spec.gates[1], '4×8 B lanes + 4 B i32 index'],
    ['slot   (Δ1−Δ2 derived)  ', spec.gates[2], 'shared timeline pool slot'],
  ];
  for (const [name, gate, floor] of named) {
    const vals = runProbes.map((p) => probeValue(gate.probe, p));
    const v = Math.min(...vals);
    console.log(`  ${name}: ${v.toFixed(1)} B/pt (node-heap Δ, indicative)   §6.2 cap ${gate.cap} B   SoA floor: ${floor}`);
  }
  const lineB = Math.min(...runProbes.map((p) => probeValue(spec.gates[0].probe, p)));
  const candleB = Math.min(...runProbes.map((p) => probeValue(spec.gates[1].probe, p)));
  if (!(candleB > lineB)) {
    monotoneOk = false;
    console.error(`node-mem: FAIL — candle ${candleB.toFixed(1)} B/pt not > line ${lineB.toFixed(1)} B/pt (4 lanes must exceed 1).`);
  }
  console.log('\nnode-mem: absolute B/point budgets are REPORTED here; the hard gate is the browser run (run.mjs, §6.2).');
  console.log(`node-mem: ${monotoneOk ? 'PASS' : 'FAIL'} (protocol well-formed${monotoneOk ? '; candle > line monotone' : ''}).`);
  process.exit(monotoneOk ? 0 : 1);
}

await run();
