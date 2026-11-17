// S10: pan with 50 line series; clean sources must reuse their cached display lists.
import { scenario, frameGate, exactGate, probeGate } from './_shared';

export default scenario({
  id: 'S10',
  scene: 'R3',
  async script(chart, harness) {
    await harness.probe('windowStart');
    for (let i = 0; i < 60; i++) await chart.pan(5);
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 12),
    exactGate('cachedListIdentityViolations', 0),
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
