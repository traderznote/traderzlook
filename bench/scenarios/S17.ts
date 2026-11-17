// S17: nightly smoke on very large scenes. Passes if the first paint and one pan complete without
// error; wall times are reported, never gated.
import { scenario, frames } from './_shared';

export default scenario({
  id: 'S17',
  scene: 'smoke',
  async script(chart) {
    await frames(chart, 1);
    await chart.pan(5);
  },
  gates: [],
});
