// Typed deltas from the data layer: views patch geometry per diff kind instead of rebuilding.
import type { TimeIndex } from '../core';

export type StoreDiff =
  | { kind: 'replace' }
  | { kind: 'append'; count: number }
  | { kind: 'updateLast' }
  | { kind: 'reindex'; fromSlot: TimeIndex } // timeline shifted under the series
  | { kind: 'insert'; atSlot: TimeIndex };

export interface TimelineDiff {
  firstChanged: TimeIndex | null;
  baseIndex: TimeIndex | null;
}
