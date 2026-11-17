// Shared polyline geometry and hit-testing for Line, Area and Baseline.
// Lanes are media px; walkLine's vertex/gap callbacks receive device px (×hr/vr).
// Hit helpers work in media px; the curve flatten uses hr/vr only to size segments
// from the device-px chord, identically to emit.
import { lowerBound } from '../../core';
import { HitPriority } from '../../gfx';
import type { CirclesWriter } from '../../gfx';
import type { HitCandidate } from '../../gfx';

export const LineType = {
  Simple: 0,
  WithSteps: 1,
  Curved: 2,
} as const;
export type LineType = (typeof LineType)[keyof typeof LineType];

const CURVE_MIN_SEGMENTS = 4;
const CURVE_MAX_SEGMENTS = 24;
const CURVE_TENSION = 6;

/** clamp(ceil(chordPx / 2), 4, 24) — adaptive curve subdivision. */
export function curveSegments(chordPx: number): number {
  const n = Math.ceil(chordPx / 2);
  return n < CURVE_MIN_SEGMENTS ? CURVE_MIN_SEGMENTS : n > CURVE_MAX_SEGMENTS ? CURVE_MAX_SEGMENTS : n;
}

/** Catmull-Rom control point 1 for the segment leaving index `i`, on one axis;
 *  neighbour indices are clamped to bounds. */
export function cp1(p: Float32Array, i: number, last: number): number {
  const prev = i - 1 < 0 ? 0 : i - 1;
  const next = i + 1 > last ? last : i + 1;
  return p[i]! + (p[next]! - p[prev]!) / CURVE_TENSION;
}
/** Catmull-Rom control point 2 for the segment arriving at index `i+1`. */
export function cp2(p: Float32Array, i: number, last: number): number {
  const after = i + 2 > last ? last : i + 2;
  const next = i + 1 > last ? last : i + 1;
  return p[next]! - (p[after]! - p[i]!) / CURVE_TENSION;
}

export function bezier(p0: number, c1: number, c2: number, p3: number, t: number): number {
  const u = 1 - t;
  return u * u * u * p0 + 3 * u * u * t * c1 + 3 * u * t * t * c2 + t * t * t * p3;
}

export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

/** Distance (media px) to the Curved segment leaving index `i`, flattened exactly as
 *  emit drew it. */
export function distToCurveSegment(
  xs: Float32Array,
  ys: Float32Array,
  i: number,
  last: number,
  hr: number,
  vr: number,
  px: number,
  py: number,
): number {
  const ax = xs[i]!;
  const ay = ys[i]!;
  const bx = xs[i + 1]!;
  const by = ys[i + 1]!;
  const c1x = cp1(xs, i, last);
  const c1y = cp1(ys, i, last);
  const c2x = cp2(xs, i, last);
  const c2y = cp2(ys, i, last);
  const chordPx = Math.hypot((bx - ax) * hr, (by - ay) * vr);
  const segs = curveSegments(chordPx);
  let best = Number.POSITIVE_INFINITY;
  let prevX = ax;
  let prevY = ay;
  for (let s = 1; s <= segs; s++) {
    const t = s / segs;
    const cx = bezier(ax, c1x, c2x, bx, t);
    const cy = bezier(ay, c1y, c2y, by, t);
    const d = distToSegment(px, py, prevX, prevY, cx, cy);
    if (d < best) best = d;
    prevX = cx;
    prevY = cy;
  }
  return best;
}

export type ColorAt = (i: number) => string;

/**
 * Walk the visible items `[from, to)` into polyline vertices per the line type, with
 * per-vertex colour. `vertex`/`gap` receive device-px coordinates. A single visible
 * point becomes a horizontal stub one bar wide, centred.
 */
export function walkLine(
  xs: Float32Array,
  ys: Float32Array,
  colorAt: ColorAt,
  from: number,
  to: number,
  hr: number,
  vr: number,
  barSpacing: number,
  type: LineType,
  vertex: (x: number, y: number, fill: string) => void,
  gap: () => void,
): void {
  const count = to - from;
  if (count === 1) {
    const i = from;
    const yi = ys[i]!;
    if (Number.isNaN(yi)) return;
    const fill = colorAt(i);
    const cx = xs[i]! * hr;
    const cy = yi * vr;
    const half = (barSpacing / 2) * hr;
    vertex(cx - half, cy, fill);
    vertex(cx + half, cy, fill);
    return;
  }
  const last = to - 1;
  let penDown = false;
  for (let i = from; i < to; i++) {
    const yi = ys[i]!;
    if (Number.isNaN(yi)) {
      if (penDown) {
        gap();
        penDown = false;
      }
      continue;
    }
    const fill = colorAt(i);
    const cx = xs[i]! * hr;
    const cy = yi * vr;
    if (!penDown) {
      vertex(cx, cy, fill);
      penDown = true;
      continue;
    }
    const prevY = ys[i - 1]!;
    const prevX = xs[i - 1]!;
    const prevColor = colorAt(i - 1);
    if (type === LineType.WithSteps && !Number.isNaN(prevY)) {
      // The riser corner carries the NEW colour: the horizontal draws the old
      // colour, the riser the new one.
      vertex(cx, prevY * vr, fill);
      vertex(cx, cy, fill);
    } else if (type === LineType.Curved && !Number.isNaN(prevY)) {
      // Intermediate vertices carry prev's colour; the endpoint carries cur's.
      const c1x = cp1(xs, i - 1, last);
      const c1y = cp1(ys, i - 1, last);
      const c2x = cp2(xs, i - 1, last);
      const c2y = cp2(ys, i - 1, last);
      const chordPx = Math.hypot((xs[i]! - prevX) * hr, (yi - prevY) * vr);
      const segs = curveSegments(chordPx);
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        vertex(bezier(prevX, c1x, c2x, xs[i]!, t) * hr, bezier(prevY, c1y, c2y, yi, t) * vr, prevColor);
      }
      vertex(cx, cy, fill);
    } else {
      vertex(cx, cy, fill); // Simple, or a step/curve right after a gap
    }
  }
}

