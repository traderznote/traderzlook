// S5: live ticks on all 5 series. Phase A ticks steadily; phase B is a square wave across a digit
// boundary that the grow-only axis-width ratchet must absorb in at most 2 Layout frames.
import { scenario, frameGate, exactGate, probeGate, layoutFrameCountGate } from './_shared';

const SERIES = 5; // R1 has 5 series

export default scenario({
  id: 'S5',
  scene: 'R1',
  async script(chart, harness) {
    await harness.probe('windowStart');
    for (let i = 0; i < 600; i++) {
      const v = 100 + Math.sin(i * 0.1); // never changes the digit count
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: v });
      await chart.frame();
    }
    await harness.probe('windowEnd');
    // Each value is held 10 frames, deliberately shorter than the 30-frame shrink damper.
    for (let i = 0; i < 3600; i++) {
      const v = Math.floor(i / 10) % 2 === 0 ? 99.99 : 100.01;
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: v });
      await chart.frame();
    }
  },
  gates: [
    frameGate('totalMs', 'p95', 6),
    exactGate('timelineRebuilds', 0), // updateLast touches no timeline
    exactGate('chunkRecomputes', SERIES), // ≤ 1 chunk recompute per series per tick
    layoutFrameCountGate(2), // expected exactly 1
    frameGate('layoutMs', 'sum', 40), // secondary timing guard
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
