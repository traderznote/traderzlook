// S13: pan, then a crosshair sweep, across 4 panes. The p95 cap is the Render budget, which binds
// for the combined stream.
import { scenario, frameGate, exactGate, probeGate } from './_shared';

export default scenario({
  id: 'S13',
  scene: 'R4',
  async script(chart, harness) {
    for (let i = 0; i < 60; i++) await chart.pan(5);
    // Bracket only the crosshair phase so its allocation cap is not diluted by Render frames.
    await harness.probe('windowStart');
    for (let i = 0; i < 120; i++) await chart.crosshairMove(200 + i * 10, 300);
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 10),
    exactGate('cachedListIdentityViolations', 0),
    probeGate('heapPerFrameBytes', 512, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
