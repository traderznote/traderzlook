// Histogram SeriesKind. emit is two-phase: build a device-px column geometry cache
// (keyed on window, barSpacing, hr), then paint one bitmap `rects` list whose columns
// straddle the crisp base tick so a zero-value column still shows.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { resolveBarColors } from '../../model';
import { crispRound } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import { decimateColumns } from './decimate';
import { hitTestColumns } from './bar-base';

export interface HistogramItem {
  readonly color: string;
}

const DEFAULT_HIT_TOLERANCE = 3;
/** Equalize column widths only when the narrowest is below this. */
const ALIGN_TO_MINIMAL_WIDTH_LIMIT = 4;

export interface HistogramKindOptions {
  readonly color: string;
  /** Base price the columns rise from / fall to (default 0). */
  readonly base: number;
  /** Media px (default 3). */
  readonly hitTestTolerance: number;
}

function resolveHistogramOptions(options: SeriesOptions): HistogramKindOptions {
  return {
    color: (options.color as string | undefined) ?? '#26a69a',
    base: (options.base as number | undefined) ?? 0,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

export interface HistogramKind extends SeriesKindShape {
  createBuffer(): ItemBuffer<HistogramItem>;
}

// SeriesKind<HistogramItem> spelled out locally (type-only) to add createBuffer.
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<HistogramItem>): void;
  convert(
    items: ItemBuffer<HistogramItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<HistogramItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<HistogramItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

/** Device-px column edges per slot, keyed on (from, to, barSpacing, hr). */
interface ColumnCache {
  from: number;
  to: number;
  barSpacing: number;
  hr: number;
  left: Int32Array;
  right: Int32Array; // inclusive
  roundedUp: Uint8Array; // 1 iff round(x·hr) > x·hr (centre biased right)
}

export function createHistogramKind(options: SeriesOptions): HistogramKind {
  const o = resolveHistogramOptions(options);
  const colors: string[] = [];
  const values: number[] = [];
  // Last-convert window, spacing and base Y, replayed by hitTest.
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  let lastBaseY = 0; // media px
  const cache: ColumnCache = {
    from: -1,
    to: -1,
    barSpacing: Number.NaN,
    hr: Number.NaN,
    left: new Int32Array(0),
    right: new Int32Array(0),
    roundedUp: new Uint8Array(0),
  };
  const colorAt = (i: number): string => colors[i] ?? o.color;
  const factory = (_buf: ItemBuffer<HistogramItem>, i: number): HistogramItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<HistogramItem>): void {
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
      colors[i] = resolveBarColors('histogram', { open: 0, close: value }, store.pointColors?.(i) ?? {}, options).barColor;
    }
  }

  function convert(
    items: ItemBuffer<HistogramItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastBarSpacing = horz.barSpacing;
    lastBaseY = price.priceToCoordinate(o.base);
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    const x = items.x;
    const y = items.y;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) {
      x[i] = horz.indexToCoordinate(ti[i]!);
    }
    for (let i = from; i < to; i++) {
      y[i] = price.priceToCoordinate(values[i] ?? Number.NaN); // NaN propagates as a gap
    }
  }

  function buildColumns(items: ItemBuffer<HistogramItem>, from: number, to: number, barSpacing: number, hr: number): void {
    if (cache.from === from && cache.to === to && cache.barSpacing === barSpacing && cache.hr === hr) return;
    if (cache.left.length < to) {
      cache.left = new Int32Array(to);
      cache.right = new Int32Array(to);
      cache.roundedUp = new Uint8Array(to);
    }
    cache.from = from;
    cache.to = to;
    cache.barSpacing = barSpacing;
    cache.hr = hr;
    const { left, right, roundedUp } = cache;
    const x = items.x;
    const ti = items.timeIndex;
    // 1px gap between columns unless ultra-dense (≤ 1 device px per slot).
    const spacing = Math.ceil(barSpacing * hr) <= 1 ? 0 : Math.max(1, Math.floor(hr));
    const columnWidth = Math.round(barSpacing * hr) - spacing;
    const odd = columnWidth % 2 !== 0;
    const half = odd ? (columnWidth - 1) / 2 : columnWidth / 2;
    for (let i = from; i < to; i++) {
      const exact = x[i]! * hr;
      const center = Math.round(exact);
      roundedUp[i] = center > exact ? 1 : 0;
      left[i] = center - half;
      right[i] = odd ? center + half : center + half - 1; // even width → bias one px left
    }
    // Alignment: keep exactly spacing+1 between adjacent (consecutive-index) columns.
    for (let i = from + 1; i < to; i++) {
      if (ti[i] !== ti[i - 1]! + 1) continue;
      if (left[i]! - right[i - 1]! !== spacing + 1) {
        if (roundedUp[i - 1]) right[i - 1] = left[i]! - spacing - 1;
        else left[i] = right[i - 1]! + spacing + 1;
      }
    }
    // A sub-1px slot can produce right < left; collapse to a 1px column.
    for (let i = from; i < to; i++) {
      if (right[i]! < left[i]!) right[i] = left[i]!;
    }
    // Equalize: shave wider columns down to the narrowest, only when there is a gap
    // and the narrowest is below the limit. Shave on the side the centre rounded toward.
    let minWidth = Math.ceil(barSpacing * hr);
    for (let i = from; i < to; i++) {
      const w = right[i]! - left[i]! + 1;
      if (w < minWidth) minWidth = w;
    }
    if (spacing > 0 && minWidth < ALIGN_TO_MINIMAL_WIDTH_LIMIT) {
      for (let i = from; i < to; i++) {
        if (right[i]! - left[i]! + 1 > minWidth) {
          if (roundedUp[i]) right[i] = right[i]! - 1;
          else left[i] = left[i]! + 1;
        }
      }
    }
  }

  function emit(items: ItemBuffer<HistogramItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;
    buildColumns(items, from, to, lastBarSpacing, hr);
    const { left, right } = cache;
    const y = items.y;
    // The base zone is `tickWidth` tall so a zero-height column still shows a tick.
    const tickWidth = Math.max(1, Math.floor(vr));
    const baseY = crispRound(lastBaseY, vr);
    const topBase = baseY - Math.floor(tickWidth / 2);
    const bottomBase = topBase + tickWidth;

    out.beginList('bitmap');
    const rects = out.rects({});
    for (let i = from; i < to; i++) {
      const yi = y[i]!;
      if (Number.isNaN(yi)) continue;
      const yc = crispRound(yi, vr);
      // Above base → [y .. bottomBase]; at/below → [topBase .. y − tickWidth/2 + tickWidth].
      const top = yc <= topBase ? yc : topBase;
      const bottom = yc <= topBase ? bottomBase : yc - Math.floor(tickWidth / 2) + tickWidth;
      rects.quad(left[i]!, top, right[i]! - left[i]! + 1, bottom - top, colorAt(i));
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
      shape: 'histogram',
      color: o.color,
      baseY: crispRound(price.priceToCoordinate(o.base), frame.frame.vr), // device-px baseY
    });
  }

  function hitTest(items: ItemBuffer<HistogramItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const to = lastTo > items.length ? items.length : lastTo;
    const ys = items.y;
    const span = (i: number): { readonly top: number; readonly bottom: number } => {
      const yi = ys[i]!;
      return { top: Math.min(yi, lastBaseY), bottom: Math.max(yi, lastBaseY) };
    };
    return hitTestColumns(
      items.x,
      items.timeIndex,
      span,
      lastFrom,
      to,
      x as number,
      y as number,
      lastBarSpacing,
      o.hitTestTolerance,
    );
  }

  function createBuffer(): ItemBuffer<HistogramItem> {
    return new ReusableItemBuffer<HistogramItem>(0, factory);
  }

  if (__DEV__) {
    assert(Number.isFinite(o.base), 'histogram base must be finite (study 06 §4.17)');
  }

  return {
    itemsFromStore,
    convert,
    emit,
    decimate,
    hitTest,
    extendedRange: false,
    createBuffer,
  };
}
