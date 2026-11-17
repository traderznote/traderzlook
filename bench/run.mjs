// CI frame-time runner: runs each scenario in throttled Chromium and checks its gates against the
// caps and baselines.json (`--rebaseline` rewrites it). Exits 0 when Chromium is unavailable.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const BASELINES = join(here, 'baselines.json');

const WARMUP_DROP = 10; // skip JIT warm-up and buffer growth
const SCENARIO_RUNS = 5; // the median across runs is gated
const DPR = 2;
const THROTTLE = 4; // every budget is stated at a 4x CPU throttle
const DRIFT_WARN_PCT = 10;
const REBASELINE = process.argv.includes('--rebaseline');

function ciGatedExit(reason) {
  console.log(`bench/run: ${reason}`);
  console.log('bench/run: Chromium not installed — the frame-time runner is CI-gated. Skipped (exit 0).');
  process.exit(0);
}

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  try {
    ({ chromium } = await import('@playwright/test'));
  } catch {
    ciGatedExit('playwright not resolvable');
  }
}
let execPath;
try {
  execPath = chromium.executablePath();
} catch {
  ciGatedExit('chromium.executablePath() unavailable');
}
if (!execPath || !existsSync(execPath)) ciGatedExit(`chromium executable not found at ${execPath ?? '(none)'}`);

