// Per-frame geometry shared by every consumer: one horizontal geometry for the chart and
// one resolved price scale per (pane, scale id), fitted across every series on that scale.
// Series rendering, axes, grid, crosshair and the public coordinate APIs all read from
// here, so they can never disagree.
import type { TimeIndex } from '../core';
import type { PlotStore, Timeline } from '../data';
import {
  PriceScaleMode,
  assembleRange,
  buildHorzGeometry,
  buildPriceConverter,
  createPriceGeometry,
  defaultLogFormula,
  fromIndexed,
  fromPercent,
  rowsInRange,
} from '../model';
import type {
  AutoscaleContributor,
  AutoscaleMargins,
  ChartModel,
  HorzGeometry,
  LogFormula,
  Pane,
  PriceConverter,
  PriceGeometry,
  PriceScale,
  PriceScaleOptions,
  Series as ModelSeries,
} from '../model';
import { percentFormatter, precisionByMinMove, priceFormatter, volumeFormatter } from '../fmt';
import type { IPriceFormatter } from '../fmt';
import type { LiveNav } from './live-nav';
import type { ISeries } from './series';
import type { SeriesType } from './series-defs';

export interface AxisLine {
  readonly price: number;
  readonly color: string;
}

export interface SeriesEntry<H = unknown> {
  readonly id: string;
  readonly ownerId: number;
  readonly model: ModelSeries;
  readonly store: PlotStore<unknown>;
  pane: Pane;
  z: number;
  handle: ISeries<SeriesType, H>;
  /** The user item behind each store row. */
  rows: unknown[];
  /** Every user item, whitespace included, and its timeline slot. */
  items: unknown[];
  slots: readonly number[];
  /** Price lines that want an axis label. */
  axisLines(): readonly AxisLine[];
}

interface PriceFormatOption {
  type?: string;
  precision?: number;
  minMove?: number;
  formatter?: (price: number) => string;
}

const priceFormatOf = (e: SeriesEntry): PriceFormatOption =>
  ((e.model.options() as { priceFormat?: PriceFormatOption }).priceFormat ?? {}) as PriceFormatOption;

export function minMoveOf(e: SeriesEntry): number {
  const pf = priceFormatOf(e);
  return pf.minMove ?? (pf.type === 'volume' ? 1 : 0.01);
}

export function seriesFormatter(e: SeriesEntry, custom?: (price: number) => string): IPriceFormatter {
  const pf = priceFormatOf(e);
  const minMove = minMoveOf(e);
  const precision = pf.precision ?? precisionByMinMove(minMove);
  switch (pf.type) {
    case 'volume':
      return volumeFormatter(pf.precision ?? 2);
    case 'percent':
      return percentFormatter(precision, minMove);
    case 'custom':
      return { format: pf.formatter ?? ((p) => String(p)) };
    default:
      return custom !== undefined ? { format: custom } : priceFormatter(precision, minMove);
  }
}

/** The tick-step base round(1/minMove), falling back to 10^precision when it has a
 *  prime factor other than 2 or 5 (the step search only divides by 2, 2.5 and 5). */
function tickBaseFor(minMove: number): number {
  const base = Math.round(1 / minMove);
  let b = base;
  while (b > 1 && b % 2 === 0) b /= 2;
  while (b > 1 && b % 5 === 0) b /= 5;
  return base >= 1 && b === 1 ? base : 10 ** precisionByMinMove(minMove);
}

export const scaleIdOf = (e: SeriesEntry, fallback = 'right'): string =>
  ((e.model.options() as { priceScaleId?: string }).priceScaleId ?? fallback) as string;

export const isVisible = (e: SeriesEntry): boolean => (e.model.options() as { visible?: boolean }).visible !== false;

export interface ScaleFrame {
  readonly id: string;
  readonly scale: PriceScale;
  readonly options: PriceScaleOptions;
  /** Visible series on this scale, in z order. */
  readonly entries: readonly SeriesEntry[];
  readonly geom: PriceGeometry;
  readonly mode: PriceScaleMode;
  /** Formats axis values: prices, or percentages / index points in those modes. */
  readonly formatter: IPriceFormatter;
  readonly tickBase: number;
  converter(e: SeriesEntry | null): PriceConverter;
  toY(e: SeriesEntry | null, price: number): number | null;
  toPrice(e: SeriesEntry | null, y: number): number | null;
}

