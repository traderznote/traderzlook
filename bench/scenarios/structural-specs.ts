// Structural-invariant scenarios: exact frame-counter gates that run headless (structural.mjs).
// The same scripts also run in the browser driver.
import type { ScenarioSpec, BenchChart } from '../gates';
import { exactGate, frameGate } from '../gates';

async function crosshairSweep(chart: BenchChart, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.crosshairMove(200 + i * 10, 300);
}

async function panRun(chart: BenchChart, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.pan(5);
}

// S2: crosshair sweep with no listeners. Overlay frames composite only the overlay bands, so base
// sources never re-emit.
const S2: ScenarioSpec = {
  id: 'S2',
  scene: 'R1',
  async script(chart) {
    await crosshairSweep(chart, 120);
  },
  gates: [
    frameGate('drawCommands', 'max', 40),
    exactGate('inputLagFrames', 2),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

// S2b: S2 with one crosshairMoved listener; its payload must not make Overlay frames touch base bands.
const S2b: ScenarioSpec = {
  id: 'S2b',
  scene: 'R1',
  async script(chart, harness) {
    await harness.probe('listenerAttached'); // node adapter intercepts → attaches the listener
    await crosshairSweep(chart, 120);
  },
  gates: [
    frameGate('drawCommands', 'max', 40),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

// S3: anchored wheel zoom. The wheel-normalization values are checked in micro/goldens.mjs.
const S3: ScenarioSpec = {
  id: 'S3',
  scene: 'R1',
  async script(chart) {
    for (let i = 0; i < 60; i++) await chart.wheel(800, 450, i < 30 ? -120 : 120);
  },
  gates: [
    frameGate('drawCommands', 'max', 120), // O(runs), not O(bars)
    exactGate('inputLagFrames', 2),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

// S8: pan over the decimated R2 scene. Decimation collapses each series to one O(deviceWidth)
// stream, hence a lower command cap than R1.
const S8: ScenarioSpec = {
  id: 'S8',
  scene: 'R2',
  async script(chart) {
    await panRun(chart, 60);
  },
  gates: [
    frameGate('drawCommands', 'max', 60),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

// S15: sustained burst of 84 appends per rAF. Each turn must paint exactly one frame, and
// incremental appends must not rebuild the timeline.
const S15: ScenarioSpec = {
  id: 'S15',
  scene: 'R1',
  async script(chart) {
    let base = 100_000; // past the R1 window's end → genuine appends, not updateLast
    for (let f = 0; f < 60; f++) {
      for (let i = 0; i < 84; i++) chart.update(0, { time: base + f * 84 + i, value: 100 });
      await chart.frame(); // exactly one painted frame per rAF period
    }
  },
  gates: [
    exactGate('timelineRebuilds', 0),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

// S16: crosshair sweep and pan with 100 price lines and 10k markers. Price lines live in the base
// bands only, and draw commands scale with the visible markers, not all 10k.
const S16: ScenarioSpec = {
  id: 'S16',
  scene: 'R6',
  async script(chart) {
    await crosshairSweep(chart, 120); // Overlay
    await panRun(chart, 60); // Render pan
  },
  gates: [
    frameGate('drawCommands', 'max', 220),
    exactGate('cachedListIdentityViolations', 0),
  ],
};

export const STRUCTURAL_SCENARIOS: readonly ScenarioSpec[] = [S2, S2b, S3, S8, S15, S16];

const ID_VIOLATIONS_INFO =
  'per-frame dirtiness tracking — the live composite path never bumps cachedListIdentityViolations (only assertCleanIdentity does), so the lane reads 0 vacuously';
const INPUT_LAG_INFO = 'host input-lag source — inputLagFrames is hardcoded () => 0 in create-chart.ts until M11 wires it';
/** Gates the runner reports instead of counting, keyed by scenario and `metric:aggregate`: either
 *  the cap depends on an unbuilt feature, or the lane always reads 0 so the gate cannot fail. */
export const INFORMATIONAL_UNTIL_M11: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  S2: {
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
    'inputLagFrames:exact': INPUT_LAG_INFO,
  },
  S2b: { 'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO },
  S3: {
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
    'inputLagFrames:exact': INPUT_LAG_INFO,
  },
  S8: {
    'drawCommands:max': '≤ 60 decimated cap needs the §6.3 emit-time decimation path',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
  S15: {
    'timelineRebuilds:exact':
      'data-work moves into applyRender — the lane is reset at frame entry while M9 does setData/update data-work synchronously before the frame, so it reads 0 vacuously',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
  S16: {
    'drawCommands:max': '≤ 220 cap needs price-line + marker scene-source emit',
    'cachedListIdentityViolations:exact': ID_VIOLATIONS_INFO,
  },
};
