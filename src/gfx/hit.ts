// Canvas-free hit testing over the same coordinates sources emit. Arbitration: Point
// beats non-Point, then min distance; equal distance keeps source z-order.
import type { CursorStyle } from '../core';

export const HitPriority = {
  Range: 0,
  Line: 1,
  Point: 2,
} as const;
export type HitPriority = (typeof HitPriority)[keyof typeof HitPriority];

export interface HitCandidate {
  distance: number; // media px
  priority: HitPriority;
  cursor?: CursorStyle;
  externalId?: string;
  data?: unknown; // echoed to the source on hover/draw
}
