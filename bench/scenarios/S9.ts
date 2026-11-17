// S9: 40 resize steps, each a Layout frame (the runner resizes the container before each paint).
import { scenario, frameGate, frames } from './_shared';

export default scenario({
  id: 'S9',
  scene: 'R1',
  async script(chart) {
    await frames(chart, 40);
  },
  gates: [
    frameGate('totalMs', 'p95', 20),
  ],
});
