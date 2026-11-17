// OHLC Bar SeriesKind: one bitmap `rects` list per frame — a crisp hi–lo stick plus,
// unless too dense, a left open tick and a right close tick.
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
import { OHLC, OHLC_LANE_STRIDE, ohlc, barColumnWidth, hitTestColumns } from './bar-base';

export interface BarItem {
  readonly color: string;
}

const DEFAULT_HIT_TOLERANCE = 3;

export interface BarKindOptions {
  /** Up bar: open ≤ close. */
  readonly upColor: string;
  readonly downColor: string;
  readonly openVisible: boolean;
  /** Cap the stick at `floor(hr)` device px (default true). */
  readonly thinBars: boolean;
  /** Media px (default 3). */
  readonly hitTestTolerance: number;
}

function resolveBarOptions(options: SeriesOptions): BarKindOptions {
  return {
    upColor: (options.upColor as string | undefined) ?? '#26a69a',
    downColor: (options.downColor as string | undefined) ?? '#ef5350',
    openVisible: (options.openVisible as boolean | undefined) ?? true,
    thinBars: (options.thinBars as boolean | undefined) ?? true,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

export interface BarKind extends SeriesKindShape {
  createBuffer(): ItemBuffer<BarItem>;
}

// SeriesKind<BarItem> spelled out locally (type-only) so BarKind can add createBuffer.
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<BarItem>): void;
  convert(
    items: ItemBuffer<BarItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<BarItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<BarItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

export function createBarKind(options: SeriesOptions): BarKind {
  const o = resolveBarOptions(options);
  // Resolved up/down defaults applied once, so resolveBarColors picks the right
  // branch even when the caller passed raw options.
  const colorOpts: SeriesOptions = { ...options, upColor: o.upColor, downColor: o.downColor };
  const colors: string[] = [];
  const raw: number[] = []; // stride-4 raw open/high/low/close per slot
  // Last-convert window and spacing, replayed by hitTest.
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;
  const colorAt = (i: number): string => colors[i] ?? o.upColor;
  const factory = (_buf: ItemBuffer<BarItem>, i: number): BarItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<BarItem>): void {
    const n = store.length;
    items.ensure(n);
    items.length = n;
    if (colors.length < n) colors.length = n;
    if (raw.length < n * OHLC_LANE_STRIDE) raw.length = n * OHLC_LANE_STRIDE;
    const ti = items.timeIndex;
    for (let i = 0; i < n; i++) {
      ti[i] = store.timeIndex(i) as number;
      const open = store.lane(0, i);
      const close = store.current(i);
      const b = i * OHLC_LANE_STRIDE;
      raw[b + OHLC.Open] = open;
      raw[b + OHLC.High] = store.max(i);
      raw[b + OHLC.Low] = store.min(i);
      raw[b + OHLC.Close] = close;
      colors[i] = resolveBarColors('bar', { open, close }, store.pointColors?.(i) ?? {}, colorOpts).barColor;
    }
  }

  function convert(
    items: ItemBuffer<BarItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    lastBarSpacing = horz.barSpacing;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    lastFrom = from;
    lastTo = to;
    const x = items.x;
    const extra = items.extra;
    const ti = items.timeIndex;
    for (let i = from; i < to; i++) {
      x[i] = horz.indexToCoordinate(ti[i]!);
      const b = i * OHLC_LANE_STRIDE;
      for (let k = 0; k < OHLC_LANE_STRIDE; k++) extra[b + k] = price.priceToCoordinate(raw[b + k] ?? Number.NaN);
    }
  }

  function emit(items: ItemBuffer<BarItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;
    const x = items.x;
    const extra = items.extra;
    // stick = thinBars ? min(col, floor(hr)) : col; ticks hidden when barSpacing < 1.5·hr.
    const barWidth = barColumnWidth(lastBarSpacing, hr);
    const lineWidth = o.thinBars ? Math.min(barWidth, Math.floor(hr)) : barWidth;
    const stick = Math.max(1, lineWidth);
    const half = Math.floor(stick / 2);
    const drawTicks = stick <= barWidth && lastBarSpacing >= Math.floor(1.5 * hr);
    const sideWidth = Math.ceil(barWidth * 1.5);

    out.beginList('bitmap');
    const rects = out.rects({});
    for (let i = from; i < to; i++) {
      const highY = ohlc(extra, i, OHLC.High);
      const lowY = ohlc(extra, i, OHLC.Low);
      if (Number.isNaN(highY) || Number.isNaN(lowY)) continue;
      const fill = colorAt(i);
      // Pad the hi–lo extent by half the stick; min/max keeps an inverted scale
      // working, and height ≥ stick keeps a doji visible.
      const center = crispRound(x[i]!, hr);
      const left = center - half;
      const top = crispRound(Math.min(highY, lowY), vr) - half;
      const bottom = crispRound(Math.max(highY, lowY), vr) + half;
      const height = Math.max(bottom - top, stick);
      rects.quad(left, top, stick, height, fill);
      if (!drawTicks) continue;
      const right = left + stick - 1;
      const tickHi = top + height - stick; // ticks stay inside [top, top+height−stick]
      if (o.openVisible) {
        const oTop = clampTo(crispRound(ohlc(extra, i, OHLC.Open), vr) - half, top, tickHi);
        rects.quad(center - sideWidth, oTop, left - (center - sideWidth), stick, fill);
      }
      const cTop = clampTo(crispRound(ohlc(extra, i, OHLC.Close), vr) - half, top, tickHi);
      rects.quad(right + 1, cTop, center + sideWidth - (right + 1), stick, fill);
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
    decimateColumns(store, window, frame, horz, price, out, { shape: 'barlike', color: o.upColor });
  }

  function hitTest(items: ItemBuffer<BarItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const to = lastTo > items.length ? items.length : lastTo;
    const extra = items.extra;
    const span = (i: number): { readonly top: number; readonly bottom: number } => {
      const h = ohlc(extra, i, OHLC.High);
      const l = ohlc(extra, i, OHLC.Low);
      return { top: Math.min(h, l), bottom: Math.max(h, l) };
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

  function createBuffer(): ItemBuffer<BarItem> {
    return new ReusableItemBuffer<BarItem>(OHLC_LANE_STRIDE, factory);
  }

  if (__DEV__) {
    assert(typeof o.upColor === 'string' && typeof o.downColor === 'string', 'bar up/down colours must be strings');
  }

  return { itemsFromStore, convert, emit, decimate, hitTest, extendedRange: false, createBuffer };
}

function clampTo(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
