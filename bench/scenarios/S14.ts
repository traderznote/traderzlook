// S14: same-time live ticks across 20 line series.
import { scenario, frameGate, exactGate, probeGate } from './_shared';

const SERIES = 20;

export default scenario({
  id: 'S14',
  scene: 'R5',
  async script(chart, harness) {
    await harness.probe('windowStart');
    for (let i = 0; i < 600; i++) {
      for (let s = 0; s < SERIES; s++) chart.update(s, { time: 0, value: 100 + Math.sin(i * 0.1 + s) });
      await chart.frame();
    }
    await harness.probe('windowEnd');
  },
  gates: [
    frameGate('totalMs', 'p95', 8),
    exactGate('timelineRebuilds', 0), // updateLast touches no timeline
    exactGate('chunkRecomputes', SERIES), // ≤ 1 chunk recompute per series per tick
    probeGate('heapPerFrameBytes', 4096, { from: 'windowStart', to: 'windowEnd', perFrames: 300, repeats: 3 }),
  ],
});
