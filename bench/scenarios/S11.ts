// S11: a series color change every frame (applied by the runner before each frame). An option
// change must only re-emit, never rebuild store or timeline data.
import { scenario, frameGate, exactGate } from './_shared';

export default scenario({
  id: 'S11',
  scene: 'R1',
  async script(chart) {
    for (let i = 0; i < 300; i++) await chart.frame();
  },
  gates: [
    frameGate('totalMs', 'p95', 6),
    exactGate('timelineRebuilds', 0),
  ],
});
