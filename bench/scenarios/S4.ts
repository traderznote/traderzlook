// S4: a kinetic fling glides until it settles. A steady-state path, so no buffer reallocations.
import { scenario, frameGate, exactGate, probeGate, frames } from './_shared';

export default scenario({
  id: 'S4',
  scene: 'R1',
  async script(chart) {
    await chart.pan(40); // initiate the fling; the kinetic settle re-arms frames until rest
    await frames(chart, 60);
  },
  gates: [
    frameGate('totalMs', 'p95', 8),
    exactGate('bufferReallocs', 0), // counted after the warm-up frames are dropped
    probeGate('heapPerFrameBytes', 2048, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
