// Headless authoring check for the frame-time scenarios (their timings run only in the browser
// runner): gate shapes, exact caps, scripts run, probe order, and baseline records.
import { build } from 'esbuild';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');

// Expected caps per scenario, as `metric:aggregate` → cap.
const EXPECTED = {
  S1: { 'wallMs:max': 60 },
  S4: { 'totalMs:p95': 8, 'bufferReallocs:exact': 0, 'heapPerFrameBytes:min': 2048 },
  S5: { 'totalMs:p95': 6, 'timelineRebuilds:exact': 0, 'chunkRecomputes:exact': 5, 'layoutFrames:exact': 2, 'layoutMs:sum': 40, 'heapPerFrameBytes:min': 4096 },
  S6: { 'wallMs:max': 200, 'displayLists:exact': 5 },
  S7: { 'wallMs:max': 320 },
  S9: { 'totalMs:p95': 20 },
  S10: { 'totalMs:p95': 12, 'cachedListIdentityViolations:exact': 0, 'heapPerFrameBytes:min': 4096 },
  S11: { 'totalMs:p95': 6, 'timelineRebuilds:exact': 0 },
  S12: { 'bytesPerPoint:min': null }, // caps 24/48/32 are checked separately below
  S13: { 'totalMs:p95': 10, 'cachedListIdentityViolations:exact': 0, 'heapPerFrameBytes:min': 512 },
  S14: { 'totalMs:p95': 8, 'timelineRebuilds:exact': 0, 'chunkRecomputes:exact': 20, 'heapPerFrameBytes:min': 4096 },
  S17: {},
};
const FRAME_STATS_LANES = new Set([
  'level', 'totalMs', 'layoutMs', 'modelMs', 'emitMs', 'replayMs', 'sourcesUpdated',
  'sourcesReEmitted', 'sourcesCached', 'displayLists', 'drawCommands', 'bufferReallocs',
  'timelineRebuilds', 'chunkRecomputes', 'cachedListIdentityViolations', 'inputLagFrames',
]);
const PROBE_METRICS = new Set(['heapPerFrameBytes', 'bytesPerPoint', 'wallMs']);
const AGGREGATES = new Set(['p95', 'avg', 'max', 'sum', 'exact', 'min']);

let failures = 0;
const fail = (msg) => { console.error(`frametime-smoke: FAIL  ${msg}`); failures++; };

const dir = mkdtempSync(join(tmpdir(), 'tnft-'));
const out = join(dir, 'slice.mjs');
await build({
  entryPoints: [join(here, 'frametime-specs.ts')],
  outfile: out,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'es2022',
  define: { __DEV__: 'true', __TN_PROFILE__: 'true' },
  logLevel: 'warning',
});
const { FRAMETIME_SCENARIOS, NODE_MEMORY_SCENARIOS } = await import(pathToFileURL(out).href);
rmSync(dir, { recursive: true, force: true });

const baselinesPath = join(here, '..', 'baselines.json');
const baselines = existsSync(baselinesPath) ? JSON.parse(readFileSync(baselinesPath, 'utf8')) : { scenarios: {} };

// No-op chart whose harness records the probe label order.
function recordingChart(labels) {
  const chart = {
    setData() {}, update() {},
    async crosshairMove() {}, async wheel() {}, async pan() {}, async frame() {},
  };
  const harness = { async probe(l) { labels.push(l); } };
  return { chart, harness };
}

const EXPECTED_IDS = ['S1', 'S4', 'S5', 'S6', 'S7', 'S9', 'S10', 'S11', 'S12', 'S13', 'S14', 'S17'];
const gotIds = FRAMETIME_SCENARIOS.map((s) => s.id);
if (gotIds.join(',') !== EXPECTED_IDS.join(',')) {
  fail(`slice membership ${gotIds.join(',')} !== expected ${EXPECTED_IDS.join(',')}`);
}
if (!(NODE_MEMORY_SCENARIOS.length === 1 && NODE_MEMORY_SCENARIOS[0].id === 'S12')) {
  fail('NODE_MEMORY_SCENARIOS must be exactly [S12]');
}

