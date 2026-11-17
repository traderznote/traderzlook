// Scenario catalog: each scenario pairs a scene with a script and the gates it declares.
// The scripts run in the browser page; run.mjs reads the gates as plain data.
import type { ScenarioSpec } from './gates';
import { frameGate, exactGate, wallGate, probeGate, layoutFrameCountGate, markInformationalUntilM11 } from './gates';

// Reasons for gates whose values are not yet meaningful (reported, never counted as a pass).
const INFO_INPUT_LAG = 'host input-lag source — inputLagFrames is hardcoded () => 0 in create-chart.ts until M11 wires it';
const INFO_DATA_LANE = 'data-work moves into applyRender — these data lanes (timelineRebuilds/chunkRecomputes) are reset at frame entry while M9 does setData/update data-work synchronously before the frame, so they read 0 vacuously';
const INFO_ID_VIOLATIONS = 'per-frame dirtiness tracking — the live composite path never bumps cachedListIdentityViolations (only assertCleanIdentity does), so the lane reads 0 vacuously';

async function frames(chart: { frame(): Promise<void> }, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.frame();
}

export const SCENARIOS: readonly ScenarioSpec[] = [
  // S1: cold init to first paint.
  {
    id: 'S1',
    scene: 'R0',
    async script(chart) { await chart.frame(); },
    gates: [wallGate(60)], // createChart → first painted frame
  },

  // S2: crosshair sweep with no listeners.
  {
    id: 'S2',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 120; i++) { await chart.crosshairMove(200 + i * 10, 300); }
    },
    gates: [
      frameGate('totalMs', 'p95', 4),
      frameGate('drawCommands', 'max', 40),
      markInformationalUntilM11(exactGate('inputLagFrames', 2), INFO_INPUT_LAG),
      probeGate('heapPerFrameBytes', 512, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S2b: the same sweep with one crosshairMoved listener, which gets its own allocation budget.
  {
    id: 'S2b',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 120; i++) { await chart.crosshairMove(200 + i * 10, 300); }
    },
    gates: [
      frameGate('totalMs', 'p95', 4),
      probeGate('heapPerFrameBytes', 2048, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S3: anchored wheel zoom, in then out.
  {
    id: 'S3',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 60; i++) { await chart.wheel(800, 450, i < 30 ? -120 : 120); }
    },
    gates: [
      frameGate('totalMs', 'p95', 10),
      markInformationalUntilM11(exactGate('inputLagFrames', 2), INFO_INPUT_LAG),
      probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
    ],
  },

  // S4: kinetic fling until it settles.
  {
    id: 'S4',
    scene: 'R1',
    async script(chart) {
      await chart.pan(40); // initiate a fling; the kinetic animation re-arms until settle
      await frames(chart, 60);
    },
    gates: [
      frameGate('totalMs', 'p95', 8),
      exactGate('bufferReallocs', 0),
    ],
  },

  // S5: live ticks in two phases.
  {
    id: 'S5',
    scene: 'R1',
    async script(chart) {
      // Phase A: same-time updates on all 5 series.
      for (let i = 0; i < 600; i++) {
        for (let s = 0; s < 5; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i) });
        await chart.frame();
      }
      // Phase B: a square wave across a digit boundary, holding each value for 10 frames.
      for (let i = 0; i < 3600; i++) {
        const v = Math.floor(i / 10) % 2 === 0 ? 99.99 : 100.01;
        for (let s = 0; s < 5; s++) chart.update(s, { time: 0, value: v });
        await chart.frame();
      }
    },
    gates: [
      frameGate('totalMs', 'p95', 6),
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE),
      markInformationalUntilM11(exactGate('chunkRecomputes', 1), INFO_DATA_LANE),
      // The square wave may widen the axis labels at most twice.
      layoutFrameCountGate(2),
      frameGate('layoutMs', 'sum', 40), // secondary guard; a layout frame is ~20 ms
    ],
  },

  // S6: 1000 appends in one turn must coalesce into a single painted frame.
  {
    id: 'S6',
    scene: 'R1',
    async script(chart) {
      for (let i = 0; i < 1000; i++) chart.update(0, { time: 1000 + i, value: 100 + i * 0.01 });
      await chart.frame(); // the one coalesced frame
    },
    gates: [
      wallGate(200), // turn entry → paint complete
    ],
  },

  // S7: setData replace.
  {
    id: 'S7',
    scene: 'R1',
    async script(chart) { chart.setData(0, []); await chart.frame(); },
    gates: [wallGate(320)], // setData → next painted frame
  },

  // S8: decimated pan over 1M points.
  {
    id: 'S8',
    scene: 'R2',
    async script(chart) { for (let i = 0; i < 60; i++) await chart.pan(5); },
    gates: [
      frameGate('totalMs', 'p95', 16),
      frameGate('drawCommands', 'max', 60),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS),
    ],
  },

  // S9: resize drag.
  {
    id: 'S9',
    scene: 'R1',
    async script(chart) { await frames(chart, 40); },
    gates: [frameGate('totalMs', 'p95', 20)],
  },

  // S10: pan with 50 series.
  {
    id: 'S10',
    scene: 'R3',
    async script(chart) { for (let i = 0; i < 60; i++) await chart.pan(5); },
    gates: [
      frameGate('totalMs', 'p95', 12),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS),
    ],
  },

  // S11: a color change every frame must not touch the data store.
  {
    id: 'S11',
    scene: 'R1',
    async script(chart) { for (let i = 0; i < 300; i++) await chart.frame(); },
    gates: [
      frameGate('totalMs', 'p95', 6),
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE),
    ],
  },

  // S12: memory attribution; each budget is a heap delta between setData steps.
  {
    id: 'S12',
    scene: 'R2',
    async script(chart, harness) {
      await harness.probe('empty');
      chart.setData(0, []); await harness.probe('afterA'); // line A: lanes + timeline slots
      chart.setData(1, []); await harness.probe('afterB'); // line B: lanes only (slots are shared)
      chart.setData(2, []); await harness.probe('afterC'); // candle lanes only
    },
    gates: [
      probeGate('bytesPerPoint', 24, { from: 'afterA', to: 'afterB', perPoints: 1e6, repeats: 3 }),
      probeGate('bytesPerPoint', 48, { from: 'afterB', to: 'afterC', perPoints: 1e6, repeats: 3 }),
      // Timeline slot = (afterA − empty) − (afterB − afterA). Swapping a pair negates the value.
      probeGate('bytesPerPoint', 32, {
        from: 'empty', to: 'afterA', from2: 'afterA', to2: 'afterB', perPoints: 1e6, repeats: 3,
      }),
    ],
  },

  // S13: pan and crosshair sweep across 4 panes.
  {
    id: 'S13',
    scene: 'R4',
    async script(chart) {
      for (let i = 0; i < 60; i++) await chart.pan(5);
      for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300);
    },
    gates: [
      frameGate('totalMs', 'p95', 10),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS),
    ],
  },

  // S14: live ticks across 20 series.
  {
    id: 'S14',
    scene: 'R5',
    async script(chart) {
      for (let i = 0; i < 600; i++) {
        for (let s = 0; s < 20; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i + s) });
        await chart.frame();
      }
    },
    gates: [
      frameGate('totalMs', 'p95', 8),
      markInformationalUntilM11(exactGate('timelineRebuilds', 0), INFO_DATA_LANE),
    ],
  },

  // S15: sustained burst of 84 updates per rAF (~5000/s).
  {
    id: 'S15',
    scene: 'R1',
    async script(chart) {
      for (let f = 0; f < 300; f++) {
        for (let i = 0; i < 84; i++) chart.update(0, { time: 2000 + f * 84 + i, value: 100 });
        await chart.frame(); // exactly one painted frame per rAF period
      }
    },
    gates: [frameGate('totalMs', 'p95', 6)],
  },

  // S16: crosshair sweep and pan with 100 price lines and 10k markers.
  {
    id: 'S16',
    scene: 'R6',
    async script(chart) {
      for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300); // Overlay
      for (let i = 0; i < 60; i++) await chart.pan(5); // Render pan
    },
    gates: [
      frameGate('totalMs', 'p95', 12),
      frameGate('drawCommands', 'max', 220), // scales with visible markers, not all 10k
      layoutFrameCountGate(2), // static label-width ratchet
      frameGate('layoutMs', 'sum', 40),
      markInformationalUntilM11(exactGate('cachedListIdentityViolations', 0), INFO_ID_VIOLATIONS),
    ],
  },

  // S17: nightly smoke (5M points, many series and panes); reports wall times only.
  {
    id: 'S17',
    scene: 'smoke',
    async script(chart) { await chart.frame(); await chart.pan(5); },
    gates: [],
  },
];
