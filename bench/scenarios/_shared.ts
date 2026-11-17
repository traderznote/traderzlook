// Helpers shared by the per-scenario files.
import type { BenchChart, ScenarioSpec } from '../gates';

export type { BenchChart, BenchHarness, MetricGate, ScenarioSpec } from '../gates';
export { frameGate, exactGate, wallGate, probeGate, layoutFrameCountGate } from '../gates';

export async function frames(chart: Pick<BenchChart, 'frame'>, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await chart.frame();
}

/** Identity helper that types a scenario's object literal. */
export function scenario(spec: ScenarioSpec): ScenarioSpec {
  return spec;
}
