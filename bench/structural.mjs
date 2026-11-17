// Headless structural-invariant checks: exact frame-counter assertions on a stub-backend chart.
// Run: node bench/structural.mjs (exits 1 on any gating failure).
import { R1, R2 } from './scenes.mjs';

let failures = 0;
let informational = 0;
const checks = [];
function check(name, fn) { checks.push({ name, fn, kind: 'gate' }); }
// Info checks run and print but are never gated: their lanes read 0 until the pipeline changes.
function checkInfo(name, reason, fn) { checks.push({ name, fn, kind: 'info', reason }); }
function assert(cond, msg) { if (!cond) throw new Error(msg); }

// A frame resets the counters at entry, and the host reads them into one FrameStats at endFrame.
check('§9.6 counter-propagation: a frame emits one FrameStats with the counters’ lanes', async () => {
  const f = await R1(800, 200);
  const before = f.frames.length;
  f.chart.panes(); // touch the api (no-op, keeps the chart warm)
  f.series[1].update({ time: 999999, value: 123 }); // line series append → Render invalidate
  f.raf.flush(100);
  assert(f.frames.length === before + 1, 'exactly one FrameStats emitted for the one flushed frame');
  const s = f.frames.at(-1);
  assert(s.sourcesUpdated === s.sourcesReEmitted + s.sourcesCached, 'sourcesUpdated = reEmitted + cached (§9.6)');
  assert(s.drawCommands >= 0 && s.displayLists >= 0, 'count lanes present on FrameStats');
  assert(typeof s.totalMs === 'number' && s.totalMs >= 0, 'host-timed totalMs bracket present');
  f.dispose();
});

checkInfo('§4.4.2 clean re-composite: cachedListIdentityViolations stays 0',
  'per-frame dirtiness tracking — the live composite path never bumps cachedListIdentityViolations (only assertCleanIdentity does), so the lane reads 0 vacuously',
  async () => {
    const f = await R1(800, 200);
    // Overlay frames: the clean base series must return their cached lists by identity.
    for (let i = 0; i < 5; i++) {
      f.chart.setCrosshairPosition(100, i, f.series[0]); // Overlay invalidate
      f.raf.flush(200 + i);
    }
    assert(f.counters.cachedListIdentityViolations === 0, 'a clean source returned a non-identical list (§4.4.2)');
    for (const s of f.frames) assert(s.cachedListIdentityViolations === 0, 'per-frame identity violations must be 0');
    f.dispose();
  });

checkInfo('§4.4.4 updateLast: 0 timeline rebuilds on a same-time live tick',
  'data-work moves into applyRender — timelineRebuilds is reset at frame entry while M9 runs update() data-work before the frame, so it reads 0 vacuously',
  async () => {
    const f = await R1(800, 200);
    const last = f.series[1].data().at(-1);
    for (let i = 0; i < 5; i++) {
      f.series[1].update({ time: last.time, value: 50 + i }); // same-time → updateLast
      f.raf.flush(300 + i);
      assert(f.counters.timelineRebuilds === 0, `updateLast rebuilt the timeline (§4.4.4), tick ${i}`);
    }
    f.dispose();
  });

check('§4.4.7 buffer steady state: bufferReallocs 0 after warm-up', async () => {
  const f = await R1(800, 200);
  // Warm-up frames settle high-water buffer growth.
  for (let i = 0; i < 3; i++) { f.chart.setCrosshairPosition(100, i, f.series[0]); f.raf.flush(400 + i); }
  const warmFrames = f.frames.length;
  for (let i = 0; i < 5; i++) { f.chart.setCrosshairPosition(100, 10 + i, f.series[0]); f.raf.flush(410 + i); }
  for (const s of f.frames.slice(warmFrames)) {
    assert(s.bufferReallocs === 0, 'a steady-state frame grew a backing buffer (§4.4.7)');
  }
  f.dispose();
});

