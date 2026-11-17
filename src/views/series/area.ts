// Area SeriesKind: two lists, fill then line — a media-space `area` fill closed to a
// base level with a vertical gradient, then a bitmap-space top polyline (×hr/vr,
// unrounded) sharing line's walker. Per-point fill overrides split the fill into
// adjoining `area` commands that share the boundary vertex.
import { assert } from '../../core';
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import { LineStyle } from '../../gfx';
import type { DisplayListBuilder, FillStyle, HitCandidate, LinearGradientY, ViewFrame } from '../../gfx';
import { ReusableItemBuffer } from './buffer';
import type { ItemBuffer, ItemFactory } from './buffer';
import type { ItemWindow } from './window';
import type { SeriesKind } from './kind';
import { decimateColumns } from './decimate';
import { LineType, walkLine, hitTestLine } from './line-base';
import type { LineHitParams } from './line-base';

/** Per-row colour override; an absent field falls back to the option. */
export interface AreaPointColors {
  readonly lineColor?: string;
  readonly topColor?: string;
  readonly bottomColor?: string;
}

export interface AreaKindOptions {
  readonly topColor: string;
  readonly bottomColor: string;
  readonly lineColor: string;
  /** Media px (default 3). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
  readonly lineVisible: boolean;
  /** Fill upward to y=0 instead of down to pane height. */
  readonly invertFilledArea: boolean;
  /** Anchor the gradient top at the highest visible point's y. */
  readonly relativeGradient: boolean;
  /** Media px (default 3). */
  readonly hitTestTolerance: number;
  readonly pointColors?: (index: number) => AreaPointColors | undefined;
}

const DEFAULT_AREA_OPTIONS: AreaKindOptions = {
  topColor: 'rgba( 46, 220, 135, 0.4)',
  bottomColor: 'rgba( 40, 221, 100, 0)',
  lineColor: '#33D778',
  lineWidth: 3,
  lineStyle: LineStyle.Solid,
  lineVisible: true,
  invertFilledArea: false,
  relativeGradient: false,
  hitTestTolerance: 3,
};

/** `x`/`y` are media px; colours are resolved once per row in `itemsFromStore`. */
export interface AreaItem {
  readonly x: number;
  readonly y: number;
  readonly timeIndex: number;
  readonly lineColor: string;
  readonly topColor: string;
  readonly bottomColor: string;
}

class AreaKind implements SeriesKind<AreaItem> {
  readonly extendedRange = true;

  readonly #opts: AreaKindOptions;
  // Colour lanes parallel to the buffer (Float32 lanes can't hold strings); never shrunk.
  #lineColors: string[] = [];
  #topColors: string[] = [];
  #bottomColors: string[] = [];
  // Cached by `convert` because emit/hitTest don't receive `horz`; sizes the
  // single-point stub.
  #barSpacing = 0;
  // The converted window. On the decimated path convert is skipped, so this stays
  // empty and hitTest returns null.
  #lastFrom = 0;
  #lastTo = 0;
  #lineColorAt = (i: number): string => this.#lineColors[i] ?? this.#opts.lineColor;

  constructor(opts: AreaKindOptions) {
    this.#opts = opts;
  }

