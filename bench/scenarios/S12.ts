// S12: per-point memory attribution. All three series share the same 1M timestamps, so once
// line A has filled the time pool, line B and the candles add only their own lanes.
import { scenario, probeGate } from './_shared';

const POINTS = 1e6;

export default scenario({
  id: 'S12',
  scene: 'R2',
  async script(chart, harness) {
    await harness.probe('empty');
    chart.setData(0, []); // line A: line lanes + timeline slots
    await harness.probe('afterA');
    chart.setData(1, []); // line B: line lanes only
    await harness.probe('afterB');
    chart.setData(2, []); // candle lanes only
    await harness.probe('afterC');
  },
  gates: [
    probeGate('bytesPerPoint', 24, { from: 'afterA', to: 'afterB', perPoints: POINTS, repeats: 3 }),
    probeGate('bytesPerPoint', 48, { from: 'afterB', to: 'afterC', perPoints: POINTS, repeats: 3 }),
    // Timeline slots: (afterA − empty) − (afterB − afterA).
    probeGate('bytesPerPoint', 32, {
      from: 'empty', to: 'afterA', from2: 'afterA', to2: 'afterB', perPoints: POINTS, repeats: 3,
    }),
  ],
});
