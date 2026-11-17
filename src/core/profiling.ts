// Per-frame counters, compiled out without __TN_PROFILE__. The host resets them at
// frame() entry and reads them at endFrame(); producing layers only increment.

export interface IFrameCounters {
  /** `updateLast` must leave this at 0. */
  timelineRebuilds: number;
  /** Min/max chunks recomputed; at most 1 per series on a live tick. */
  chunkRecomputes: number;
  sourcesReEmitted: number;
  sourcesCached: number;
  displayLists: number;
  drawCommands: number;
  /** A clean source returned a non-identical array; must stay 0. */
  cachedListIdentityViolations: number;
  replayMs: number;
  /** Should be 0 after warm-up. */
  bufferReallocs: number;
  reset(): void;
}

export class FrameCounters implements IFrameCounters {
  timelineRebuilds = 0;
  chunkRecomputes = 0;
  sourcesReEmitted = 0;
  sourcesCached = 0;
  displayLists = 0;
  drawCommands = 0;
  cachedListIdentityViolations = 0;
  replayMs = 0;
  bufferReallocs = 0;

  reset(): void {
    this.timelineRebuilds = 0;
    this.chunkRecomputes = 0;
    this.sourcesReEmitted = 0;
    this.sourcesCached = 0;
    this.displayLists = 0;
    this.drawCommands = 0;
    this.cachedListIdentityViolations = 0;
    this.replayMs = 0;
    this.bufferReallocs = 0;
  }
}

export function createFrameCounters(): IFrameCounters {
  return new FrameCounters();
}
