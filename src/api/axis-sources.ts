// Chart furniture: backgrounds, the grid, price-axis labels (ticks, last-value and
// price-line tags, crosshair tag), time-axis labels (ticks, crosshair tag) and the axis
// width measurement. Everything reads the shared FrameState, so labels line up with
// the series to the pixel.
import { DisplayListBuilder, LineStyle, ZBand } from '../gfx';
import type { DisplayList, FontSpec, ITextMeasurer, SceneSource, ViewFrame } from '../gfx';
import type { IHorzScaleBehavior, Timeline } from '../data';
import {
  PriceScaleMode,
  TickMarkEngine,
  maxIndexesPerMark,
  maxLabelWidthFor,
  rebuildTickMarks,
  resolveBarColors,
} from '../model';
import type { AxisLabel, ChartOptions, GridOptions, HorzGeometry, Pane } from '../model';
import { DEFAULT_DATE_FORMAT } from '../fmt';
import { createGridSource, generateContrastColors } from '../views';
import type { GridSource } from '../views';
import type { FrameState, ScaleFrame, SeriesEntry } from './frame-state';
import { seriesFormatter } from './frame-state';

export interface HoverState {
  readonly paneIndex: number;
  /** The bar slot under the pointer; may lie before the first or after the last bar. */
  readonly index: number;
  /** Price on the pane's default scale; NaN when only the time line is shown. */
  readonly price: number;
  /** Pointer y in pane px when the horizontal line follows the mouse; NaN when it
   *  follows `price` (magnet modes, programmatic positions). */
  readonly y: number;
}

export interface AxisContext<H> {
  readonly state: FrameState<H>;
  readonly timeline: Timeline<{ time: unknown }, H, unknown>;
  readonly behavior: IHorzScaleBehavior<unknown, unknown>;
  readonly measurer: ITextMeasurer;
  options(): ChartOptions;
  hover(): HoverState | null;
  paneIndex(pane: Pane): number;
  /** The user's own time value at a slot (for the crosshair time formatter). */
  timeAt(slot: number): unknown;
  /** Labels that attached primitives (e.g. drawing tools) place on an axis. */
  priceAxisLabels(pane: Pane, side: 'left' | 'right'): readonly AxisLabel[];
  timeAxisLabels(): readonly AxisLabel[];
}

const EMPTY: readonly DisplayList[] = Object.freeze([]);
const LABEL_PAD = 7; // gap between the pane edge and a price label, and after it
const CROSSHAIR_LABEL_BG = '#131722';

export const fontOf = (o: ChartOptions): FontSpec => ({ family: o.layout.fontFamily, size: o.layout.fontSize });
export const timeAxisHeightFor = (o: ChartOptions): number => Math.round(o.layout.fontSize * 1.5) + 10;
const pillHeight = (font: FontSpec): number => font.size + 6;

interface Plan {
  readonly sig: string;
  draw(out: DisplayListBuilder): void;
}

/** A SceneSource that redraws only when its plan's signature changes (null = nothing). */
function cachedSource(zBand: ZBand, plan: (frame: ViewFrame) => Plan | null): SceneSource {
  const builder = new DisplayListBuilder();
  let sig: string | null | undefined;
  let cached = EMPTY;
  return {
    zBand,
    update(frame): void {
      const p = plan(frame);
      const next = p === null ? null : p.sig;
      if (next === sig) return;
      sig = next;
      if (p === null) {
        cached = EMPTY;
        return;
      }
      builder.reset();
      p.draw(builder);
      cached = builder.finish();
    },
    displayLists: () => cached,
  };
}

export function createBackgroundSource(color: () => string): SceneSource {
  return cachedSource(ZBand.Background, (frame) => {
    const { width, height } = frame.frame.mediaSize;
    const c = color();
    return {
      sig: `${width}|${height}|${c}`,
      draw: (out) => {
        out.beginList('media');
        out.rects({}).quad(0, 0, width, height, c);
      },
    };
  });
}

// --- price axis ------------------------------------------------------------------

interface Tag {
  y: number;
  text: string;
  color: string;
}