export interface PaneFrame {
  readonly pane: Pane;
  readonly height: number;
  /** Visible series on this pane, in z order. */
  readonly entries: readonly SeriesEntry[];
  scale(id: string): ScaleFrame;
  /** The scale the grid, crosshair price and magnet use: right, else left, else any. */
  defaultScale(): ScaleFrame | null;
}

export interface FrameStateDeps<H> {
  readonly model: ChartModel<H, unknown>;
  readonly timeline: Timeline<{ time: unknown }, H, unknown>;
  readonly nav: LiveNav;
  entries(): readonly SeriesEntry<H>[];
  paneWidth(): number;
  paneHeight(pane: Pane): number;
  customPriceFormatter(): ((price: number) => string) | undefined;
}

export class FrameState<H> {
  readonly #deps: FrameStateDeps<H>;
  #rev = 0;
  #horz: { key: string; geom: HorzGeometry } | null = null;
  readonly #panes = new WeakMap<Pane, { key: string; frame: PaneFrame }>();
  readonly #logFormulas = new WeakMap<PriceScale, LogFormula>();
  readonly #margins = new WeakMap<PriceScale, AutoscaleMargins>();
  readonly #modes = new WeakMap<PriceScale, PriceScaleMode>();

  constructor(deps: FrameStateDeps<H>) {
    this.#deps = deps;
  }

  /** Invalidate every cached frame (data, options, navigation or size changed). */
  bump(): void {
    this.#rev++;
  }

  get revision(): number {
    return this.#rev;
  }

  horz(width: number = this.#deps.paneWidth()): HorzGeometry {
    const nav = this.#deps.nav;
    const n = this.#deps.timeline.slotCount;
    const key = `${this.#rev}|${width}|${nav.barSpacing()}|${nav.rightOffset()}|${n}`;
    if (this.#horz?.key !== key) {
      const geom = buildHorzGeometry({
        width: width || 100,
        barSpacing: nav.barSpacing(),
        rightOffset: nav.rightOffset(),
        baseIndex: Math.max(0, n - 1),
      });
      this.#horz = { key, geom };
    }
    return this.#horz.geom;
  }

  /** The integer slots on screen, clamped to the data; null when empty. */
  visibleSlots(horz: HorzGeometry = this.horz()): { from: number; to: number } | null {
    const n = this.#deps.timeline.slotCount;
    const strict = n === 0 ? null : horz.visibleStrictRange();
    if (strict === null) return null;
    const from = Math.max(0, strict.left);
    const to = Math.min(n - 1, strict.right);
    return from <= to ? { from, to } : null;
  }

  paneEntries(pane: Pane): SeriesEntry<H>[] {
    return this.#deps
      .entries()
      .filter((e) => e.pane === pane && isVisible(e))
      .sort((a, b) => a.z - b.z);
  }

  pane(pane: Pane, height: number = this.#deps.paneHeight(pane)): PaneFrame {
    const horz = this.horz();
    const key = `${this.#rev}|${height}|${this.#horz!.key}`;
    const cached = this.#panes.get(pane);
    if (cached?.key === key) return cached.frame;
    const frame = this.#buildPane(pane, height, horz);
    this.#panes.set(pane, { key, frame });
    return frame;
  }

  #buildPane(pane: Pane, height: number, horz: HorzGeometry): PaneFrame {
    const entries = this.paneEntries(pane);
    const slots = this.visibleSlots(horz);
    const fallback = (this.#deps.model.options() as { defaultPriceScaleId?: string }).defaultPriceScaleId ?? 'right';
    const scales = new Map<string, ScaleFrame>();
    const scale = (id: string): ScaleFrame => {
      let s = scales.get(id);
      if (s === undefined) {
        const own = entries.filter((e) => scaleIdOf(e, fallback) === id);
        s = this.#resolveScale(pane, id, height, own, slots);
        scales.set(id, s);
      }
      return s;
    };
    for (const e of entries) scale(scaleIdOf(e, fallback));
    return {
      pane,
      height,
      entries,
      scale,
      defaultScale: () => {
        if (scale('right').entries.length > 0) return scale('right');
        if (scale('left').entries.length > 0) return scale('left');
        for (const s of scales.values()) if (s.entries.length > 0) return s;
        return null;
      },
    };
  }

