// Session highlighting: a pane primitive that shades each in-session span below the
// series and, optionally, marks each session open with a tick on the time axis.
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DeepPartial } from '../../core';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';
import type { IPrimitive, ITimeScale, PrimitiveContext, PrimitiveSource } from '../../api';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import { offsetFor } from './timezone-time-behavior';

/** One trading session in the venue's local clock. `days` are local weekdays (0=Sun … 6=Sat);
 *  the session covers local minutes-of-day `[openMinutes, closeMinutes)` in IANA zone `tz`. */
export interface SessionSpec {
  days: readonly number[];
  openMinutes: number;
  closeMinutes: number;
  tz: string;
}

export interface SessionHighlightOptions {
  visible: boolean;
  color: string;
  /** Draw a time-axis tick at each session open. */
  showBreaks: boolean;
  breakColor: string;
}

export const sessionHighlightDefaults: SessionHighlightOptions = {
  visible: true,
  color: 'rgba(40,98,255,0.08)',
  showBreaks: true,
  breakColor: 'rgba(40,98,255,0.5)',
};

export type SessionHighlightHandle = PrimitiveAdapter<
  SessionHighlightOptions,
  { setSession(spec: SessionSpec): void }
>;

const EMPTY: readonly DisplayList[] = [];
const MIN_PER_DAY = 1440;
const SEC_PER_DAY = 86400;

function inSession(utcSeconds: number, spec: SessionSpec, offset: (utc: number) => number): boolean {
  const localSec = utcSeconds + offset(utcSeconds);
  const dayOfWeek = (((Math.floor(localSec / SEC_PER_DAY) + 4) % 7) + 7) % 7; // 1970-01-01 = Thu(4)
  if (!spec.days.includes(dayOfWeek)) return false;
  const minuteOfDay = (((Math.floor(localSec / 60) % MIN_PER_DAY) + MIN_PER_DAY) % MIN_PER_DAY);
  return minuteOfDay >= spec.openMinutes && minuteOfDay < spec.closeMinutes;
}

interface Geom {
  timeScale(): ITimeScale;
  paneHeight(): number;
}

interface Span {
  readonly startKey: number;
  readonly endKey: number;
}

function createSessionSource(
  geom: Geom,
  getOptions: () => SessionHighlightOptions,
  getSpec: () => SessionSpec | null,
  getRev: () => number,
): { pane: SceneSource; axis: SceneSource } {
  const builder = new DisplayListBuilder();
  const axisBuilder = new DisplayListBuilder();
  let spans: readonly Span[] = [];
  let cachedPane: readonly DisplayList[] = EMPTY;
  let cachedAxis: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  // Group contiguous in-session keys of the visible range into spans. keysInRange includes
  // whitespace slots, so a closed-period gap correctly ends a run.
  function computeSpans(): readonly Span[] {
    const spec = getSpec();
    if (spec === null || !getOptions().visible) return [];
    const ts = geom.timeScale();
    const range = ts.getVisibleLogicalRange();
    if (range === null) return [];
    const keys = ts.keysInRange({ from: range.from as unknown as number, to: range.to as unknown as number });
    if (keys.length === 0) return [];
    const offset = offsetFor(spec.tz);
    const out: Span[] = [];
    let runStart: number | null = null;
    let prev = 0;
    for (const k of keys) {
      const key = k as unknown as number;
      const open = inSession(key, spec, offset);
      if (open && runStart === null) runStart = key;
      else if (!open && runStart !== null) {
        out.push({ startKey: runStart, endKey: prev });
        runStart = null;
      }
      prev = key;
    }
    if (runStart !== null) out.push({ startKey: runStart, endKey: prev });
    return out;
  }

  function xOf(key: number): number | null {
    const ts = geom.timeScale();
    const logical = ts.keyToLogical(key, { extrapolate: true });
    if (logical === null) return null;
    const x = ts.logicalToCoordinate(logical as unknown as number);
    return x === null ? null : (x as unknown as number);
  }

  // Half a bar in media px: slot x is the bar center, so spans are widened by this on each
  // side. Falls back to measuring one logical unit when the scale has no barSpacing().
  function halfBarAt(key: number): number {
    const ts = geom.timeScale();
    const bs = (ts as unknown as { barSpacing?: () => number }).barSpacing;
    if (typeof bs === 'function') {
      const v = bs.call(ts);
      if (Number.isFinite(v) && v > 0) return v / 2;
    }
    const logical = ts.keyToLogical(key, { extrapolate: true });
    if (logical === null) return 0;
    const lg = logical as unknown as number;
    const x0 = ts.logicalToCoordinate(lg);
    const x1 = ts.logicalToCoordinate(lg + 1);
    if (x0 === null || x1 === null) return 0;
    return Math.abs((x1 as unknown as number) - (x0 as unknown as number)) / 2;
  }

  function build(): void {
    const height = geom.paneHeight();
    if (spans.length === 0 || height <= 0) {
      cachedPane = EMPTY;
      cachedAxis = EMPTY;
      return;
    }
    const opts = getOptions();
    builder.reset();
    builder.beginList('media');
    const rects = builder.rects({});
    for (const s of spans) {
      const x0 = xOf(s.startKey);
      const x1 = xOf(s.endKey);
      if (x0 === null || x1 === null) continue;
      // Cover start-of-first-slot to end-of-last-slot, not center to center.
      const halfL = halfBarAt(s.startKey);
      const halfR = halfBarAt(s.endKey);
      const lo = Math.min(x0, x1) - halfL;
      const hi = Math.max(x0, x1) + halfR;
      const w = Math.max(0, hi - lo);
      rects.quad(lo, 0, w, height, opts.color);
    }
    cachedPane = builder.finish();

    // The break tick sits at the left edge of the first in-session slot.
    if (opts.showBreaks) {
      axisBuilder.reset();
      axisBuilder.beginList('media');
      const ticks = axisBuilder.rects({});
      for (const s of spans) {
        const x = xOf(s.startKey);
        if (x === null) continue;
        ticks.quad(x - halfBarAt(s.startKey), 0, 1, 6, opts.breakColor);
      }
      cachedAxis = axisBuilder.finish();
    } else {
      cachedAxis = EMPTY;
    }
  }

  const range = (): string => {
    const r = geom.timeScale().getVisibleLogicalRange();
    return r === null ? 'null' : `${r.from},${r.to}`;
  };

  const pane: SceneSource = {
    zBand: ZBand.BelowSeries,
    update(_frame: ViewFrame): void {
      const next = `${getRev()}|${range()}|${geom.paneHeight()}`;
      if (next === sig) return;
      sig = next;
      spans = computeSpans();
      build();
    },
    displayLists: () => cachedPane,
  };
  const axis: SceneSource = {
    zBand: ZBand.BelowSeries,
    update(_frame: ViewFrame): void {
      // The pane source runs first each frame and rebuilds both lists.
    },
    displayLists: () => cachedAxis,
  };
  return { pane, axis };
}

