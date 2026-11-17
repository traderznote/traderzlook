// Baseline SeriesKind: fill and stroke are two-band vertical gradients hard-split at
// the base-level Y (no fade). One media `area` fill closed to that Y, then one bitmap
// top polyline whose every vertex carries the split gradient, so the stroke switches
// colour at the baseline without an extra command. The fill never inverts.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, LinearGradientY, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import type { SeriesKind } from './kind';
import { decimateColumns } from './decimate';
import { LineType, walkLine, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

export interface BaselineItem {
  readonly color: string;
}

const DEFAULT_HIT_TOLERANCE = 3;

export interface BaselineKindOptions {
  /** Split price; close ≥ baseValue uses the top colours. */
  readonly baseValue: number;
  readonly topFillColor1: string;
  readonly topFillColor2: string;
  readonly bottomFillColor1: string;
  readonly bottomFillColor2: string;
  readonly topLineColor: string;
  readonly bottomLineColor: string;
  /** Media px (default 3). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
  readonly lineVisible: boolean;
  /** Span the gradient over the visible slice's min/max y instead of the pane. */
  readonly relativeGradient: boolean;
  readonly hitTestTolerance: number;
}

function resolveOptions(o: SeriesOptions): BaselineKindOptions {
  return {
    baseValue: ((o.baseValue as { price?: number } | undefined)?.price as number | undefined) ?? 0,
    topFillColor1: (o.topFillColor1 as string | undefined) ?? 'rgba(38, 166, 154, 0.28)',
    topFillColor2: (o.topFillColor2 as string | undefined) ?? 'rgba(38, 166, 154, 0.05)',
    bottomFillColor1: (o.bottomFillColor1 as string | undefined) ?? 'rgba(239, 83, 80, 0.05)',
    bottomFillColor2: (o.bottomFillColor2 as string | undefined) ?? 'rgba(239, 83, 80, 0.28)',
    topLineColor: (o.topLineColor as string | undefined) ?? 'rgba(38, 166, 154, 1)',
    bottomLineColor: (o.bottomLineColor as string | undefined) ?? 'rgba(239, 83, 80, 1)',
    lineWidth: (o.lineWidth as number | undefined) ?? 3,
    lineStyle: (o.lineStyle as LineStyle | undefined) ?? LineStyle.Solid,
    lineVisible: (o.lineVisible as boolean | undefined) ?? true,
    relativeGradient: (o.relativeGradient as boolean | undefined) ?? false,
    hitTestTolerance: (o.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** Two stops at the same ratio `r = clamp((baseY − top)/(bottom − top), 0, 1)` give a
 *  hard colour switch at baseY. Coordinates are list space. */
function splitGradient(top: number, bottom: number, baseY: number, c0: string, c1: string, c2: string, c3: string): LinearGradientY {
  const span = bottom - top;
  let r = span !== 0 ? (baseY - top) / span : 0;
  r = r < 0 ? 0 : r > 1 ? 1 : r;
  return {
    from: top,
    to: bottom,
    stops: [
      { offset: 0, color: c0 },
      { offset: r, color: c1 },
      { offset: r, color: c2 },
      { offset: 1, color: c3 },
    ],
  };
}

export interface BaselineKind extends SeriesKind<BaselineItem> {
  createBuffer(): ItemBuffer<BaselineItem>;
}

/** Caches the last-convert geometry so `hitTest` replays the slice `emit` drew. */
export function createBaselineKind(options: SeriesOptions): BaselineKind {
  const o = resolveOptions(options);
  const values: number[] = [];
  const colors: string[] = [];
  let lastHr = 1;
  let lastVr = 1;
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  // emit gets no price converter, so convert maps baseValue once and caches it.
  let lastBaseY = 0;

  const colorAt = (i: number): string => colors[i] ?? o.topLineColor;
  const factory = (_b: ItemBuffer<BaselineItem>, i: number): BaselineItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<BaselineItem>): void {
    const n = store.length;
    items.ensure(n);
    items.length = n;
    if (colors.length < n) colors.length = n;
    if (values.length < n) values.length = n;
    const ti = items.timeIndex;
    for (let i = 0; i < n; i++) {
      ti[i] = store.timeIndex(i) as number;
      const value = store.current(i);
      values[i] = value;
      colors[i] = value >= o.baseValue ? o.topLineColor : o.bottomLineColor;
    }
  }

  function convert(
    items: ItemBuffer<BaselineItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastHr = frame.frame.hr;
    lastVr = frame.frame.vr;
    lastBarSpacing = horz.barSpacing;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    lastBaseY = price.priceToCoordinate(o.baseValue as number);
    const x = items.x;
    const y = items.y;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) x[i] = horz.indexToCoordinate(ti[i]!);
    for (let i = from; i < to; i++) y[i] = price.priceToCoordinate(values[i] ?? Number.NaN);
  }

  function emit(items: ItemBuffer<BaselineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const { hr, vr, mediaSize } = frame.frame;
    const x = items.x;
    const y = items.y;

    let top = 0;
    let bottom = mediaSize.height;
    if (o.relativeGradient) {
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (Number.isNaN(yi)) continue;
        if (yi < mn) mn = yi;
        if (yi > mx) mx = yi;
      }
      if (mn !== Number.POSITIVE_INFINITY) {
        top = mn;
        bottom = mx;
      }
    }
    const baseY = lastBaseY;
    const fillGrad = splitGradient(top, bottom, baseY, o.topFillColor1, o.topFillColor2, o.bottomFillColor1, o.bottomFillColor2);

    // A single visible point becomes a one-bar-wide stub; NaN gaps are skipped.
    out.beginList('media');
    const w = out.area(baseY, fillGrad);
    if (to - from === 1) {
      const yi = y[from]!;
      if (!Number.isNaN(yi)) {
        const half = lastBarSpacing / 2;
        w.vertex(x[from]! - half, yi);
        w.vertex(x[from]! + half, yi);
      }
    } else {
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (!Number.isNaN(yi)) w.vertex(x[i]!, yi);
      }
    }

    // The line is in a bitmap list, so its gradient span is in device px (×vr).
    if (o.lineVisible) {
      out.beginList('bitmap');
      const lineGrad = splitGradient(
        top * vr, bottom * vr, baseY * vr,
        o.topLineColor, o.topLineColor, o.bottomLineColor, o.bottomLineColor,
      );
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round');
      walkLine(x, y, colorAt, from, to, hr, vr, lastBarSpacing, LineType.Simple,
        (vx, vy) => poly.vertex(vx, vy, lineGrad), () => poly.gap());
    }
  }

  function decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void {
    out.beginList('bitmap');
    decimateColumns(store, window, frame, horz, price, out, {
      shape: 'line',
      color: o.topLineColor,
      lineWidth: o.lineWidth * frame.frame.vr,
    });
  }

  function hitTest(items: ItemBuffer<BaselineItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const to = lastTo > items.length ? items.length : lastTo;
    const params: LineHitParams = {
      type: LineType.Simple,
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5,
      markerRadius: undefined,
      tolerance: o.hitTestTolerance,
      barSpacing: lastBarSpacing,
      hr: lastHr,
      vr: lastVr,
    };
    return hitTestLine(items.x, items.y, lastFrom, to, x as number, y as number, params);
  }

  function createBuffer(): ItemBuffer<BaselineItem> {
    return new ReusableItemBuffer<BaselineItem>(0, factory);
  }

  if (__DEV__) {
    assert(o.lineWidth >= 1 && o.lineWidth <= 4, 'baseline lineWidth must be 1–4 (study 06 §4.5)');
  }

  return { itemsFromStore, convert, emit, decimate, hitTest, extendedRange: true, createBuffer };
}
