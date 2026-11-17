// Up-down markers: route setData/update through the handle and, when a value at an
// existing time changes, show a dot + chevron colored by the direction for a while.
// Expiry uses one shared timer re-armed to the soonest expiry plus a lazy per-frame
// sweep, not a timer per marker.
import { crispRound, crispWidth, ZBand } from '../../gfx';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { DisplayListBuilder } from '../../gfx';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

const RADIUS = 4;
const ARROW_SIZE = 4.7; // chevron half-width
const ARROW_OFFSET = 7; // chevron offset above the dot
const ARROW_LINE_WIDTH = 2;
const POSITIVE = '#22AB94';
const NEGATIVE = '#F7525F';
const DEFAULT_DURATION = 5000;

export type UpDownSign = -1 | 0 | 1;

export interface UpDownMarker<H = unknown> {
  time: H;
  value: number;
  sign: UpDownSign;
}

export interface UpDownMarkersOptions {
  positiveColor: string;
  negativeColor: string;
  /** ms a change marker stays visible; 0 = until the next update. */
  updateVisibilityDuration: number;
}

export const upDownMarkersDefaults: UpDownMarkersOptions = {
  positiveColor: POSITIVE,
  negativeColor: NEGATIVE,
  updateVisibilityDuration: DEFAULT_DURATION,
};

export interface UpDownMarkersMethods<H = unknown> {
  /** Replace all points; forwarded to the series. Creates no markers. */
  setData(items: readonly { time: H; value?: number }[]): void;
  /** Push one item; an update to an existing time creates a direction marker. */
  update(item: { time: H; value?: number }, historicalUpdate?: boolean): void;
  /** The currently visible (non-expired) markers, in time order. */
  markers(): readonly UpDownMarker<H>[];
  /** Replace all markers directly; these never expire. */
  setMarkers(markers: readonly UpDownMarker<H>[]): void;
  clearMarkers(): void;
}

export type UpDownMarkersHandle<H = unknown> = PrimitiveAdapter<
  UpDownMarkersOptions,
  UpDownMarkersMethods<H>
>;

interface SeriesLike extends PrimitiveTarget {
  setData(items: readonly unknown[]): void;
  update(item: unknown, options?: { historical?: boolean }): void;
  options(): { color?: string; lineColor?: string };
  priceToCoordinate(price: number): number | null;
  seriesType?(): string;
}

interface Managed<H> {
  time: H;
  value: number;
  sign: UpDownSign;
  /** Same clock base as frame.now; Infinity = never. */
  expiresAt: number;
}

/** A stable map key for a time value (business-day objects included). */
function keyOf(time: unknown): string {
  if (time !== null && typeof time === 'object') {
    const bd = time as { year?: number; month?: number; day?: number };
    return `${bd.year}-${bd.month}-${bd.day}`;
  }
  return String(time);
}

/**
 * Attach up-down markers to a Line or Area series. Feed data through the returned
 * handle's `setData`/`update` instead of the series so changes can be detected.
 */
export function createUpDownMarkers<H = unknown>(
  series: SeriesLike,
  options?: DeepPartial<UpDownMarkersOptions>,
): UpDownMarkersHandle<H> {
  let opts: UpDownMarkersOptions = { ...upDownMarkersDefaults, ...stripUndefined(options) };

  // Insertion order matches the time order the feed arrives in.
  const managed = new Map<string, Managed<H>>();

  let ctx: PrimitiveContext<H> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Shares frame.now's base (performance.now) so a timer delay is expiresAt − now.
  let clock: () => number = nowClock;

  const source = new UpDownSource<H>(managed, () => series, () => opts);

  function clearTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }
  function rearm(): void {
    clearTimer();
    let soonest = Infinity;
    for (const m of managed.values()) {
      if (m.expiresAt < soonest) soonest = m.expiresAt;
    }
    if (soonest === Infinity) return;
    const delay = Math.max(0, soonest - clock());
    timer = setTimeout(() => {
      timer = null;
      // The requested frame runs the source's sweep, which calls onSweep to re-arm.
      ctx?.requestUpdate('render');
    }, delay);
  }

  source.onSweep = rearm;

  // `seed` (the setData path) never creates a marker; callers re-arm once after the loop.
  function ingest(time: H, value: number | undefined, seed: boolean): void {
    const k = keyOf(time);
    const prev = managed.get(k);
    if (value === undefined) {
      managed.delete(k);
      return;
    }
    let sign: UpDownSign = 0;
    let expiresAt = Infinity;
    if (prev !== undefined && !seed) {
      sign = value > prev.value ? 1 : value < prev.value ? -1 : 0;
      const d = opts.updateVisibilityDuration;
      expiresAt = d > 0 ? clock() + d : Infinity;
    }
    managed.set(k, { time, value, sign, expiresAt });
  }

  const methods: UpDownMarkersMethods<H> = {
    setData(items): void {
      managed.clear();
      for (const it of items) ingest(it.time, it.value, true);
      source.dirty();
      rearm();
      series.setData(items as readonly unknown[]);
    },
    update(item, historicalUpdate): void {
      ingest(item.time, item.value, false);
      source.dirty();
      rearm();
      series.update(item, { historical: historicalUpdate ?? false });
    },
    markers(): readonly UpDownMarker<H>[] {
      const now = clock();
      const out: UpDownMarker<H>[] = [];
      for (const m of managed.values()) {
        if (m.expiresAt <= now) continue;
        out.push({ time: m.time, value: m.value, sign: m.sign });
      }
      return out;
    },
    setMarkers(next): void {
      managed.clear();
      for (const m of next) managed.set(keyOf(m.time), { ...m, expiresAt: Infinity });
      source.dirty();
      rearm();
      ctx?.requestUpdate('render');
    },
    clearMarkers(): void {
      managed.clear();
      clearTimer();
      source.dirty();
      ctx?.requestUpdate('render');
    },
  };

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext<H>;
      clock = nowClock;
      source.bindContext(ctx);
      rearm();
    },
    detached(): void {
      clearTimer();
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<UpDownMarkersOptions, UpDownMarkersMethods<H>>({
    target: series,
    primitive,
    options: opts,
    defaults: upDownMarkersDefaults,
    onChange(next): void {
      opts = next;
      source.dirty();
      ctx?.requestUpdate('render');
    },
    methods,
    onDetach(): void {
      clearTimer();
    },
  });
}