interface PaneLike {
  size(): { width: number; height: number };
}

/**
 * Attach a session highlight to `pane`. `chart` supplies the time scale, which a pane
 * alone does not expose. Change the session later with `setSession`.
 */
export function createSessionHighlight(
  chart: { timeScale(): ITimeScale },
  pane: PrimitiveTarget & PaneLike,
  spec?: SessionSpec,
  options?: DeepPartial<SessionHighlightOptions>,
): SessionHighlightHandle {
  let opts: SessionHighlightOptions = resolve(options);
  let session: SessionSpec | null = spec ?? null;
  let rev = 0;

  let ctx: PrimitiveContext | null = null;
  const geom: Geom = {
    timeScale: () => chart.timeScale(),
    paneHeight: () => (((ctx?.pane as unknown as PaneLike | undefined) ?? pane).size().height),
  };
  const { pane: paneSource, axis: axisSource } = createSessionSource(
    geom,
    () => opts,
    () => session,
    () => rev,
  );

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
    },
    detached(): void {
      ctx = null;
    },
    sources(): readonly PrimitiveSource[] {
      return [
        { target: 'pane', source: paneSource } as unknown as PrimitiveSource,
        { target: 'time-axis', source: axisSource } as unknown as PrimitiveSource,
      ];
    },
  };

  return createPrimitiveAdapter<SessionHighlightOptions, { setSession(spec: SessionSpec): void }>({
    target: pane,
    primitive,
    options: opts,
    defaults: sessionHighlightDefaults,
    onChange(next): void {
      opts = next;
      rev++;
      ctx?.requestUpdate('render');
    },
    methods: {
      setSession(next: SessionSpec): void {
        session = next;
        rev++;
        ctx?.requestUpdate('render');
      },
    },
  });
}

function resolve(patch?: DeepPartial<SessionHighlightOptions>): SessionHighlightOptions {
  if (patch === undefined) return { ...sessionHighlightDefaults };
  return {
    visible: patch.visible ?? sessionHighlightDefaults.visible,
    color: (patch.color as string) ?? sessionHighlightDefaults.color,
    showBreaks: patch.showBreaks ?? sessionHighlightDefaults.showBreaks,
    breakColor: (patch.breakColor as string) ?? sessionHighlightDefaults.breakColor,
  };
}