for (const spec of FRAMETIME_SCENARIOS) {
  if (typeof spec.id !== 'string') { fail(`spec missing id`); continue; }
  if (typeof spec.script !== 'function') { fail(`${spec.id}: script is not a function`); continue; }
  if (!Array.isArray(spec.gates)) { fail(`${spec.id}: gates is not an array`); continue; }
  const sceneOk = ['R0', 'R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'smoke'].includes(spec.scene);
  if (!sceneOk) fail(`${spec.id}: invalid scene ${spec.scene}`);

  for (const g of spec.gates) {
    if (g.source === 'frame') {
      // wallMs and layoutFrames are computed by the runner; they are not FrameStats lanes.
      const isDerived = g.metric === 'wallMs' || g.metric === 'layoutFrames';
      if (!isDerived && !FRAME_STATS_LANES.has(g.metric)) fail(`${spec.id}: frame gate metric '${g.metric}' is not a FrameStats lane`);
    } else if (g.source === 'probe') {
      if (!PROBE_METRICS.has(g.metric)) fail(`${spec.id}: probe gate metric '${g.metric}' is not a probe metric`);
      if (!g.probe || typeof g.probe.from !== 'string' || typeof g.probe.to !== 'string') fail(`${spec.id}: probe gate missing from/to`);
      if (!g.probe || typeof g.probe.repeats !== 'number') fail(`${spec.id}: probe gate missing repeats`);
    } else {
      fail(`${spec.id}: gate has unknown source '${g.source}'`);
    }
    if (!AGGREGATES.has(g.aggregate)) fail(`${spec.id}: gate aggregate '${g.aggregate}' invalid`);
    if (typeof g.cap !== 'number') fail(`${spec.id}: gate cap is not a number`);
    if (g.source === 'probe' && g.aggregate !== 'min') fail(`${spec.id}: probe gate must aggregate 'min' (GC floor)`);
  }

  const exp = EXPECTED[spec.id];
  if (exp === undefined) { fail(`${spec.id}: not in the EXPECTED cap table (unexpected slice member)`); continue; }
  if (spec.id === 'S12') {
    const caps = spec.gates.filter((g) => g.metric === 'bytesPerPoint').map((g) => g.cap).sort((a, b) => a - b);
    if (caps.join(',') !== '24,32,48') fail(`S12: §6.2 caps ${caps.join(',')} !== 24,32,48 (line,slot,candle)`);
    const derived = spec.gates.find((g) => g.probe && g.probe.from2 !== undefined);
    if (!derived) fail('S12: missing the derived timeline-slot gate (from2/to2)');
    else if (!(derived.probe.from === 'empty' && derived.probe.to === 'afterA' && derived.probe.from2 === 'afterA' && derived.probe.to2 === 'afterB')) {
      fail(`S12: derived slot gate arithmetic must be (afterA−empty)−(afterB−afterA) [from empty→afterA, from2 afterA→afterB], got from ${derived.probe.from}→${derived.probe.to}, from2 ${derived.probe.from2}→${derived.probe.to2}`);
    }
  } else {
    for (const [key, cap] of Object.entries(exp)) {
      const [metric, aggregate] = key.split(':');
      const g = spec.gates.find((x) => x.metric === metric && x.aggregate === aggregate);
      if (!g) { fail(`${spec.id}: missing gate ${key}`); continue; }
      if (g.cap !== cap) fail(`${spec.id}: gate ${key} cap ${g.cap} !== expected ${cap} (§4.2/§6.2)`);
    }
  }

  const labels = [];
  try {
    const { chart, harness } = recordingChart(labels);
    await spec.script(chart, harness);
  } catch (err) {
    fail(`${spec.id}: script threw — ${(err && err.message) || err}`);
  }

  const sceneBaseline = baselines.scenarios?.[spec.id];
  for (const g of spec.gates) {
    const key = `${g.metric}:${g.aggregate}`;
    if (g.aggregate === 'exact') continue; // exact gates carry no drift baseline
    if (!sceneBaseline || !(key in sceneBaseline)) {
      fail(`${spec.id}: baselines.json has no drift record for ${key} (perf §9.5)`);
    }
  }

  if (spec.id === 'S12' && labels.join(',') !== 'empty,afterA,afterB,afterC') {
    fail(`S12: probe order ${labels.join(',')} !== empty,afterA,afterB,afterC (§6.2 protocol)`);
  }
  console.log(`frametime-smoke: OK  ${spec.id} (scene ${spec.scene}, ${spec.gates.length} gate${spec.gates.length === 1 ? '' : 's'}, probes [${labels.join(', ')}])`);
}

console.log(`\nframetime-smoke: ${failures === 0 ? 'PASS' : 'FAIL'} — ${FRAMETIME_SCENARIOS.length} scenarios checked, ${failures} failure(s).`);
process.exit(failures > 0 ? 1 : 0);