function lastBarColor(e: SeriesEntry): string {
  const s = e.store;
  const i = s.length - 1;
  const bar = { open: s.lane(0, i), close: s.current(i) };
  const colors = resolveBarColors(e.model.kind(), bar, {}, e.model.options());
  return e.model.priceLineColor(colors.barColor);
}

const percentLike = (sf: ScaleFrame): boolean =>
  sf.mode === PriceScaleMode.Percentage || sf.mode === PriceScaleMode.IndexedTo100;

const shown = (l: AxisLabel): boolean => l.visible?.() !== false;

/** The value tags a scale shows: each series' last value, its price lines, then any
 *  labels attached primitives put on this axis. */
function tagsFor<H>(ctx: AxisContext<H>, pane: Pane, sf: ScaleFrame): Tag[] {
  const tags: Tag[] = [];
  const custom = ctx.options().localization?.priceFormatter;
  for (const e of sf.entries) {
    const o = e.model.options() as { lastValueVisible?: boolean };
    if (o.lastValueVisible === false || e.store.length === 0) continue;
    const price = e.store.current(e.store.length - 1);
    const y = sf.toY(e, price);
    if (y === null) continue;
    const text = percentLike(sf)
      ? sf.formatter.format(sf.geom.coordinateToLogical(y))
      : seriesFormatter(e, custom).format(price);
    tags.push({ y, text, color: lastBarColor(e) });
  }
  for (const e of sf.entries) {
    for (const line of e.axisLines()) {
      const y = sf.toY(e, line.price);
      if (y === null) continue;
      tags.push({ y, text: seriesFormatter(e, custom).format(line.price), color: line.color || lastBarColor(e) });
    }
  }
  if (sf.id === 'left' || sf.id === 'right') {
    for (const l of ctx.priceAxisLabels(pane, sf.id)) {
      if (shown(l)) tags.push({ y: l.coordinate(), text: l.text(), color: l.backColor() });
    }
  }
  return tags;
}

/** Push overlapping tags apart so each stays readable. */
function spread(tags: Tag[], h: number): Tag[] {
  const sorted = tags.slice().sort((a, b) => a.y - b.y);
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1]!;
    if (sorted[i]!.y - prev.y < h) sorted[i] = { ...sorted[i]!, y: prev.y + h };
  }
  return sorted;
}

function drawPill(
  out: DisplayListBuilder,
  m: ITextMeasurer,
  font: FontSpec,
  w: number,
  side: 'left' | 'right',
  y: number,
  text: string,
  bg: string,
): void {
  const { background, foreground } = generateContrastColors(bg);
  const size = m.measure(text, font);
  const h = pillHeight(font);
  out.rects({ radius: 2 }).quad(0, y - h / 2, w, h, background);
  const x = side === 'right' ? LABEL_PAD : Math.max(0, w - LABEL_PAD - size.width);
  out.text([{ x, y: y + (size.ascent - size.descent) / 2, text, font, color: foreground }]);
}

function priceTicks(sf: ScaleFrame, font: FontSpec): { y: number; text: string }[] {
  if (sf.entries.length === 0) return [];
  return rebuildTickMarks(sf.geom, sf.tickBase, { fontSize: font.size }).map((t) => ({
    y: t.coord,
    text: sf.formatter.format(t.logical),
  }));
}

