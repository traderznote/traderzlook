// Per-chart frame loop: one pending UpdateMask, one rAF, a cap-2 layout-until-stable
// loop, paint per UpdateLevel, and a synchronous flush for resize/screenshot.
import { assert, type Unsubscribe, type IFrameCounters } from '../core';
import { UpdateLevel, type UpdateMask, createMask, emptyMask, mergeMasks } from '../model';
import type { FrameStats, IPerfSink } from './profiling';

export type FrameCallback = (now: number) => void; // rAF-epoch milliseconds

// One tick services every callback scheduled before it, in order, with the SAME `now`;
// a `schedule` issued during a tick lands in the NEXT tick.
export interface IFrameScheduler {
  /** Run cb once at the next frame tick. Returns a cancel; cancelling after fire is a no-op. */
  schedule(cb: FrameCallback): Unsubscribe;
  dispose(): void;
}

// Injected instead of the globals so tests can drive frames synchronously.
export interface RafEnv {
  requestAnimationFrame(cb: (now: number) => void): number;
  cancelAnimationFrame(handle: number): void;
}

/** Wraps one rAF and fans each tick out to every scheduled callback, so charts sharing
 * a scheduler paint in one frame with one timestamp. */
export function createRafScheduler(env: RafEnv): IFrameScheduler {
  let queue: FrameCallback[] = [];
  let handle: number | null = null;
  let disposed = false;

  const tick = (now: number): void => {
    handle = null;
    // Snapshot: schedules issued during dispatch must land in the NEXT tick.
    const batch = queue;
    queue = [];
    for (let i = 0; i < batch.length; i++) batch[i]!(now);
  };

  const ensureFrame = (): void => {
    if (handle === null && !disposed) handle = env.requestAnimationFrame(tick);
  };

  return {
    schedule(cb: FrameCallback): Unsubscribe {
      if (__DEV__) assert(!disposed, 'IFrameScheduler.schedule after dispose (architecture §13.6)');
      queue.push(cb);
      ensureFrame();
      let live = true;
      return () => {
        if (!live) return;
        live = false;
        const i = queue.indexOf(cb);
        if (i >= 0) queue.splice(i, 1);
      };
    },
    dispose(): void {
      disposed = true;
      queue = [];
      if (handle !== null) {
        env.cancelAnimationFrame(handle);
        handle = null;
      }
    },
  };
}

export interface FrameDriver {
  /** Layout steps; run only at level === Layout. */
  syncWidgets(): void;
  computeLayout(): void;
  applySizes(): void;
  /** Momentary autoscale, horz-command replay, axis models. Run at level >= Render. */
  applyRender(mask: UpdateMask, now: number): void;
  /** Overlay → overlay layer only; Render/Layout → both layers. */
  paint(level: UpdateLevel, now: number): void;
  /** The level at which an unfinished animation needs the next frame: None, Overlay
   * (e.g. last-price pulse — must never promote), or Render (horz scroll/zoom animation). */
  animationRearmLevel(now: number): UpdateLevel;
}

const LAYOUT_CAP = 2;

// __TN_PROFILE__-only bench bundle. The loop resets `counters` at frame entry and reads
// them after paint. `now()` is a monotonic wall clock, separate from the frame-epoch `now`.
export interface FrameProfiler {
  readonly counters: IFrameCounters;
  readonly sink: IPerfSink;
  now(): number;
  /** rAF periods from the most recent unconsumed input event to a paint; 0 when no input drove this frame. */
  inputLagFrames(): number;
}

export class FrameLoop {
  readonly #scheduler: IFrameScheduler;
  readonly #driver: FrameDriver;
  readonly #prof: FrameProfiler | undefined;
  #pending: UpdateMask = emptyMask();
  #cancel: Unsubscribe | null = null;
  #inFrame = false; // true while frame() runs — re-entrant masks coalesce, don't re-arm
  #disposed = false;

  constructor(scheduler: IFrameScheduler, driver: FrameDriver, prof?: FrameProfiler) {
    this.#scheduler = scheduler;
    this.#driver = driver;
    this.#prof = prof;
  }