const { build } = await import('esbuild');
const bundle = await build({
  entryPoints: [join(here, 'browser', 'driver.ts')],
  bundle: true,
  format: 'iife',
  write: false,
  platform: 'browser',
  target: 'es2022',
  define: { __DEV__: 'false', __TN_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const driverJs = bundle.outputFiles[0].text;

let browser;
try {
  browser = await chromium.launch({ headless: true });
} catch (err) {
  ciGatedExit(`chromium.launch failed: ${(err && err.message) || err}`);
}
const page = await browser.newPage({ deviceScaleFactor: DPR });
const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });
await cdp.send('HeapProfiler.enable');
await page.setContent('<!doctype html><html><body></body></html>');
await page.addScriptTag({ content: driverJs });

async function heapUsedBytes() {
  await cdp.send('HeapProfiler.collectGarbage');
  const { usedSize } = await cdp.send('Runtime.getHeapUsage');
  return usedSize;
}

function p95(values) {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))];
}
function median(values) {
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
// UpdateLevel.Layout (model/chart-model.ts).
const LAYOUT_LEVEL = 3;
function reduceFrame(metric, aggregate, frames) {
  // A derived count, not a FrameStats lane. No warm-up drop: that could hide a violation.
  if (metric === 'layoutFrames') {
    return frames.filter((f) => f.level === LAYOUT_LEVEL).length;
  }
  const xs = frames.slice(WARMUP_DROP).map((f) => f[metric]).filter((v) => v !== undefined);
  switch (aggregate) {
    case 'p95': return p95(xs);
    case 'avg': return xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
    case 'max': return xs.length ? Math.max(...xs) : 0;
    case 'sum': return xs.reduce((a, b) => a + b, 0);
    case 'exact': return xs.length ? Math.max(...xs) : 0; // exact gates assert a hard ceiling on every frame
    default: return 0;
  }
}
function reduceProbe(spec, runProbes) {
  const deltas = runProbes.map((p) => {
    let d = p[spec.to] - p[spec.from];
    if (spec.from2 !== undefined && spec.to2 !== undefined) d -= p[spec.to2] - p[spec.from2];
    if (spec.perFrames) d /= spec.perFrames;
    if (spec.perPoints) d /= spec.perPoints;
    return d;
  });
  return Math.min(...deltas); // the GC floor
}

async function runScenario(spec) {
  const probeRuns = []; // one { label: heapUsed } map per run
  const repeats = Math.max(...spec.gates.filter((g) => g.source === 'probe').map((g) => g.probe.repeats), 1);
  const needProbes = spec.gates.some((g) => g.source === 'probe');
  const runs = needProbes ? repeats : SCENARIO_RUNS;
  const frameMetricValues = {}; // "metric:aggregate" → value per run

  for (let r = 0; r < runs; r++) {
    const probes = {};
    const frames = await page.evaluate(
      ({ id, runIndex }) => window.__tnBench.run(id, runIndex),
      { id: spec.id, runIndex: r },
    );
    if (needProbes) {
      const labels = await page.evaluate((id) => window.__tnBench.probeLabels(id), spec.id);
      for (const label of labels) probes[label] = await heapUsedBytes();
      probeRuns.push(probes);
    }
    for (const g of spec.gates) {
      if (g.source !== 'frame') continue;
      const key = `${g.metric}:${g.aggregate}`;
      (frameMetricValues[key] ??= []).push(reduceFrame(g.metric, g.aggregate, frames));
    }
  }

  const results = [];
  for (const g of spec.gates) {
    const value =
      g.source === 'probe'
        ? reduceProbe(g.probe, probeRuns)
        : median(frameMetricValues[`${g.metric}:${g.aggregate}`] ?? [0]);
    results.push({ gate: g, value });
  }
  return results;
}

const baselines = existsSync(BASELINES) ? JSON.parse(readFileSync(BASELINES, 'utf8')) : { scenarios: {} };
const freshBaseline = { $comment: baselines.$comment, runner: baselines.runner, scenarios: {} };

// Bundle the TS scenario catalog so its gate records can be read here as plain data.
const catBundle = await build({
  entryPoints: [join(here, 'scenarios.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  target: 'es2022',
  define: { __DEV__: 'false', __TN_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const { SCENARIOS } = await import(
  'data:text/javascript;base64,' + Buffer.from(catBundle.outputFiles[0].text).toString('base64')
);
let failed = 0;

for (const spec of SCENARIOS) {
  const results = await runScenario(spec);
  freshBaseline.scenarios[spec.id] = {};
  for (const { gate, value } of results) {
    const key = `${gate.metric}:${gate.aggregate}`;
    freshBaseline.scenarios[spec.id][key] = round(value);

    // Reported only: the value is not yet meaningful, so it must not count as a pass.
    if (gate.informationalUntilM11 !== undefined) {
      console.log(`bench/run: [informational until M11: ${gate.informationalUntilM11}] ${spec.id} ${key} = ${round(value)} (cap ${gate.cap}) — reported, not gated`);
      continue;
    }

    const overCap = gate.aggregate === 'exact' ? value > gate.cap : value > gate.cap;
    if (overCap) {
      console.error(`bench/run: FAIL ${spec.id} ${key} = ${round(value)} > cap ${gate.cap}`);
      failed++;
      continue;
    }
    const base = baselines.scenarios?.[spec.id]?.[key];
    if (base !== undefined && base > 0 && gate.aggregate !== 'exact') {
      const driftPct = ((value - base) / base) * 100;
      const failPct = gate.driftFailPct ?? 20;
      if (driftPct > failPct) {
        console.error(`bench/run: FAIL ${spec.id} ${key} drift +${driftPct.toFixed(1)}% > ${failPct}% (base ${base})`);
        failed++;
      } else if (driftPct > DRIFT_WARN_PCT) {
        console.warn(`bench/run: WARN ${spec.id} ${key} drift +${driftPct.toFixed(1)}% > ${DRIFT_WARN_PCT}% (base ${base})`);
      } else {
        console.log(`bench/run: PASS ${spec.id} ${key} = ${round(value)} (cap ${gate.cap}, base ${base})`);
      }
    } else {
      console.log(`bench/run: PASS ${spec.id} ${key} = ${round(value)} (cap ${gate.cap})`);
    }
  }
}

await browser.close();

if (REBASELINE) {
  writeFileSync(BASELINES, JSON.stringify(freshBaseline, null, 2) + '\n');
  console.log(`bench/run: rebaselined ${BASELINES} (§9.5 — commit with a rationale).`);
}

console.log(`bench/run: ${failed} gate failure(s).`);
process.exit(failed > 0 ? 1 : 0);

function round(v) { return Math.round(v * 1000) / 1000; }