/** Tick labels plus value tags for one side of one pane. */
export function createPriceAxisSource<H>(ctx: AxisContext<H>, pane: Pane, side: 'left' | 'right'): SceneSource {
  return cachedSource(ZBand.Labels, (frame) => {
    const { width: w, height: h } = frame.frame.mediaSize;
    const o = ctx.options();
    const font = fontOf(o);
    const sf = ctx.state.pane(pane, h).scale(side);
    if (!sf.options.visible || sf.entries.length === 0 || w === 0) return null;
    const ticks = priceTicks(sf, font).filter((t) => t.y >= 0 && t.y <= h);
    const tags = spread(tagsFor(ctx, pane, sf), pillHeight(font) + 1).filter((t) => t.y >= 0 && t.y <= h);
    const color = o.layout.textColor;
    const tickSig = ticks.map((t) => `${t.y}:${t.text}`).join();
    const tagSig = tags.map((t) => `${t.y}:${t.text}:${t.color}`).join();
    return {
      sig: `${w}|${h}|${color}|${font.family}|${font.size}|${tickSig}|${tagSig}`,
      draw: (out) => {
        out.beginList('media');
        const items = ticks.map((t) => {
          const size = ctx.measurer.measure(t.text, font);
          const x = side === 'right' ? LABEL_PAD : Math.max(0, w - LABEL_PAD - size.width);
          return { x, y: t.y + (size.ascent - size.descent) / 2, text: t.text, font, color };
        });
        if (items.length > 0) out.text(items);
        for (const t of tags) drawPill(out, ctx.measurer, font, w, side, t.y, t.text, t.color);
      },
    };
  });
}

/** The crosshair's price tag on one side of one pane (overlay layer). */
export function createPriceCrosshairLabel<H>(ctx: AxisContext<H>, pane: Pane, side: 'left' | 'right'): SceneSource {
  return cachedSource(ZBand.OverlayLabels, (frame) => {
    const hover = ctx.hover();
    const o = ctx.options();
    const line = o.crosshair.horzLine;
    if (hover === null || o.crosshair.mode === 'hidden' || line?.labelVisible === false) return null;
    if (hover.paneIndex !== ctx.paneIndex(pane)) return null;
    if (!Number.isFinite(hover.y) && !Number.isFinite(hover.price)) return null;
    const { width: w, height: h } = frame.frame.mediaSize;
    const pf = ctx.state.pane(pane, h);
    const sf = pf.scale(side);
    const y = Number.isFinite(hover.y) ? hover.y : (pf.defaultScale()?.toY(null, hover.price) ?? null);
    if (y === null || !sf.options.visible || sf.entries.length === 0 || y < 0 || y > h || w === 0) return null;
    const text = sf.formatter.format(sf.geom.coordinateToLogical(y));
    const font = fontOf(o);
    const bg = line?.labelBackgroundColor ?? CROSSHAIR_LABEL_BG;
    return {
      sig: `${w}|${h}|${y}|${text}|${bg}`,
      draw: (out) => {
        out.beginList('media');
        drawPill(out, ctx.measurer, font, w, side, y, text, bg);
      },
    };
  });
}

/** The widest label a side needs across every pane, in media px (0 = hide the axis). */
export function measurePriceAxis<H>(ctx: AxisContext<H>, panes: readonly Pane[], side: 'left' | 'right'): number {
  const font = fontOf(ctx.options());
  let max = 0;
  let any = false;
  for (const pane of panes) {
    const pf = ctx.state.pane(pane);
    const sf = pf.scale(side);
    if (!sf.options.visible || sf.entries.length === 0) continue;
    any = true;
    const texts = [...priceTicks(sf, font).map((t) => t.text), ...tagsFor(ctx, pane, sf).map((t) => t.text)];
    // The crosshair tag can show any value in range; the range ends bound its width.
    if (!sf.geom.isEmpty) {
      texts.push(sf.formatter.format(sf.geom.coordinateToLogical(0)));
      texts.push(sf.formatter.format(sf.geom.coordinateToLogical(Math.max(0, pf.height - 1))));
    }
    for (const t of texts) max = Math.max(max, ctx.measurer.measure(t, font).width);
    max = Math.max(max, sf.options.minimumWidth - 2 * LABEL_PAD);
  }
  return any ? Math.ceil(max + 2 * LABEL_PAD) : 0;
}

// --- time axis -------------------------------------------------------------------

/** Visible, non-overlapping time tick slots. Beyond a few hundred visible bars the
 *  weight engine is skipped for a uniform stride, which keeps the cost O(labels). */
