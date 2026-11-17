// The chart's live horizontal navigation state: bar spacing S and right offset R, in the
// geometry x(i) = W − (B + R − i + 0.5)·S − 1 where B is the newest slot. The clamping and
// fit math are the model navigator's; this module only owns the two numbers.
import type { ChartModel } from '../model';
import { clampBarSpacing, clampRightOffset, fitContentWithPixels } from '../model';

export interface LiveNav {
  barSpacing(): number;
  rightOffset(): number;
  /** Drag by a media-px delta: dragging right reveals history. */
  pan(deltaXpx: number): void;
  /** Zoom by ± wheel notches, keeping the bar under `atX` in place. */
  zoom(step: number, atX: number): void;
  /** Fit every bar into the pane. */
  fit(): void;
  /** Restore the option defaults, then fit. */
  reset(): void;
  /** Show logical slots [from, to] across the pane. */
  setVisibleRange(from: number, to: number): void;
  setRightOffset(offset: number): void;
  setBarSpacing(spacing: number): void;
  /** Apply a fit or range request made while the pane had no width (e.g. a hidden tab). */
  flushPending(): void;
}

interface TimeScaleNavOptions {
  barSpacing?: number;
  rightOffset?: number;
  minBarSpacing?: number;
  maxBarSpacing?: number;
  fixLeftEdge?: boolean;
  fixRightEdge?: boolean;
}

export function createLiveNav<H>(model: ChartModel<H>, barCount: () => number, paneWidth: () => number): LiveNav {
  const ts = (): TimeScaleNavOptions => (model.options() as { timeScale?: TimeScaleNavOptions }).timeScale ?? {};
  const width = (): number => paneWidth() || 100;

  let barSpacing = ts().barSpacing ?? 6;
  let rightOffset = ts().rightOffset ?? 0;

  const spacingClamp = () => {
    const o = ts();
    return {
      width: width(),
      minBarSpacing: o.minBarSpacing ?? 0.5,
      maxBarSpacing: o.maxBarSpacing ?? 0,
      barCount: barCount(),
      fixLeftEdge: o.fixLeftEdge ?? false,
      fixRightEdge: o.fixRightEdge ?? false,
    };
  };
  const offsetClamp = () => {
    const o = ts();
    const n = barCount();
    return {
      width: width(),
      barSpacing,
      firstIndex: 0,
      baseIndex: n > 0 ? n - 1 : null,
      barCount: n,
      fixLeftEdge: o.fixLeftEdge ?? false,
      fixRightEdge: o.fixRightEdge ?? false,
    };
  };
  const setOffset = (r: number): void => {
    rightOffset = clampRightOffset(r, offsetClamp());
  };
  // Width-dependent requests wait until the pane has a real width.
  let pending: (() => void) | null = null;
  const whenSized = (fn: () => void): void => {
    if (paneWidth() > 0) fn();
    else pending = fn;
  };
  const fit = (): void =>
    whenSized(() => {
      const n = barCount();
      if (n <= 0) return;
      const f = fitContentWithPixels(width(), 0, n);
      barSpacing = clampBarSpacing(f.barSpacing, spacingClamp());
      setOffset(f.rightOffset);
    });

  return {
    barSpacing: () => barSpacing,
    rightOffset: () => rightOffset,
    pan: (dx) => {
      if (barSpacing > 0) setOffset(rightOffset - dx / barSpacing);
    },
    zoom: (step, atX) => {
      const oldS = barSpacing;
      if (!(oldS > 0)) return;
      const newS = clampBarSpacing(oldS * (1 + step * 0.1), spacingClamp());
      if (newS === oldS) return;
      // Keep the logical position under the cursor fixed: solve the geometry for R.
      const gap = (width() - 1 - atX) / oldS;
      const anchor = rightOffset - gap; // logical − B − 0.5 under the cursor
      barSpacing = newS;
      setOffset(anchor + (width() - 1 - atX) / newS);
    },
    fit,
    reset: () => {
      barSpacing = ts().barSpacing ?? 6;
      rightOffset = ts().rightOffset ?? 0;
      fit();
    },
    setVisibleRange: (from, to) =>
      whenSized(() => {
        const n = barCount();
        barSpacing = clampBarSpacing(width() / Math.max(1, to - from + 1), spacingClamp());
        setOffset(to - Math.max(0, n - 1));
      }),
    setRightOffset: setOffset,
    setBarSpacing: (s) => {
      barSpacing = clampBarSpacing(s, spacingClamp());
      setOffset(rightOffset);
    },
    flushPending: () => {
      if (pending === null || paneWidth() <= 0) return;
      const run = pending;
      pending = null;
      run();
    },
  };
}
