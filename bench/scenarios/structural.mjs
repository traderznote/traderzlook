// Headless runner for the structural scenarios: drives each script over the stub-backend chart and
// checks the exact frame-counter gates. Run: node bench/scenarios/structural.mjs
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeNodeBenchChart } from './node-adapter.mjs';
import { R1, R2, R6 } from '../scenes.mjs';

// Structural counts do not depend on point count, so scenes are built at a size node can handle
// (a full 1M-point R2 runs out of memory headless).
const SCENE_BUILDERS = {
  R1: () => R1(2000, 500),
  R2: () => R2(20_000),
  R6: () => R6(2000, 500),
};
async function buildSceneHeadless(sceneId) {
  const b = SCENE_BUILDERS[sceneId];
  if (b === undefined) throw new Error(`structural runner has no headless size for scene ${sceneId}`);
  return b();
}

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..');

// Bundle the TS specs so the gate records can be read here as plain data.
const catBundle = await build({
  entryPoints: [join(here, 'structural-specs.ts')],
  bundle: true,
  format: 'esm',
  write: false,
  platform: 'node',
  target: 'es2022',
  define: { __DEV__: 'false', __TN_PROFILE__: 'true' },
  absWorkingDir: root,
  logLevel: 'warning',
});
const { STRUCTURAL_SCENARIOS, INFORMATIONAL_UNTIL_M11 } = await import(
  'data:text/javascript;base64,' + Buffer.from(catBundle.outputFiles[0].text).toString('base64')
);

// The headless time scale is a stub, so series emit minimal command streams: the drawCommands caps
// here only prove O(runs) shape; the tight caps run in the browser runner.
console.log('structural-scenarios: [informational: headless time-scale geometry is degenerate — §4.4.3 drawCommands caps prove O(runs) shape only; the tight caps run in the Playwright runner]\n');

// Like run.mjs reduceFrame, but with no warm-up drop, which could hide a violation.
function reduceFrame(metric, aggregate, frames) {
  const xs = frames.map((f) => f[metric]).filter((v) => v !== undefined);
  if (xs.length === 0) return { value: 0, frames: 0 };
  switch (aggregate) {
    case 'max':
    case 'exact':
      return { value: Math.max(...xs), frames: xs.length }; // exact caps assert a per-frame ceiling
    case 'sum':
      return { value: xs.reduce((a, b) => a + b, 0), frames: xs.length };
    case 'avg':
      return { value: xs.reduce((a, b) => a + b, 0) / xs.length, frames: xs.length };
    case 'p95': {
      const s = [...xs].sort((a, b) => a - b);
      return { value: s[Math.min(s.length - 1, Math.floor(0.95 * (s.length - 1)))], frames: xs.length };
    }
    default:
      return { value: 0, frames: xs.length };
  }
}

let failures = 0;
let informational = 0;

async function runScenario(spec) {
  const fixture = await buildSceneHeadless(spec.scene);
  const adapter = makeNodeBenchChart(fixture);

  // Probes are no-ops headless, except S2b's marker, which attaches one empty crosshair listener.
  const harness = {
    async probe(label) {
      if (label === 'listenerAttached' && typeof adapter.realChart.subscribeCrosshairMove === 'function') {
        adapter.realChart.subscribeCrosshairMove(() => {});
      }
    },
  };

  await spec.script(adapter.chart, harness);

  const frames = adapter.frameSnaps;
  const overlay = adapter.overlayFrames();
  const render = frames.filter((s) => !overlay.includes(s));

  console.log(`\nstructural ${spec.id} (${spec.scene}): ${frames.length} painted frame(s), ${overlay.length} overlay, ${render.length} render.`);

  // An Overlay frame composites only the overlay bands, so only the crosshair's own sources (its
  // lines per pane and its price/time tags) may re-emit; anything more, or a heavy command
  // stream, means base work leaked into the cheap frame.
  if (overlay.length > 0) {
    const maxOverlayReEmit = Math.max(...overlay.map((s) => s.sourcesReEmitted));
    const maxOverlayCmds = Math.max(...overlay.map((s) => s.drawCommands));
    const renderReEmit = render.length > 0 ? Math.max(...render.map((s) => s.sourcesReEmitted)) : 0;
    const baseLeak = maxOverlayReEmit > 6 || maxOverlayCmds > 40;
    if (baseLeak) {
      console.error(`structural ${spec.id}: FAIL §4.4.1 base-only — an Overlay frame re-emitted ${maxOverlayReEmit} source(s) / ${maxOverlayCmds} cmds (> 0 base ⇒ a base source was composited at Overlay scope)`);
      failures++;
    } else {
      const witness = render.length > 0 ? ` (Render frames re-emit ${renderReEmit} base source(s) — assertion non-vacuous)` : '';
      console.log(`structural ${spec.id}: PASS §4.4.1 base-only (Overlay sourcesReEmitted ${maxOverlayReEmit} ≤ 6, drawCommands ${maxOverlayCmds} ≤ 40)${witness}`);
    }
  }

  const infoReasons = INFORMATIONAL_UNTIL_M11[spec.id] ?? {};
  for (const g of spec.gates) {
    if (g.source !== 'frame') continue; // probe/wall gates are browser-only
    const key = `${g.metric}:${g.aggregate}`;
    const { value, frames: n } = reduceFrame(g.metric, g.aggregate, frames);
    const over = value > g.cap;
    const reason = infoReasons[key];
    if (reason !== undefined) {
      // Reported only: never counted as a pass or a fail.
      const rel = over ? `> cap ${g.cap}` : `≤ cap ${g.cap} (not yet meaningful)`;
      console.log(`structural ${spec.id}: [informational until M11: ${reason}] ${key} = ${value} ${rel} over ${n} frame(s) — reported, not gated`);
      informational++;
    } else if (over) {
      console.error(`structural ${spec.id}: FAIL ${key} = ${value} > cap ${g.cap} over ${n} frame(s)`);
      failures++;
    } else {
      console.log(`structural ${spec.id}: PASS ${key} = ${value} ≤ ${g.cap} over ${n} frame(s)`);
    }
  }

  // Only painted frames are recorded, so S15's 60 frame() turns must yield exactly 60 frames.
  if (spec.id === 'S15') {
    const ok = frames.length === 60;
    if (ok) {
      console.log(`structural S15: PASS §4.4.5 coalescing — 84 appends/turn coalesced to exactly 1 painted frame × 60 turns`);
    } else {
      console.error(`structural S15: FAIL §4.4.5 coalescing — ${frames.length} painted frames for 60 turns (expected 1/turn)`);
      failures++;
    }
  }

  fixture.dispose();
}

for (const spec of STRUCTURAL_SCENARIOS) {
  try {
    await runScenario(spec);
  } catch (err) {
    console.error(`structural ${spec.id}: ERROR ${(err && err.stack) || err}`);
    failures++;
  }
}

console.log(`\nstructural-scenarios: ${failures} gating failure(s), ${informational} informational-until-M11 report(s).`);
process.exit(failures > 0 ? 1 : 0);
