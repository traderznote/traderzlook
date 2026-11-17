// Per-frame bench stats (__TN_PROFILE__ only; compiles out otherwise).
import type { UpdateLevel } from '../model';

/** `*Ms` are host performance.now() brackets; the count lanes are copied from IFrameCounters after paint. */
export interface FrameStats {
  level: UpdateLevel;
  totalMs: number; // frame() entry → paint complete
  layoutMs: number; // Layout phase (0 unless level === Layout)
  modelMs: number; // autoscale + horz commands + axis models
  emitMs: number; // dirty sources: update() + displayLists() rebuild
  replayMs: number; // sum of renderLayer durations this frame
  sourcesUpdated: number; // update() calls issued
  sourcesReEmitted: number; // sources that rebuilt lists (dirty)
  sourcesCached: number; // sources that returned cached lists (identity-checked)
  displayLists: number;
  drawCommands: number;
  bufferReallocs: number; // ItemBuffer/DisplayListBuilder backing-store growths
  timelineRebuilds: number;
  chunkRecomputes: number; // min/max chunks recomputed
  cachedListIdentityViolations: number; // must stay 0
  inputLagFrames: number; // max rAF periods input-arrival → this paint; 0 if none
}

export interface IPerfSink {
  onFrame(stats: FrameStats): void;
}