  #resolveScale(
    pane: Pane,
    id: string,
    height: number,
    entries: readonly SeriesEntry[],
    slots: { from: number; to: number } | null,
  ): ScaleFrame {
    const scale = pane.priceScale(id) ?? pane.ensureOverlayScale(id);
    const options = scale.options();
    const mode = options.mode;
    const prevMode = this.#modes.get(scale);
    if (prevMode !== undefined && prevMode !== mode) scale.setAutoScale(true);
    this.#modes.set(scale, mode);

    const firstValues = new Map<SeriesEntry, number>();
    const contributors: AutoscaleContributor[] = [];
    for (const e of entries) {
      if (e.store.length === 0) continue;
      if (slots === null) continue;
      const range = { from: slots.from as TimeIndex, to: slots.to as TimeIndex };
      const [lo, hi] = rowsInRange(e.store, range);
      if (lo > hi) continue;
      const firstValue = e.store.current(lo);
      firstValues.set(e, firstValue);
      const info = e.model.autoscaleInfo(e.store, range);
      contributors.push({
        firstValue,
        range: info?.priceRange ? { min: info.priceRange.minValue, max: info.priceRange.maxValue } : null,
        margins: info?.margins ?? null,
      });
    }

    let logFormula = this.#logFormulas.get(scale) ?? defaultLogFormula();
    let margins = this.#margins.get(scale) ?? { above: 0, below: 0 };
    let range = scale.range();
    if (scale.isAutoScale()) {
      const minMove = entries.length > 0 ? minMoveOf(entries[0]!) : 0.01;
      const assembled = assembleRange({ contributors, mode, minMove, logFormula });
      if (assembled !== null) {
        range = assembled.range;
        margins = assembled.margins;
        logFormula = assembled.logFormula;
        scale.setRange(range);
        this.#logFormulas.set(scale, logFormula);
        this.#margins.set(scale, margins);
      }
    }
    const geom = createPriceGeometry({
      height,
      range,
      scaleMargins: options.scaleMargins,
      marginAbovePx: margins.above,
      marginBelowPx: margins.below,
      mode,
      inverted: options.invertScale,
      logFormula,
    });
    scale.setHeight(geom.internalHeight);

    const baseOf = (e: SeriesEntry | null): number | null => {
      const target = e ?? entries[0] ?? null;
      if (target === null) return null;
      const v = firstValues.get(target);
      if (v !== undefined) return v;
      return target.store.length > 0 ? target.store.current(0) : null;
    };
    const converters = new Map<SeriesEntry | null, PriceConverter>();
    const converter = (e: SeriesEntry | null): PriceConverter => {
      let c = converters.get(e);
      if (c === undefined) {
        c = buildPriceConverter({
          height,
          range,
          scaleMargins: options.scaleMargins,
          marginAbovePx: margins.above,
          marginBelowPx: margins.below,
          mode,
          inverted: options.invertScale,
          firstValue: baseOf(e),
          logFormula,
        });
        converters.set(e, c);
      }
      return c;
    };

    const percentLike = mode === PriceScaleMode.Percentage || mode === PriceScaleMode.IndexedTo100;
    const first = entries[0];
    const formatter: IPriceFormatter =
      mode === PriceScaleMode.Percentage
        ? percentFormatter(2, 0.01)
        : mode === PriceScaleMode.IndexedTo100
          ? priceFormatter(2, 0.01)
          : first !== undefined
            ? seriesFormatter(first, this.#deps.customPriceFormatter())
            : priceFormatter(2, 0.01);

    return {
      id,
      scale,
      options,
      entries,
      geom,
      mode,
      formatter,
      tickBase: percentLike ? 100 : tickBaseFor(first !== undefined ? minMoveOf(first) : 0.01),
      converter,
      toY: (e, price) => (geom.isEmpty || !Number.isFinite(price) ? null : converter(e).priceToCoordinate(price)),
      toPrice: (e, y) => {
        if (geom.isEmpty) return null;
        const v = geom.coordinateToLogical(y);
        const base = baseOf(e);
        if (mode === PriceScaleMode.Percentage) return base === null ? null : fromPercent(v, base);
        if (mode === PriceScaleMode.IndexedTo100) return base === null ? null : fromIndexed(v, base);
        return v;
      },
    };
  }
}
