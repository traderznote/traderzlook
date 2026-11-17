// Line SeriesKind. emit draws one unrounded, AA-smooth bitmap polyline (x·hr, y·vr)
// plus optional marker circles; convert captures hr/vr/barSpacing/window so hitTest
// replays the exact geometry emit drew.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter, SeriesOptions } from '../../model';
import { resolveBarColors } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';
import { decimateColumns } from './decimate';
import { LineType, walkLine, emitMarkers, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

export { LineType };

export interface LineItem {
  readonly color: string;
}

const DEFAULT_HIT_TOLERANCE = 3;

export interface LineKindOptions {
  readonly color: string;
  /** Media px, 1–4 (default 3). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
  readonly lineType: LineType;
  readonly lineVisible: boolean;
  readonly pointMarkersVisible: boolean;
  /** Falsy (including 0) → `lineWidth/2 + 2`. */
  readonly pointMarkersRadius?: number;
  /** Media px (default 3). */
  readonly hitTestTolerance: number;
}

function resolveLineOptions(options: SeriesOptions): LineKindOptions {
  return {
    color: (options.color as string | undefined) ?? '#2196f3',
    lineWidth: (options.lineWidth as number | undefined) ?? 3,
    lineStyle: (options.lineStyle as LineStyle | undefined) ?? LineStyle.Solid,
    lineType: (options.lineType as LineType | undefined) ?? LineType.Simple,
    lineVisible: (options.lineVisible as boolean | undefined) ?? true,
    pointMarkersVisible: (options.pointMarkersVisible as boolean | undefined) ?? false,
    pointMarkersRadius: options.pointMarkersRadius as number | undefined,
    hitTestTolerance: (options.hitTestTolerance as number | undefined) ?? DEFAULT_HIT_TOLERANCE,
  };
}

/** Undefined when markers are hidden; falsy-OR so an explicit 0 uses the default. */
function markerRadius(o: LineKindOptions): number | undefined {
  if (!o.pointMarkersVisible) return undefined;
  return o.pointMarkersRadius || o.lineWidth / 2 + 2;
}

export interface LineKind extends SeriesKindShape {
  /** A buffer whose `item(i)` reads this kind's colour array. */
  createBuffer(): ItemBuffer<LineItem>;
}

// SeriesKind<LineItem> spelled out locally (type-only) so LineKind can add createBuffer.
interface SeriesKindShape {
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<LineItem>): void;
  convert(
    items: ItemBuffer<LineItem>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;
  emit(items: ItemBuffer<LineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;
  hitTest(items: ItemBuffer<LineItem>, x: Coordinate, y: Coordinate): HitCandidate | null;
  readonly extendedRange: boolean;
}

export function createLineKind(options: SeriesOptions): LineKind {
  const o = resolveLineOptions(options);
  // Per-point row.color isn't reachable through the read-only PlotStoreView, so
  // every slot resolves to the option colour via the shared colorer.
  const colors: string[] = [];
  // Last-convert geometry and window, replayed by hitTest.
  let lastHr = 1;
  let lastVr = 1;
  let lastBarSpacing = 0;
  let lastFrom = 0;
  let lastTo = 0;

  const values: number[] = [];
  const colorAt = (i: number): string => colors[i] ?? o.color;

  const factory = (_buf: ItemBuffer<LineItem>, i: number): LineItem => ({ color: colorAt(i) });

  function itemsFromStore(store: PlotStoreView, _diff: StoreDiff, items: ItemBuffer<LineItem>): void {
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
      colors[i] = resolveBarColors('line', { open: 0, close: value }, store.pointColors?.(i) ?? {}, options).barColor;
    }
  }

  function convert(
    items: ItemBuffer<LineItem>,
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

  function emit(items: ItemBuffer<LineItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    if (!o.lineVisible && markerRadius(o) === undefined) return;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to <= from) return;
    const hr = frame.frame.hr;
    const vr = frame.frame.vr;

    out.beginList('bitmap');
    if (o.lineVisible) {
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round');
      walkLine(items.x, items.y, colorAt, from, to, hr, vr, lastBarSpacing, o.lineType,
        (x, y, fill) => poly.vertex(x, y, fill), () => poly.gap());
    }
    const r = markerRadius(o);
    if (r !== undefined) emitMarkers(out.circles(), items.x, items.y, colorAt, from, to, hr, vr, r);
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
      color: o.color,
      lineWidth: o.lineWidth * frame.frame.vr,
    });
  }

  function hitTest(items: ItemBuffer<LineItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    // The buffer's x/y are only valid in the last-convert window; outside it they're stale.
    const to = lastTo > items.length ? items.length : lastTo;
    const params: LineHitParams = {
      type: o.lineType,
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5,
      markerRadius: markerRadius(o),
      tolerance: o.hitTestTolerance,
      barSpacing: lastBarSpacing,
      hr: lastHr,
      vr: lastVr,
    };
    return hitTestLine(items.x, items.y, lastFrom, to, x as number, y as number, params);
  }

  function createBuffer(): ItemBuffer<LineItem> {
    return new ReusableItemBuffer<LineItem>(0, factory);
  }

  if (__DEV__) {
    assert(o.lineWidth >= 1 && o.lineWidth <= 4, 'line lineWidth must be 1–4 (study 06 §4.5)');
  }

  return {
    itemsFromStore,
    convert,
    emit,
    decimate,
    hitTest,
    extendedRange: true,
    createBuffer,
  };
}
