// S1: cold init to first paint on an empty chart. Cold setData costs are gated by S7.
import { scenario, wallGate } from './_shared';

export default scenario({
  id: 'S1',
  scene: 'R0',
  // The harness has already painted the initial frame; the wall clock starts at script entry.
  async script(chart) {
    await chart.frame();
  },
  gates: [
    wallGate(60), // createChart → first painted frame
  ],
});
