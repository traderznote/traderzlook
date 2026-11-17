// Price-line scene source: a full-width horizontal bitmap line at a series price, drawn
// above the series. `provider` supplies y/colour/text each frame; `axisLabel()` reads
// the same state so line and label never disagree.
import type { Coordinate } from '../../core';
import { crispRound, crispStrokePos, crispWidth, DisplayListBuilder, HitPriority, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, HitCandidate, SceneSource, ViewFrame } from '../../gfx';
import type { AxisLabel } from '../../model';

/** `y` is media px (null = no data, line hidden); `barColor` is the fallback when the
 *  `color` option is empty. */
export interface PriceLineState {
  readonly y: number | null;
  readonly barColor: string;
  readonly text: string;
}

export interface PriceLineOptions {
  readonly visible: boolean;
  /** '' → the last bar's resolved colour. */
  readonly color: string;
  /** Media px, ≥ 1 (default 1). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
  readonly axisLabelVisible: boolean;
  /** Echoed on hits. */
  readonly externalId?: string;
}

const DEFAULTS: PriceLineOptions = {
  visible: true,
  color: '',
  lineWidth: 1,
  lineStyle: LineStyle.Dashed,
  axisLabelVisible: true,
};

function resolve(o?: Partial<PriceLineOptions>): PriceLineOptions {
  return {
    visible: o?.visible ?? DEFAULTS.visible,
    color: o?.color ?? DEFAULTS.color,
    lineWidth: o?.lineWidth ?? DEFAULTS.lineWidth,
    lineStyle: o?.lineStyle ?? DEFAULTS.lineStyle,
    axisLabelVisible: o?.axisLabelVisible ?? DEFAULTS.axisLabelVisible,
    externalId: o?.externalId,
  };
}

/** Fixed hit threshold added to the line width. */
const HIT_PAD = 7;
const EMPTY: readonly DisplayList[] = Object.freeze([]);

export interface PriceLineSource extends SceneSource {
  axisLabel(): AxisLabel;
}

export function createPriceLineSource(
  provider: () => PriceLineState,
  options?: Partial<PriceLineOptions>,
): PriceLineSource {
  const o = resolve(options);
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  const fillOf = (s: PriceLineState): string => (o.color !== '' ? o.color : s.barColor);
  // The off-pane test uses the crisp-rounded device y (what would actually be drawn),
  // so a raw y·vr in (−0.5, 0) or (bh, bh+0.5] rounds onto the edge and still draws.
  function drawable(s: PriceLineState, vr: number, bh: number): boolean {
    if (!o.visible || s.y === null || !Number.isFinite(s.y)) return false;
    const yDev = crispRound(s.y, vr);
    return yDev >= 0 && yDev <= bh;
  }

  function signature(s: PriceLineState, f: ViewFrame['frame']): string {
    if (!drawable(s, f.vr, f.bitmapSize.height)) return 'hidden';
    return `${s.y}|${fillOf(s)}|${f.vr}|${f.bitmapSize.width}|${f.bitmapSize.height}`;
  }

  function build(s: PriceLineState, f: ViewFrame['frame']): readonly DisplayList[] {
    if (!drawable(s, f.vr, f.bitmapSize.height)) return EMPTY;
    // Horizontal line, so its width and crisp position both use vr.
    const w = crispWidth(o.lineWidth, f.vr);
    const py = crispStrokePos(s.y as number, f.vr, w);
    const fill = fillOf(s);
    builder.reset();
    builder.beginList('bitmap');
    const poly = builder.polyline(w, o.lineStyle, 'miter');
    poly.vertex(0, py, fill);
    poly.vertex(f.bitmapSize.width, py, fill);
    return builder.finish();
  }

  return {
    zBand: ZBand.AboveSeries,
    update(frame: ViewFrame): void {
      const s = provider();
      const next = signature(s, frame.frame);
      if (next === sig) return;
      sig = next;
      cached = build(s, frame.frame);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
    // Purely vertical distance; hits when |y − lineY| ≤ lineWidth + 7 (media px).
    hitTest(_x: Coordinate, y: Coordinate): HitCandidate | null {
      const s = provider();
      if (!o.visible || s.y === null || !Number.isFinite(s.y)) return null;
      const d = Math.abs((y as number) - s.y);
      if (d > o.lineWidth + HIT_PAD) return null;
      return { distance: d, priority: HitPriority.Point, externalId: o.externalId };
    },
    axisLabel(): AxisLabel {
      return {
        coordinate: () => provider().y ?? Number.NaN,
        text: () => provider().text,
        textColor: () => fillOf(provider()),
        backColor: () => fillOf(provider()),
        visible: () => o.visible && o.axisLabelVisible && provider().y !== null,
      };
    },
  };
}