  invalidate(mask: UpdateMask): void {
    if (this.#disposed || mask.level === UpdateLevel.None) return;
    this.#pending = mergeMasks(this.#pending, mask);
    // A re-entrant invalidate during frame() must not arm a second callback; the cap-2
    // loop drains it in the same frame, and the post-loop check re-arms once.
    if (!this.#inFrame) this.#arm();
  }

  hasPendingFrame(): boolean {
    return this.#cancel !== null;
  }

  #arm(): void {
    if (this.#cancel !== null || this.#disposed) return;
    this.#cancel = this.#scheduler.schedule((now) => {
      this.#cancel = null;
      this.#runFrame(now);
    });
  }

  #runFrame(now: number): void {
    let work = this.#pending;
    this.#pending = emptyMask();
    if (work.level === UpdateLevel.None) return;

    // Reset counters first so a frame that skips a layer leaves its lanes at 0.
    let t0 = 0;
    let layoutMs = 0;
    let modelMs = 0;
    if (__TN_PROFILE__ && this.#prof !== undefined) {
      this.#prof.counters.reset();
      t0 = this.#prof.now();
    }

    this.#inFrame = true;
    try {
      for (let i = 0; i < LAYOUT_CAP; i++) {
        if (work.level === UpdateLevel.Layout) {
          let ls = 0;
          if (__TN_PROFILE__ && this.#prof !== undefined) ls = this.#prof.now();
          this.#driver.syncWidgets();
          this.#driver.computeLayout();
          this.#driver.applySizes();
          if (__TN_PROFILE__ && this.#prof !== undefined) layoutMs += this.#prof.now() - ls;
        }
        if (work.level >= UpdateLevel.Render) {
          let ms = 0;
          if (__TN_PROFILE__ && this.#prof !== undefined) ms = this.#prof.now();
          this.#driver.applyRender(work, now);
          if (__TN_PROFILE__ && this.#prof !== undefined) modelMs += this.#prof.now() - ms;
        }
        // A mask that arrived during the steps above (e.g. axis width grew) merges in
        // and the loop re-runs, capped at LAYOUT_CAP iterations.
        if (this.#pending.level === UpdateLevel.None) break;
        work = mergeMasks(work, this.#pending);
        this.#pending = emptyMask();
      }
      let ps = 0;
      if (__TN_PROFILE__ && this.#prof !== undefined) ps = this.#prof.now();
      this.#driver.paint(work.level, now);
      // emitMs = paint wall minus the backend's replayMs, so the two are disjoint.
      if (__TN_PROFILE__ && this.#prof !== undefined) {
        const c = this.#prof.counters;
        const tEnd = this.#prof.now();
        const emitMs = Math.max(0, tEnd - ps - c.replayMs);
        const stats: FrameStats = {
          level: work.level,
          totalMs: tEnd - t0,
          layoutMs,
          modelMs,
          emitMs,
          replayMs: c.replayMs,
          sourcesUpdated: c.sourcesReEmitted + c.sourcesCached,
          sourcesReEmitted: c.sourcesReEmitted,
          sourcesCached: c.sourcesCached,
          displayLists: c.displayLists,
          drawCommands: c.drawCommands,
          bufferReallocs: c.bufferReallocs,
          timelineRebuilds: c.timelineRebuilds,
          chunkRecomputes: c.chunkRecomputes,
          cachedListIdentityViolations: c.cachedListIdentityViolations,
          inputLagFrames: this.#prof.inputLagFrames(),
        };
        this.#prof.sink.onFrame(stats);
      }
    } finally {
      this.#inFrame = false;
    }

    // Anything still pending after the cap-2 loop spills to the next frame.
    if (this.#pending.level !== UpdateLevel.None) {
      this.#arm();
      return;
    }
    // Overlay tickets re-arm at Overlay only (never promote to a Render/autoscale frame);
    // horz animations re-arm at Render.
    const rearm = this.#driver.animationRearmLevel(now);
    if (rearm !== UpdateLevel.None) this.invalidate(createMask({ level: rearm }));
  }

  /** Cancels the pending rAF and runs the frame inline, so a resize inside the
   *  ResizeObserver callback shows no one-frame lag between container and canvas. */
  flushSync(mask: UpdateMask, now: number): void {
    if (this.#disposed) return;
    if (this.#cancel !== null) {
      this.#cancel();
      this.#cancel = null;
    }
    if (mask.level !== UpdateLevel.None) this.#pending = mergeMasks(this.#pending, mask);
    this.#runFrame(now);
  }

  dispose(): void {
    this.#disposed = true;
    if (this.#cancel !== null) {
      this.#cancel();
      this.#cancel = null;
    }
    this.#pending = emptyMask();
  }
}
