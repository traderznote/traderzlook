// Pure Hi-DPI layout: chart size + pane stretch factors + measured axis widths → the
// media-px rect of every surface. No DOM; the host applies the rects.
import { assert } from '../core';
import type { Rect, Size } from '../core';

export interface PaneRects {
  readonly pane: Rect;
  readonly leftAxis: Rect | null;
  readonly rightAxis: Rect | null;
}

/** Measured (un-rounded) axis widths; 0 ⇒ that side's surface is omitted. */
export interface AxisWidths {
  readonly left: number;
  readonly right: number;
}

export interface LayoutRects {
  readonly chartSize: Size; // even-floored; ≤ the requested size
  readonly paneWidth: number; // model width, set last
  readonly panes: readonly PaneRects[];
  readonly timeAxis: Rect | null; // null when timeAxisHeight resolves to 0
  readonly leftStub: Rect | null; // bottom-left corner under the left axis
  readonly rightStub: Rect | null; // bottom-right corner under the right axis
  readonly separators: readonly Rect[]; // 1-px rows between consecutive panes
}

const MIN_PANE_PX = 2;

/** Floor, then force even, so CSS px × DPR stays integral on both axes. */
function evenDown(v: number): number {
  const f = Math.max(0, Math.floor(v));
  return f - (f % 2);
}

function evenUp(v: number): number {
  if (v <= 0) return 0;
  const c = Math.ceil(v);
  return c % 2 === 0 ? c : c + 1;
}

/** Round to a whole device pixel so `height × dpr` is integral and the canvas never resamples. */
function quantize(mediaPx: number, dpr: number): number {
  return Math.round(mediaPx * dpr) / dpr;
}

/** Axis widths are even'd once up front (each side is already the max across panes);
 *  pane heights are quantized to device pixels, the last pane absorbs the remainder,
 *  and every height is floored at MIN_PANE_PX. */
export function computeLayout(
  chartSize: Size,
  stretchFactors: readonly number[],
  axisWidths: AxisWidths,
  timeAxisHeight: number,
  dpr: number,
): LayoutRects {
  if (__DEV__) {
    assert(stretchFactors.length > 0, 'computeLayout: need at least one pane');
    assert(dpr > 0, 'computeLayout: dpr must be > 0');
    assert(
      stretchFactors.every((s) => s > 0),
      'computeLayout: stretch factors must be > 0',
    );
  }

  const width = evenDown(chartSize.width);
  const height = evenDown(chartSize.height);

  const leftW = evenUp(axisWidths.left);
  const rightW = evenUp(axisWidths.right);

  const taH = evenUp(timeAxisHeight);

  const paneWidth = Math.max(width - leftW - rightW, 0);
  const sepCount = stretchFactors.length - 1;
  const totalPaneHeight = Math.max(height - taH - sepCount, 0);
  const totalStretch = stretchFactors.reduce((a, s) => a + s, 0);
  const pxPerStretch = totalStretch > 0 ? totalPaneHeight / totalStretch : 0;

  // The last pane ceil-absorbs the remainder so the rows sum exactly to totalPaneHeight.
  const panes: PaneRects[] = [];
  const separators: Rect[] = [];
  const last = stretchFactors.length - 1;
  let cursorY = 0;
  let accumulated = 0; // device-quantized pane height consumed so far

  for (let i = 0; i < stretchFactors.length; i++) {
    if (i > 0) {
      separators.push({ x: 0, y: cursorY, width, height: 1 });
      cursorY += 1;
    }

    let h: number;
    if (i === last) {
      h = Math.ceil((totalPaneHeight - accumulated) * dpr) / dpr;
    } else {
      h = quantize(stretchFactors[i] * pxPerStretch, dpr);
    }
    h = Math.max(h, MIN_PANE_PX);
    accumulated += h;

    const leftAxis: Rect | null =
      leftW > 0 ? { x: 0, y: cursorY, width: leftW, height: h } : null;
    const rightAxis: Rect | null =
      rightW > 0 ? { x: width - rightW, y: cursorY, width: rightW, height: h } : null;
    const pane: Rect = { x: leftW, y: cursorY, width: paneWidth, height: h };

    panes.push({ pane, leftAxis, rightAxis });
    cursorY += h;
  }

  let timeAxis: Rect | null = null;
  let leftStub: Rect | null = null;
  let rightStub: Rect | null = null;
  if (taH > 0) {
    const taY = cursorY;
    timeAxis = { x: leftW, y: taY, width: paneWidth, height: taH };
    if (leftW > 0) leftStub = { x: 0, y: taY, width: leftW, height: taH };
    if (rightW > 0) rightStub = { x: width - rightW, y: taY, width: rightW, height: taH };
  }

  return {
    chartSize: { width, height },
    paneWidth,
    panes,
    timeAxis,
    leftStub,
    rightStub,
    separators,
  };
}
