// S7: setData replace, timed from the call to the next paint. The 1M-point case is covered by S12.
import { scenario, wallGate } from './_shared';

export default scenario({
  id: 'S7',
  scene: 'R1',
  async script(chart) {
    // The runner re-feeds the seeded R1 data for this replace.
    chart.setData(0, []);
    await chart.frame();
  },
  gates: [
    wallGate(320), // setData → next painted frame
  ],
});