  itemFactory(): ItemFactory<AreaItem> {
    return (b: ItemBuffer<AreaItem>, i: number): AreaItem => ({
      x: b.x[i]!,
      y: b.y[i]!,
      timeIndex: b.timeIndex[i]!,
      lineColor: this.#lineColors[i] ?? this.#opts.lineColor,
      topColor: this.#topColors[i] ?? this.#opts.topColor,
      bottomColor: this.#bottomColors[i] ?? this.#opts.bottomColor,
    });
  }

  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<AreaItem>): void {
    // append/updateLast patch the tail; everything else reloads in full.
    switch (diff.kind) {
      case 'append':
        this.#patchFrom(store, items, store.length - diff.count);
        break;
      case 'updateLast':
        this.#patchFrom(store, items, store.length > 0 ? store.length - 1 : 0);
        break;
      default:
        this.#patchFrom(store, items, 0);
        break;
    }
  }

  /** Copy rows `[from, store.length)` into the buffer; the raw close goes into the
   *  `extra` lane for `convert` to read back. */
  #patchFrom(store: PlotStoreView, items: ItemBuffer<AreaItem>, from: number): void {
    const n = store.length;
    items.ensure(n);
    items.length = n;
    const pc = this.#opts.pointColors;
    const value = items.extra;
    for (let i = from; i < n; i++) {
      items.timeIndex[i] = store.timeIndex(i) as number;
      value[i] = store.current(i);
      const ov = pc ? pc(i) : undefined;
      this.#lineColors[i] = ov?.lineColor ?? this.#opts.lineColor;
      this.#topColors[i] = ov?.topColor ?? this.#opts.topColor;
      this.#bottomColors[i] = ov?.bottomColor ?? this.#opts.bottomColor;
    }
  }

  convert(
    items: ItemBuffer<AreaItem>,
    window: ItemWindow,
    _frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void {
    this.#barSpacing = horz.barSpacing;
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    this.#lastFrom = from;
    this.#lastTo = to;
    const value = items.extra;
    for (let i = from; i < to; i++) {
      items.x[i] = horz.indexToCoordinate(items.timeIndex[i]!);
      const v = value[i]!;
      items.y[i] = Number.isNaN(v) ? Number.NaN : price.priceToCoordinate(v);
    }
  }

  emit(items: ItemBuffer<AreaItem>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void {
    const from = window.from < 0 ? 0 : window.from;
    const to = window.to > items.length ? items.length : window.to;
    if (to - from < 1) return;

    const { hr, vr, mediaSize } = frame.frame;
    const o = this.#opts;
    const x = items.x;
    const y = items.y;

    let topY = 0;
    if (o.relativeGradient) {
      let min = Number.POSITIVE_INFINITY;
      for (let i = from; i < to; i++) {
        const yi = y[i]!;
        if (!Number.isNaN(yi) && yi < min) min = yi;
      }
      if (min !== Number.POSITIVE_INFINITY) topY = min;
    }
    const baseY = o.invertFilledArea ? 0 : mediaSize.height;
    // The gradient always spans topY → pane height, independent of the polygon's
    // base; an inverted area (baseY = 0) must not collapse it to [topY, 0].
    const gradBottom = mediaSize.height;

    out.beginList('media');
    if (to - from === 1) {
      const i = from;
      const yi = y[i]!;
      if (!Number.isNaN(yi)) {
        const half = this.#barSpacing / 2;
        const fill = this.#fillStyle(this.#topColors[i] ?? o.topColor, this.#bottomColors[i] ?? o.bottomColor, topY, gradBottom);
        const w = out.area(baseY, fill);
        w.vertex(x[i]! - half, yi);
        w.vertex(x[i]! + half, yi);
      }
    } else {
      this.#emitFill(x, y, from, to, topY, baseY, gradBottom, out);
    }

    if (o.lineVisible) {
      out.beginList('bitmap');
      const poly = out.polyline(o.lineWidth * vr, o.lineStyle, 'round');
      walkLine(x, y, this.#lineColorAt, from, to, hr, vr, this.#barSpacing, LineType.Simple,
        (vx, vy, fill) => poly.vertex(vx, vy, fill), () => poly.gap());
    }
  }

  /** Styled-run fill: a run spans [runFirst, changeVertex] inclusive and the next run
   *  re-emits the boundary vertex. The writer opens lazily, so a colour change on the
   *  last visible item never emits a degenerate single-vertex area. NaN closes a run. */
  #emitFill(
    x: Float32Array,
    y: Float32Array,
    from: number,
    to: number,
    topY: number,
    baseY: number,
    gradBottom: number,
    out: DisplayListBuilder,
  ): void {
    const o = this.#opts;
    let runTop = '';
    let runBot = '';
    let w: ReturnType<DisplayListBuilder['area']> | null = null;
    // Deferred boundary vertex plus the new run's colour, captured at the change point.
    let pendShareX = Number.NaN;
    let pendShareY = Number.NaN;
    let pendTop = '';
    let pendBot = '';
    for (let i = from; i < to; i++) {
      const yi = y[i]!;
      const xi = x[i]!;
      if (Number.isNaN(yi)) {
        w = null;
        pendShareX = Number.NaN;
        continue;
      }
      const ct = this.#topColors[i] ?? o.topColor;
      const cb = this.#bottomColors[i] ?? o.bottomColor;
      if (w !== null && (ct !== runTop || cb !== runBot)) {
        w.vertex(xi, yi);
        w = null;
        pendShareX = xi;
        pendShareY = yi;
        pendTop = ct;
        pendBot = cb;
        continue;
      }
      if (w === null) {
        runTop = Number.isNaN(pendShareX) ? ct : pendTop;
        runBot = Number.isNaN(pendShareX) ? cb : pendBot;
        w = out.area(baseY, this.#fillStyle(runTop, runBot, topY, gradBottom));
        if (!Number.isNaN(pendShareX)) {
          w.vertex(pendShareX, pendShareY);
          pendShareX = Number.NaN;
        }
      }
      w.vertex(xi, yi);
    }
  }

  /** Gradient coordinates are list space (media px here), with no pixel-ratio multiplier. */
  #fillStyle(top: string, bottom: string, fromY: number, toY: number): FillStyle {
    const g: LinearGradientY = {
      from: fromY,
      to: toY,
      stops: [
        { offset: 0, color: top },
        { offset: 1, color: bottom },
      ],
    };
    return g;
  }

  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void {
    out.beginList('bitmap');
    decimateColumns(store, window, frame, horz, price, out, {
      shape: 'area',
      color: this.#opts.lineColor,
      lineWidth: this.#opts.lineWidth * frame.frame.vr,
    });
  }

  hitTest(items: ItemBuffer<AreaItem>, x: Coordinate, y: Coordinate): HitCandidate | null {
    const o = this.#opts;
    const params: LineHitParams = {
      type: LineType.Simple,
      lineHalf: o.lineVisible ? o.lineWidth / 2 : 0.5,
      markerRadius: undefined,
      tolerance: o.hitTestTolerance,
      barSpacing: this.#barSpacing,
      hr: 1,
      vr: 1, // unused for Simple
    };
    const to = this.#lastTo > items.length ? items.length : this.#lastTo;
    return hitTestLine(items.x, items.y, this.#lastFrom, to, x as number, y as number, params);
  }
}

// `extra` caches the raw close so `convert`, which doesn't receive the store, can map value → Y.
const LANE_STRIDE = 1;

export function createAreaKind(opts?: Partial<AreaKindOptions>): {
  readonly kind: SeriesKind<AreaItem>;
  readonly buffer: ItemBuffer<AreaItem>;
} {
  if (__DEV__ && opts?.lineWidth !== undefined) {
    assert(opts.lineWidth >= 1 && opts.lineWidth <= 4, 'area lineWidth must be 1–4 (study 06 §4.5)');
  }
  const kind = new AreaKind({ ...DEFAULT_AREA_OPTIONS, ...opts });
  const buffer = new ReusableItemBuffer<AreaItem>(LANE_STRIDE, kind.itemFactory());
  return { kind, buffer };
}
