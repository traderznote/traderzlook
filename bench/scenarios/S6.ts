// S6: 1000 appends in one event-loop turn must coalesce into a single painted frame.
import { scenario, wallGate, exactGate } from './_shared';

export default scenario({
  id: 'S6',
  scene: 'R1',
  async script(chart) {
    // No await between updates, so they all merge into one pending frame.
    for (let i = 0; i < 1000; i++) chart.update(0, { time: 1_000_000 + i, value: 100 + i * 0.01 });
    await chart.frame(); // the one coalesced frame
  },
  gates: [
    wallGate(200), // turn entry → paint complete of the coalesced frame
    // This only caps lists per frame; bench/structural.mjs asserts the single-frame count.
    exactGate('displayLists', 5), // R1 has 5 series → ≤ 5 display lists on the single frame
  ],
});