export function selectTimeMarks<H>(
  horz: HorzGeometry,
  timeline: Timeline<{ time: unknown }, H, unknown>,
  fontSize: number,
): readonly { index: number; weight: number }[] {
  const n = timeline.slotCount;
  const strict = n === 0 ? null : horz.visibleStrictRange();
  if (strict === null) return [];
  const lo = Math.max(0, strict.left);
  const hi = Math.min(n - 1, strict.right);
  if (hi < lo) return [];
  const gap = Math.max(1, maxIndexesPerMark(maxLabelWidthFor(fontSize, undefined), horz.barSpacing));
  if (hi - lo + 1 > 512) {
    const out: { index: number; weight: number }[] = [];
    for (let i = lo; i <= hi; i += gap) out.push({ index: i, weight: timeline.weightAt(i) });
    return out;
  }
  const all: { index: number; weight: number }[] = [];
  for (let i = lo; i <= hi; i++) all.push({ index: i, weight: timeline.weightAt(i) });
  const engine = new TickMarkEngine();
  engine.setMarks(all);
  return engine.build({ maxIndexesPerMark: gap });
}

function formatFlags(o: ChartOptions): { loc: never; fmt: never } {
  const ts = (o.timeScale ?? {}) as { timeVisible?: boolean; secondsVisible?: boolean; tickMarkFormatter?: unknown };
  return {
    loc: { locale: 'en-US', dateFormat: DEFAULT_DATE_FORMAT, ...(o.localization ?? {}) } as never,
    fmt: {
      timeVisible: ts.timeVisible ?? true,
      secondsVisible: ts.secondsVisible ?? false,
      tickMarkFormatter: ts.tickMarkFormatter,
    } as never,
  };
}

export function createTimeAxisSource<H>(ctx: AxisContext<H>): SceneSource {
  return cachedSource(ZBand.Labels, (frame) => {
    const { width: w, height: h } = frame.frame.mediaSize;
    const o = ctx.options();
    const font = fontOf(o);
    const horz = ctx.state.horz();
    const { loc, fmt } = formatFlags(o);
    const items: { x: number; text: string }[] = [];
    for (const m of selectTimeMarks(horz, ctx.timeline, font.size)) {
      const internal = ctx.timeline.internalAt(m.index);
      if (internal === undefined) continue;
      const cx = horz.indexToCoordinate(m.index);
      if (cx < 0 || cx > w) continue;
      items.push({ x: cx, text: ctx.behavior.formatTick(internal, m.weight, loc, fmt) });
    }
    const tags = ctx.timeAxisLabels().filter(shown).map((l) => ({ x: l.coordinate(), text: l.text(), color: l.backColor() }));
    if ((items.length === 0 && tags.length === 0) || w === 0) return null;
    const color = o.layout.textColor;
    const baseline = Math.min(h - 4, font.size + 6);
    const place = (x: number, text: string): number => {
      const tw = ctx.measurer.measure(text, font).width;
      return Math.min(Math.max(0, x - tw / 2), Math.max(0, w - tw));
    };
    return {
      sig: `${w}|${h}|${color}|${font.family}|${font.size}|${items.map((i) => `${i.x}:${i.text}`).join()}|${tags.map((t) => `${t.x}:${t.text}:${t.color}`).join()}`,
      draw: (out) => {
        out.beginList('media');
        if (items.length > 0) out.text(items.map((i) => ({ x: place(i.x, i.text), y: baseline, text: i.text, font, color })));
        for (const t of tags) {
          const { background, foreground } = generateContrastColors(t.color);
          const tw = ctx.measurer.measure(t.text, font).width;
          const left = place(t.x, t.text) - LABEL_PAD;
          out.rects({ radius: 2 }).quad(left, 0, tw + 2 * LABEL_PAD, h, background);
          out.text([{ x: left + LABEL_PAD, y: baseline, text: t.text, font, color: foreground }]);
        }
      },
    };
  });
}

// A slot outside the data (e.g. the empty space right of the last bar): extrapolate its key.
function futureItem<H>(ctx: AxisContext<H>, slot: number): unknown {
  if (ctx.behavior.fromKey === undefined || ctx.timeline.slotCount < 2) return undefined;
  const key = ctx.timeline.logicalToKey(slot as never, { extrapolate: true });
  return key === null ? undefined : ctx.behavior.fromKey(key);
}

