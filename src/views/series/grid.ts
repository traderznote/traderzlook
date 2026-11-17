// Grid scene source: one bitmap polyline per orientation, a line at each tick,
// overdrawn one line width past each end so dash patterns never clip at the border.
// Rebuilds only on setTicks or when hr/vr/bitmap size change.
import { DisplayListBuilder, LineStyle, ZBand, crispStrokePos, crispWidth } from '../../gfx';
import type { DisplayList, ViewFrame } from '../../gfx';
import type { GridOptions } from '../../model';

export interface GridSideStyle {
  readonly color: string;
  readonly visible: boolean;
  /** Media px (default 1). */
  readonly lineWidth: number;
  readonly lineStyle: LineStyle;
}

function resolveSide(s: { color: string; visible: boolean; lineWidth?: number; lineStyle?: LineStyle }): GridSideStyle {
  return { color: s.color, visible: s.visible, lineWidth: s.lineWidth ?? 1, lineStyle: s.lineStyle ?? LineStyle.Solid };
}

export interface GridSource {
  readonly zBand: ZBand;
  update(frame: ViewFrame): void;
  displayLists(): readonly DisplayList[];
  /** Tick coords in media px: `vertX` from the time scale, `horzY` from the price
   *  scale. Marks the source dirty. */
  setTicks(vertX: readonly number[], horzY: readonly number[]): void;
}

export function createGridSource(options: GridOptions): GridSource {
  const vert = resolveSide(options.vertLines);
  const horz = resolveSide(options.horzLines);

  let vertX: readonly number[] = [];
  let horzY: readonly number[] = [];
  let dirty = true;
  let lastHr = Number.NaN;
  let lastVr = Number.NaN;
  let lastBw = Number.NaN;
  let lastBh = Number.NaN;
  let cached: readonly DisplayList[] = EMPTY;

  function setTicks(nextVertX: readonly number[], nextHorzY: readonly number[]): void {
    vertX = nextVertX;
    horzY = nextHorzY;
    dirty = true;
  }

  function update(frame: ViewFrame): void {
    const { hr, vr, bitmapSize } = frame.frame;
    const bw = bitmapSize.width;
    const bh = bitmapSize.height;
    if (!dirty && hr === lastHr && vr === lastVr && bw === lastBw && bh === lastBh) return;
    lastHr = hr;
    lastVr = vr;
    lastBw = bw;
    lastBh = bh;
    dirty = false;
    cached = build(vert, horz, vertX, horzY, hr, vr, bw, bh);
  }

  function displayLists(): readonly DisplayList[] {
    return cached;
  }

  return { zBand: ZBand.Grid, update, displayLists, setTicks };
}

const EMPTY: readonly DisplayList[] = Object.freeze([]);

/** Each line is two crisp vertices then a pen-up gap. A side with no visible ticks
 *  emits nothing. */
function build(
  vert: GridSideStyle,
  horz: GridSideStyle,
  vertX: readonly number[],
  horzY: readonly number[],
  hr: number,
  vr: number,
  bw: number,
  bh: number,
): readonly DisplayList[] {
  // A fresh builder per rebuild: its pooled arrays back the cached lists, and a reused
  // builder's reset would alias them. Rebuilds are dirty-gated, so this is cold.
  const out = new DisplayListBuilder();
  out.beginList('bitmap');
  let drew = false;
  if (vert.visible && vertX.length > 0) {
    const w = crispWidth(vert.lineWidth, hr);
    const poly = out.polyline(w, vert.lineStyle, 'miter');
    for (let i = 0; i < vertX.length; i++) {
      const x = crispStrokePos(vertX[i]!, hr, w);
      poly.vertex(x, -w, vert.color);
      poly.vertex(x, bh + w, vert.color);
      poly.gap();
    }
    drew = true;
  }
  if (horz.visible && horzY.length > 0) {
    const w = crispWidth(horz.lineWidth, vr);
    const poly = out.polyline(w, horz.lineStyle, 'miter');
    for (let i = 0; i < horzY.length; i++) {
      const y = crispStrokePos(horzY[i]!, vr, w);
      poly.vertex(-w, y, horz.color);
      poly.vertex(bw + w, y, horz.color);
      poly.gap();
    }
    drew = true;
  }
  if (!drew) return EMPTY;
  return out.finish();
}
