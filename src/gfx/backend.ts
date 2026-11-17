// Renderer backend contract. Backends consume only the draw-command vocabulary and
// know nothing about chart semantics.
import type { ISubscription, Rect, Size } from '../core';
import type { DisplayList, ImageHandle } from './commands';
import type { ITextMeasurer } from './text-measure';

export type LayerId = 'base' | 'overlay';
export type FrameScope = 'overlay' | 'full';

export interface FrameInfo {
  mediaSize: Size;
  bitmapSize: Size;
  hr: number; // bitmap/media per axis; fractional and asymmetric are normal
  vr: number;
}

// Opaque backend handles — created by the backend, never inspected outside it.
export interface SurfaceSnapshot {
  readonly _tag?: 'SurfaceSnapshot';
}
export interface Snapshot {
  readonly _tag?: 'Snapshot';
}

// A surface snapshot, or a solid fill for surface-less DOM chrome (e.g. pane separators).
export type SnapshotTile = { rect: Rect } & ({ snapshot: SurfaceSnapshot } | { fill: string });

export interface ISurface {
  setMediaSize(size: Size): void; // CSS px; backend owns bitmap size
  beginFrame(scope: FrameScope): FrameInfo; // 'full' applies pending bitmap resize; 'overlay' never
  renderLayer(layer: LayerId, lists: readonly DisplayList[]): void; // replaces the layer
  endFrame(): void;
  readonly resolutionChanged: ISubscription; // DPR / sub-pixel bitmap change
  snapshot(): SurfaceSnapshot;
  dispose(): void;
}

export interface IRenderBackend<TMount = unknown, TImageSrc = unknown> {
  createSurface(mount: TMount): ISurface;
  createImage(source: TImageSrc): ImageHandle;
  composeSnapshot(tiles: readonly SnapshotTile[], mediaSize: Size): Snapshot;
  readonly text: ITextMeasurer;
  dispose(): void;
}