/** Drop undefined leaves so `{...defaults, ...patch}` does not clobber defaults. */
function stripUndefined(o?: DeepPartial<UpDownMarkersOptions>): Partial<UpDownMarkersOptions> {
  if (o === undefined) return {};
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) {
    const v = (o as Record<string, unknown>)[k];
    if (v !== undefined) out[k] = v;
  }
  return out as Partial<UpDownMarkersOptions>;
}

function nowClock(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

interface CoordProvider {
  priceToCoordinate(price: number): number | null;
  options(): { color?: string; lineColor?: string };
  seriesType?(): string;
}

class UpDownSource<H> implements SceneSource {
  readonly zBand = ZBand.AboveSeries;
  /** Called after a sweep drops an entry, so the timer re-arms to the next expiry. */
  onSweep: (() => void) | null = null;

  #managed: Map<string, Managed<H>>;
  #series: () => CoordProvider;
  #opts: () => UpDownMarkersOptions;
  #ctx: PrimitiveContext<H> | null = null;
  #lists: readonly DisplayList[] = [];
  #dirty = true;
  #builder = new DisplayListBuilder();

  constructor(
    managed: Map<string, Managed<H>>,
    series: () => CoordProvider,
    opts: () => UpDownMarkersOptions,
  ) {
    this.#managed = managed;
    this.#series = series;
    this.#opts = opts;
  }

  bindContext(ctx: PrimitiveContext<H>): void {
    this.#ctx = ctx;
    this.#dirty = true;
  }

  dirty(): void {
    this.#dirty = true;
  }

  update(frame: ViewFrame): void {
    let dropped = false;
    for (const [k, m] of this.#managed) {
      if (m.expiresAt <= frame.now) {
        this.#managed.delete(k);
        dropped = true;
      }
    }
    if (dropped) {
      this.#dirty = true;
      this.onSweep?.();
    }
    if (!this.#dirty) return;
    this.#rebuild(frame);
    this.#dirty = false;
  }

  displayLists(): readonly DisplayList[] {
    return this.#lists;
  }

  #rebuild(frame: ViewFrame): void {
    const { hr, vr } = frame.frame;
    const ts = this.#ctx?.chart.timeScale() as
      | { timeToCoordinate(time: H): number | null }
      | undefined;
    const series = this.#series();
    const opts = this.#opts();
    const neutral = this.#neutralColor(series);

    const tickW = crispWidth(1, hr);
    const corr = (tickW % 2) / 2;
    const radius = RADIUS * vr + corr;
    const chevronW = Math.max(1, Math.floor(ARROW_LINE_WIDTH * hr));

    const b = this.#builder;
    b.reset();
    b.beginList('bitmap');

    const circles = b.circles();
    type Chevron = { sx: number; ey: number; ax: number; ay: number; bx: number; color: string };
    const chevrons: Chevron[] = [];

    for (const m of this.#managed.values()) {
      const x = ts?.timeToCoordinate(m.time) ?? null;
      if (x === null) continue;
      const y = series.priceToCoordinate(m.value);
      if (y === null) continue;

      const cx = crispRound(x, hr) + corr;
      const cy = y * vr; // y is intentionally not rounded
      const color = m.sign > 0 ? opts.positiveColor : m.sign < 0 ? opts.negativeColor : neutral;
      circles.circle(cx, cy, radius, color);

      if (m.sign !== 0) {
        // Chevron (x−4.7, y−7s) → (x, y−10.5s) → (x+4.7, y−7s), s = sign; points up for a rise.
        const baseY = (y - ARROW_OFFSET * m.sign) * vr;
        chevrons.push({
          sx: crispRound(x - ARROW_SIZE, hr) + corr,
          ey: baseY,
          ax: cx,
          ay: (y - ARROW_OFFSET * m.sign - (ARROW_OFFSET / 2) * m.sign) * vr,
          bx: crispRound(x + ARROW_SIZE, hr) + corr,
          color,
        });
      }
    }

    for (const c of chevrons) {
      const p = b.path(undefined, { width: chevronW, color: c.color });
      p.move(c.sx, c.ey);
      p.line(c.ax, c.ay);
      p.line(c.bx, c.ey);
    }

    this.#lists = b.finish();
  }

  #neutralColor(series: CoordProvider): string {
    const o = series.options();
    // Area series use lineColor, Line series use color.
    return o.lineColor ?? o.color ?? POSITIVE;
  }
}