export function createTimeCrosshairLabel<H>(ctx: AxisContext<H>): SceneSource {
  return cachedSource(ZBand.OverlayLabels, (frame) => {
    const hover = ctx.hover();
    const o = ctx.options();
    const line = o.crosshair.vertLine;
    if (hover === null || o.crosshair.mode === 'hidden' || line?.labelVisible === false) return null;
    const internal = ctx.timeline.internalAt(hover.index) ?? futureItem(ctx, hover.index);
    if (internal === undefined) return null;
    const { width: w, height: h } = frame.frame.mediaSize;
    const x = ctx.state.horz().indexToCoordinate(hover.index);
    if (x < 0 || x > w) return null;
    const { loc, fmt } = formatFlags(o);
    const custom = o.localization?.timeFormatter as ((t: unknown) => string) | undefined;
    const text = custom !== undefined ? custom(ctx.timeAt(hover.index)) : ctx.behavior.formatItem(internal, loc, fmt);
    const font = fontOf(o);
    const size = ctx.measurer.measure(text, font);
    const pw = size.width + 2 * LABEL_PAD;
    const left = Math.min(Math.max(0, x - pw / 2), Math.max(0, w - pw));
    const { background, foreground } = generateContrastColors(line?.labelBackgroundColor ?? CROSSHAIR_LABEL_BG);
    return {
      sig: `${w}|${h}|${x}|${text}|${background}`,
      draw: (out) => {
        out.beginList('media');
        out.rects({ radius: 2 }).quad(left, 0, pw, h, background);
        out.text([{ x: left + LABEL_PAD, y: Math.min(h - 4, font.size + 6), text, font, color: foreground }]);
      },
    };
  });
}

// --- grid --------------------------------------------------------------------------

export function createGridFeed<H>(ctx: AxisContext<H>, pane: Pane): SceneSource {
  let gridSig = '';
  let grid: GridSource | null = null;
  let ticksSig = '';
  return {
    zBand: ZBand.Grid,
    update(frame): void {
      const o = ctx.options();
      const nextGridSig = JSON.stringify(o.grid);
      if (grid === null || nextGridSig !== gridSig) {
        gridSig = nextGridSig;
        grid = createGridSource(normalizeGrid(o.grid));
        ticksSig = '';
      }
      const font = fontOf(o);
      const horz = ctx.state.horz();
      const xs = selectTimeMarks(horz, ctx.timeline, font.size).map((m) => horz.indexToCoordinate(m.index));
      const sf = ctx.state.pane(pane, frame.frame.mediaSize.height).defaultScale();
      const ys = sf === null ? [] : priceTicks(sf, font).map((t) => t.y);
      const sig = `${xs.join()}|${ys.join()}`;
      if (sig !== ticksSig) {
        ticksSig = sig;
        grid.setTicks(xs, ys);
      }
      grid.update(frame);
    },
    displayLists: () => grid?.displayLists() ?? EMPTY,
  };
}

const STYLE_NAMES: Record<string, LineStyle> = {
  solid: LineStyle.Solid,
  dotted: LineStyle.Dotted,
  dashed: LineStyle.Dashed,
  'large-dashed': LineStyle.LargeDashed,
  'sparse-dotted': LineStyle.SparseDotted,
};

/** Accept 'solid' | 'dotted' | 'dashed' | 'large-dashed' | 'sparse-dotted' or the enum value. */
export function toLineStyle(v: unknown, fallback: LineStyle): LineStyle {
  if (typeof v === 'number') return v as LineStyle;
  if (typeof v === 'string' && v in STYLE_NAMES) return STYLE_NAMES[v]!;
  return fallback;
}

function normalizeGrid(g: GridOptions): GridOptions {
  const side = (s: GridOptions['vertLines']): GridOptions['vertLines'] => {
    const raw = s as { style?: unknown; lineStyle?: unknown };
    return { ...s, lineStyle: toLineStyle(raw.style ?? raw.lineStyle, LineStyle.Solid) } as GridOptions['vertLines'];
  };
  return { vertLines: side(g.vertLines), horzLines: side(g.horzLines) };
}
