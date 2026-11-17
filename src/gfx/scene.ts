// The z-band scene model shared by series, grid, crosshair, primitives and tools.
import type { Coordinate } from '../core';
import type { FrameInfo } from './backend';
import type { DisplayList } from './commands';
import type { HitCandidate } from './hit';

// Bands 0-5 are the base layer; 6-8 the overlay layer.
export const ZBand = {
  Background: 0,
  Grid: 1,
  BelowSeries: 2,
  Series: 3,
  AboveSeries: 4,
  Labels: 5,
  Crosshair: 6,
  OverlayLabels: 7,
  Cursor: 8,
} as const;
export type ZBand = (typeof ZBand)[keyof typeof ZBand];

export interface ViewFrame {
  readonly frame: FrameInfo;
  readonly now: number; // frame timestamp, drives animations
}

export interface SceneSource {
  readonly zBand: ZBand; // one band per source; an owner registers several sources
  update(frame: ViewFrame): void; // make-valid; cheap when not dirty
  displayLists(): readonly DisplayList[]; // CACHED until dirtied; drawn in array order
  hitTest?(x: Coordinate, y: Coordinate, frame: ViewFrame): HitCandidate | null;
}
