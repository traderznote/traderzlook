// Crosshair scene source (view only; state lives in model/crosshair). Vertical and
// horizontal lines are separate bitmap polylines so each keeps its own width and dash.
import { crispStrokePos, crispWidth, DisplayListBuilder, LineStyle, ZBand } from '../../gfx';
import type { DisplayList, FillStyle, SceneSource, ViewFrame } from '../../gfx';
import type { Crosshair } from '../../model';

export interface CrosshairLineOptions {
  readonly color: FillStyle;
  /** Media px, ≥ 1 (default 1). */
  readonly width: number;
  readonly style: LineStyle;
  readonly visible: boolean;
}

const DEFAULT_LINE: CrosshairLineOptions = {
  color: '#9598A1',
  width: 1,
  style: LineStyle.LargeDashed,
  visible: true,
};

function resolveLine(o?: Partial<CrosshairLineOptions>): CrosshairLineOptions {
  return {
    color: o?.color ?? DEFAULT_LINE.color,
    width: o?.width ?? DEFAULT_LINE.width,
    style: o?.style ?? DEFAULT_LINE.style,
    visible: o?.visible ?? DEFAULT_LINE.visible,
  };
}

const EMPTY: readonly DisplayList[] = [];

export interface CrosshairSourceOptions {
  readonly vertLine?: Partial<CrosshairLineOptions>;
  readonly horzLine?: Partial<CrosshairLineOptions>;
}

/** The applied x/y already include bar-snap/magnet alignment, so the view doesn't snap. */
export function createCrosshairSource(crosshair: Crosshair, options?: CrosshairSourceOptions): SceneSource {
  const vert = resolveLine(options?.vertLine);
  const horz = resolveLine(options?.horzLine);
  const builder = new DisplayListBuilder();

  let cached: readonly DisplayList[] = EMPTY;
  // Signature of the state the cache was built from; unchanged → keep the identical array.
  let sig: string | null = null;

  function signature(frame: ViewFrame): string {
    const p = crosshair.position();
    if (p === null || !crosshair.renderVisible()) return 'hidden';
    const f = frame.frame;
    return `${p.x}|${p.y}|${f.hr}|${f.vr}|${f.bitmapSize.width}|${f.bitmapSize.height}`;
  }

  function build(frame: ViewFrame): readonly DisplayList[] {
    const p = crosshair.position();
    if (p === null || !crosshair.renderVisible()) return EMPTY;
    const x = p.x as number;
    const y = p.y as number;
    const f = frame.frame;
    const hr = f.hr;
    const vr = f.vr;
    const bw = f.bitmapSize.width;
    const bh = f.bitmapSize.height;

    const drawVert = vert.visible && Number.isFinite(x);
    // A y outside [0, bitmapH] means the pointer is in another pane: no horizontal line.
    const yDev = y * vr;
    const drawHorz = horz.visible && Number.isFinite(y) && yDev >= 0 && yDev <= bh;
    if (!drawVert && !drawHorz) return EMPTY;

    builder.reset();
    builder.beginList('bitmap');
    if (drawVert) {
      const w = crispWidth(vert.width, hr);
      const px = crispStrokePos(x, hr, w);
      const poly = builder.polyline(w, vert.style, 'miter');
      poly.vertex(px, 0, vert.color);
      poly.vertex(px, bh, vert.color);
    }
    if (drawHorz) {
      const w = crispWidth(horz.width, vr);
      const py = crispStrokePos(y, vr, w);
      const poly = builder.polyline(w, horz.style, 'miter');
      poly.vertex(0, py, horz.color);
      poly.vertex(bw, py, horz.color);
    }
    return builder.finish();
  }

  return {
    zBand: ZBand.Crosshair,
    update(frame: ViewFrame): void {
      const next = signature(frame);
      if (next === sig) return;
      sig = next;
      cached = build(frame);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}