/** Point-marker circles, drawn back-to-front so left points overdraw. x is rounded
 *  with the tickWidth-parity correction; y/r are unrounded ×vr. */
export function emitMarkers(
  circ: CirclesWriter,
  xs: Float32Array,
  ys: Float32Array,
  colorAt: ColorAt,
  from: number,
  to: number,
  hr: number,
  vr: number,
  radius: number,
): void {
  for (let i = to - 1; i >= from; i--) {
    const y = ys[i]!;
    if (Number.isNaN(y)) continue;
    const tickWidth = Math.max(1, Math.floor(hr));
    const correction = (tickWidth % 2) / 2;
    circ.circle(Math.round(xs[i]! * hr) + correction, y * vr, radius * vr + correction, colorAt(i));
  }
}

/** Media px throughout. */
export interface LineHitParams {
  readonly type: LineType;
  /** lineWidth/2 if the line is visible, else 0.5 (treated as width 1). */
  readonly lineHalf: number;
  /** Undefined when markers are hidden. */
  readonly markerRadius: number | undefined;
  readonly tolerance: number;
  readonly barSpacing: number;
  /** hr/vr captured at the last convert, so the curve flatten matches emit's. */
  readonly hr: number;
  readonly vr: number;
}

/**
 * Line-based hit test over `[from, to)` in media px: point markers (Point priority)
 * beat the line, then the single-point stub (Point), then segment distance (Line).
 */
export function hitTestLine(
  xs: Float32Array,
  ys: Float32Array,
  from: number,
  to: number,
  px: number,
  py: number,
  p: LineHitParams,
): HitCandidate | null {
  const count = to - from;
  if (count === 0) return null;
  const r = p.markerRadius;
  const radius = Math.max(p.lineHalf, r ?? 0) + p.tolerance;
  const last = to - 1;

  if (r !== undefined) {
    let best = Number.POSITIVE_INFINITY;
    const lo = lowerBound(xs, px - radius, (a, v) => (a as number) < (v as number), from, to);
    for (let i = lo; i < to; i++) {
      const ix = xs[i]!;
      if (ix > px + radius) break;
      const iy = ys[i]!;
      if (Number.isNaN(iy)) continue;
      const dx = px - ix;
      const dy = py - iy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= r + p.tolerance && d < best) best = d;
    }
    if (best !== Number.POSITIVE_INFINITY) return { distance: best, priority: HitPriority.Point };
  }

  // single visible point: horizontal stub of half-width max(barSpacing/2, radius)
  if (count === 1) {
    const ix = xs[from]!;
    const iy = ys[from]!;
    if (Number.isNaN(iy)) return null;
    const half = Math.max(p.barSpacing / 2, radius);
    if (px >= ix - half && px <= ix + half && Math.abs(py - iy) <= radius) {
      return { distance: Math.abs(py - iy), priority: HitPriority.Point };
    }
    return null;
  }

  let best = Number.POSITIVE_INFINITY;
  const searchHalf = radius + p.barSpacing; // a curve can bow out by its control polygon
  const lo = lowerBound(xs, px - searchHalf, (a, v) => (a as number) < (v as number), from, to);
  for (let i = lo > from ? lo - 1 : from; i < last; i++) {
    const ax = xs[i]!;
    if (ax - searchHalf > px) break;
    const ay = ys[i]!;
    const bx = xs[i + 1]!;
    const by = ys[i + 1]!;
    if (Number.isNaN(ay) || Number.isNaN(by)) continue;
    let d: number;
    if (p.type === LineType.WithSteps) {
      const dh = distToSegment(px, py, ax, ay, bx, ay);
      const dv = distToSegment(px, py, bx, ay, bx, by);
      d = dh < dv ? dh : dv;
    } else if (p.type === LineType.Curved) {
      d = distToCurveSegment(xs, ys, i, last, p.hr, p.vr, px, py);
    } else {
      d = distToSegment(px, py, ax, ay, bx, by);
    }
    if (d < best) best = d;
  }
  if (best <= radius) return { distance: best, priority: HitPriority.Line };
  return null;
}
