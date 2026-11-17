// Typed regression-gate model: scenarios declare gates, run.mjs evaluates them.
import type { FrameStats } from '../src/host/profiling';

// 'frame' metrics come from the per-frame FrameStats stream; 'probe' metrics are heap deltas
// between CDP snapshots taken at the script's harness.probe() calls.
export type MetricSource = 'frame' | 'probe';

/** `layoutFrames` is derived: the count of Layout-level frames in a run (not the layoutMs sum). */
export type MetricName =
  | keyof FrameStats
  | 'heapPerFrameBytes'
  | 'bytesPerPoint'
  | 'wallMs'
  | 'layoutFrames';

/** Probe gates use 'min' across `repeats` runs (the GC floor). */
export type Aggregate = 'p95' | 'avg' | 'max' | 'sum' | 'exact' | 'min';

export interface ProbeSpec {
  from: string;
  to: string; // value = heapUsed(to) − heapUsed(from)
  from2?: string;
  to2?: string; // derived gate only: value = (to−from)Δ − (to2−from2)Δ
  perFrames?: number; // divide the (possibly derived) Δ by this frame count
  perPoints?: number; // divide by this point count
  repeats: number; // the gated value is the MIN over N runs (GC floor)
}

/** `cap` is the hard limit; `driftFailPct` (default 20) fails on drift from baselines.json. */
export interface MetricGate {
  source: MetricSource;
  metric: MetricName;
  aggregate: Aggregate;
  cap: number;
  driftFailPct?: number;
  probe?: ProbeSpec; // 'probe'-source only
  // When set, the gate is reported with this reason but never counted as a pass or fail,
  // because its value is not yet meaningful in the current pipeline.
  informationalUntilM11?: string;
}

export type SceneId = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6' | 'smoke';

/** The chart surface a scenario drives; structural so node and browser share the scripts. */
export interface BenchChart {
  setData(seriesIndex: number, data: readonly unknown[]): void;
  update(seriesIndex: number, point: unknown): void;
  // Coordinates are device px.
  crosshairMove(x: number, y: number): Promise<void>;
  wheel(x: number, y: number, deltaY: number): Promise<void>;
  pan(dxBars: number): Promise<void>;
  // Resolves once the next scheduled frame has painted.
  frame(): Promise<void>;
}

/** `probe(label)` marks where the runner takes a heap snapshot; frame-only scenarios never call it. */
export interface BenchHarness {
  probe(label: string): Promise<void>;
}

export interface ScenarioSpec {
  id: string;
  scene: SceneId;
  script(chart: BenchChart, harness: BenchHarness): Promise<void>;
  gates: readonly MetricGate[];
}

export function frameGate(
  metric: keyof FrameStats,
  aggregate: Exclude<Aggregate, 'min'>,
  cap: number,
  driftFailPct?: number,
): MetricGate {
  return { source: 'frame', metric, aggregate, cap, driftFailPct };
}

/** Exact structural-invariant gate: immune to runner noise, so no drift allowance. */
export function exactGate(metric: keyof FrameStats, cap: number): MetricGate {
  return { source: 'frame', metric, aggregate: 'exact', cap, driftFailPct: 0 };
}

/** Exact cap on the number of Layout-level frames in a run (a count, not the layoutMs timing). */
export function layoutFrameCountGate(cap: number): MetricGate {
  return { source: 'frame', metric: 'layoutFrames', aggregate: 'exact', cap, driftFailPct: 0 };
}

/** Report the gate with `reason` instead of counting it. Returns a new gate (catalog gates are shared). */
export function markInformationalUntilM11(gate: MetricGate, reason: string): MetricGate {
  return { ...gate, informationalUntilM11: reason };
}

/** Wall time from script entry to the last paint. */
export function wallGate(cap: number, driftFailPct?: number): MetricGate {
  return { source: 'frame', metric: 'wallMs', aggregate: 'max', cap, driftFailPct };
}

/** Heap Δ between two probe labels ÷ perFrames/perPoints, min over `repeats` runs. */
export function probeGate(
  metric: 'heapPerFrameBytes' | 'bytesPerPoint',
  cap: number,
  probe: ProbeSpec,
): MetricGate {
  return { source: 'probe', metric, aggregate: 'min', cap, probe };
}