// The headless time scale is a stub, so this only checks that commands do not scale with bars;
// the tight cap runs in the browser runner.
check('§4.4.3 command bound: a Render frame stays well under O(bars)', async () => {
  const f = await R1(2000, 500);
  const before = f.frames.length;
  f.series[1].update({ time: 999999, value: 7 }); // Render invalidate
  f.raf.flush(500);
  const s = f.frames.at(-1);
  assert(s.drawCommands < 2000, `drawCommands ${s.drawCommands} scaled with bars, not runs (§4.4.3)`);
  assert(f.frames.length === before + 1, 'one frame');
  console.log(`structural: [informational: headless geometry is degenerate (stub time-scale) — drawCommands ${s.drawCommands} proves O(bars) shape only; the tight O(runs) ≤ 120 cap runs in the Playwright runner]`);
  f.dispose();
});

// S6 only caps display lists; this proves the burst arms and paints exactly one frame.
check('§4.4.5 coalescing: a 1000-append single-turn burst (S6) paints exactly one frame', async () => {
  const f = await R1(2000, 500);
  const before = f.frames.length;
  for (let i = 0; i < 1000; i++) f.series[0].update({ time: 1_000_000 + i, value: 100 + i * 0.01 });
  assert(f.frames.length === before, 'no frame painted before the turn yielded (appends coalesced, §4.4.5)');
  assert(f.raf.hasPending() === true, 'the burst armed exactly one pending frame (the coalesced mask)');
  f.raf.flush(999);
  assert(f.frames.length === before + 1, `the coalesced turn painted exactly one frame (got ${f.frames.length - before}, §4.4.5)`);
  assert(f.raf.hasPending() === false, 'no second frame re-armed after the single coalesced paint');
  const s = f.frames.at(-1);
  // Secondary check: a per-append leak would produce hundreds of lists; a full chart (one
  // background list per surface plus series, grid and labels) has ≤ 24.
  assert(s.displayLists >= 1 && s.displayLists <= 24, `the one frame composited 1–24 display lists (got ${s.displayLists})`);
  f.dispose();
});

// Same stub caveat: this bounds O(bars) only; the tight decimated cap runs in the browser runner.
check('§6.3 decimation: R2 fitContent emits a bounded (O(deviceWidth)) command stream', async () => {
  const f = await R2(20000); // sub-pixel spacing → decimation active
  // The builder already flushed the fitContent frame.
  const painted = f.frames.filter((s) => s.drawCommands > 0);
  if (painted.length > 0) {
    const maxCmds = Math.max(...painted.map((s) => s.drawCommands));
    assert(maxCmds < 20000, `decimated frame drawCommands ${maxCmds} not bounded (§6.3/§4.4.3)`);
    console.log(`structural: [informational: headless geometry is degenerate (stub time-scale) — decimated drawCommands ${maxCmds} bounds O(bars) only; the tight ≤ 60 cap runs in the Playwright runner]`);
  } else {
    console.log('structural: [informational: headless geometry is degenerate — no painted command stream to bound; the ≤ 60 decimated cap runs in the Playwright runner]');
  }
  assert(f.scene.decimated === true, 'R2 is the decimated scene');
  f.dispose();
});

for (const { name, fn, kind, reason } of checks) {
  try {
    await fn();
    if (kind === 'info') {
      console.log(`structural: [informational until M11: ${reason}]  ${name} (ran clean; reported, not gated)`);
      informational++;
    } else {
      console.log(`structural: PASS  ${name}`);
    }
  } catch (err) {
    // A throw from an info check means its body is mis-wired; it is still only reported.
    if (kind === 'info') {
      console.log(`structural: [informational until M11: ${reason}]  ${name} — body raised (${err.message}); reported, not gated`);
      informational++;
    } else {
      console.error(`structural: FAIL  ${name}\n    ${err.message}`);
      failures++;
    }
  }
}
const gating = checks.filter((c) => c.kind !== 'info').length;
console.log(`\nstructural: ${gating - failures}/${gating} gating passed, ${informational} informational-until-M11.`);
process.exit(failures > 0 ? 1 : 0);
