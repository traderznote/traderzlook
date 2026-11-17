// The draw-command vocabulary: plain data from views to backends. Bitmap lists carry
// crisp device px; media lists carry CSS px the backend scales by (hr, vr).
import type { Disposable, Rect, Size } from '../core';

export type { Rect };

export type Space = 'media' | 'bitmap';

export interface DisplayList {
  readonly space: Space;
  readonly clip?: Rect; // ALWAYS media px, even for bitmap lists
  readonly commands: readonly DrawCommand[];
}

export type FillStyle = string /* CSS color */ | LinearGradientY;

export interface LinearGradientY {
  readonly from: number; // from/to: y in LIST space
  readonly to: number;
  // offset ∈ [0,1] ascending; two stops at one offset = hard split.
  readonly stops: readonly { readonly offset: number; readonly color: string }[];
}

export interface StyleRun {
  readonly count: number;
  readonly fill: FillStyle;
}

// Const-objects + unions instead of enums (erasableSyntaxOnly forbids enums).
export const LineStyle = {
  Solid: 0,
  Dotted: 1,
  Dashed: 2,
  LargeDashed: 3,
  SparseDotted: 4,
} as const;
export type LineStyle = (typeof LineStyle)[keyof typeof LineStyle];

export function dashPattern(style: LineStyle, w: number): number[] {
  switch (style) {
    case LineStyle.Dotted:
      return [w, w];
    case LineStyle.Dashed:
      return [2 * w, 2 * w];
    case LineStyle.LargeDashed:
      return [6 * w, 6 * w];
    case LineStyle.SparseDotted:
      return [w, 4 * w];
    default:
      return []; // Solid
  }
}

export interface FontSpec {
  readonly family: string;
  readonly size: number; // CSS px (media)
  readonly weight?: 'normal' | 'bold' | number;
  readonly style?: 'normal' | 'italic';
}

export interface StrokeSpec {
  readonly width: number; // list-space units
  readonly color: FillStyle;
  readonly style?: LineStyle; // default Solid
}

export const PathVerb = {
  Move: 0,
  Line: 1,
  Close: 2,
} as const;
export type PathVerb = (typeof PathVerb)[keyof typeof PathVerb];

// Defined here, not in backend.ts, so ImageCommand can carry it without an import
// cycle; only the backend constructs one.
export interface ImageHandle extends Disposable {
  readonly size: Size;
}

export interface TextItem {
  readonly x: number; // media px; LEFT edge of the run
  readonly y: number; // media px; alphabetic BASELINE
  readonly text: string;
  readonly font: FontSpec;
  readonly color: string;
}

export interface RectsCommand {
  readonly kind: 'rects';
  readonly coords: Float32Array; // x,y,w,h quads; length = 4·N; w,h ≥ 0
  readonly runs: readonly StyleRun[]; // Σ count = N
  readonly radius?: number; // applies to all quads
  readonly stroke?: StrokeSpec; // all quads, drawn after fills
}

export interface PolylineCommand {
  readonly kind: 'polyline';
  readonly points: Float32Array; // x,y pairs; (NaN, NaN) = pen-up gap
  readonly runs: readonly StyleRun[]; // Σ count = vertex count (incl. gaps)
  readonly width: number;
  readonly style: LineStyle;
  readonly join: 'round' | 'miter'; // cap is always 'butt'
}

export interface AreaCommand {
  readonly kind: 'area';
  readonly points: Float32Array; // top-edge polyline; NaN pair = gap
  readonly baseY: number; // list-space y the polygon closes to
  readonly fill: FillStyle;
}

export interface CirclesCommand {
  readonly kind: 'circles';
  readonly coords: Float32Array; // x,y,r triples; length = 3·N
  readonly runs: readonly StyleRun[]; // Σ count = N; EMPTY runs = no fill
  readonly stroke?: StrokeSpec; // all circles, drawn after fills
}

export interface PathCommand {
  readonly kind: 'path';
  readonly verbs: Uint8Array;
  readonly points: Float32Array; // x,y pairs consumed by Move/Line
  readonly fill?: FillStyle; // nonzero winding
  readonly stroke?: StrokeSpec;
}

export interface TextCommand {
  readonly kind: 'text';
  readonly items: readonly TextItem[];
}

export interface ImageCommand {
  readonly kind: 'image';
  readonly image: ImageHandle;
  readonly src: Rect; // image px
  readonly dst: Rect; // LIST space
  readonly alpha?: number; // 0..1, default 1
}

export type DrawCommand =
  | RectsCommand
  | PolylineCommand
  | AreaCommand
  | CirclesCommand
  | PathCommand
  | TextCommand
  | ImageCommand;
