// Branded numeric types (zero runtime cost) and shared geometry. Size, Rect and
// CursorStyle live in core so the headless model never has to import gfx.

declare const brand: unique symbol;
export type Brand<T, B extends string> = T & { readonly [brand]: B };

export type Coordinate = Brand<number, 'Coordinate'>; // media px
export type BitmapCoordinate = Brand<number, 'BitmapCoordinate'>; // device px
export type TimeIndex = Brand<number, 'TimeIndex'>; // slot on the union timeline
export type Logical = Brand<number, 'Logical'>; // fractional bar position
export type HorzKey = Brand<number, 'HorzKey'>; // behavior ordering key
export type BarPrice = Brand<number, 'BarPrice'>;

/** A CSS cursor keyword ('default' | 'pointer' | 'crosshair' | …). */
export type CursorStyle = string;

export interface Size {
  width: number;
  height: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
