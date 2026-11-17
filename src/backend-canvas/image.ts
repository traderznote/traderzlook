// Image handles and screenshot composition.
import type { Size } from '../core';
import type { ImageHandle, Snapshot, SnapshotTile, SurfaceSnapshot } from '../gfx';

/** A CanvasImageSource lacks a uniform size accessor; probe the three shapes. */
export function naturalSize(source: CanvasImageSource): Size {
  const s = source as unknown as Record<string, number>;
  if (typeof s.naturalWidth === 'number') return { width: s.naturalWidth, height: s.naturalHeight };
  if (typeof s.videoWidth === 'number') return { width: s.videoWidth, height: s.videoHeight };
  return { width: s.width, height: s.height };
}

export interface CanvasImageHandle extends ImageHandle {
  readonly source: CanvasImageSource;
}

export function createCanvasImage(source: CanvasImageSource): CanvasImageHandle {
  let live: CanvasImageSource | undefined = source;
  const size = naturalSize(source);
  return {
    size,
    get source(): CanvasImageSource {
      return live as CanvasImageSource;
    },
    dispose(): void {
      live = undefined; // loading/decoding belongs to the caller; just drop the reference
    },
  };
}

/**
 * Detached copies of both layers, kept separate so composeSnapshot can leave out the
 * overlay (crosshair, cursor labels) per screenshot, and later frames can't corrupt them.
 */
export interface CanvasSurfaceSnapshot extends SurfaceSnapshot {
  readonly base: HTMLCanvasElement;
  readonly overlay: HTMLCanvasElement;
  readonly size: Size;
}

export function makeSurfaceSnapshot(
  base: HTMLCanvasElement,
  overlay: HTMLCanvasElement,
  bitmapSize: Size,
  createCanvas: () => HTMLCanvasElement,
): CanvasSurfaceSnapshot {
  const baseCopy = createCanvas();
  const overlayCopy = createCanvas();
  baseCopy.width = overlayCopy.width = bitmapSize.width;
  baseCopy.height = overlayCopy.height = bitmapSize.height;
  // drawImage of/into a 0×0 canvas throws in some browsers.
  if (bitmapSize.width > 0 && bitmapSize.height > 0) {
    copyLayer(baseCopy, base);
    copyLayer(overlayCopy, overlay);
  }
  return { base: baseCopy, overlay: overlayCopy, size: bitmapSize };
}

function copyLayer(dst: HTMLCanvasElement, src: HTMLCanvasElement): void {
  const ctx = dst.getContext('2d');
  if (ctx !== null) ctx.drawImage(src, 0, 0);
}

export interface CanvasSnapshot extends Snapshot {
  toCanvas(): HTMLCanvasElement;
  toBlob(type?: string, quality?: number): Promise<Blob | null>;
}

/**
 * Paints the tiles, already in paint order, onto one `mediaSize × dpr` canvas. Snapshot
 * tiles blit their base layer (plus overlay when `includeCrosshair`); fill tiles cover
 * the surface-less pane separators, which would otherwise be holes.
 */
export function composeSnapshot(
  tiles: readonly SnapshotTile[],
  mediaSize: Size,
  dpr: number,
  createCanvas: () => HTMLCanvasElement,
  includeCrosshair = true,
): CanvasSnapshot {
  const canvas = createCanvas();
  canvas.width = Math.round(mediaSize.width * dpr);
  canvas.height = Math.round(mediaSize.height * dpr);
  const ctx = canvas.getContext('2d');
  if (ctx !== null) {
    for (const tile of tiles) {
      const r = tile.rect;
      const dx = r.x * dpr;
      const dy = r.y * dpr;
      const dw = r.width * dpr;
      const dh = r.height * dpr;
      if ('fill' in tile) {
        ctx.fillStyle = tile.fill;
        ctx.fillRect(dx, dy, dw, dh);
      } else {
        const surf = tile.snapshot as CanvasSurfaceSnapshot;
        if (surf.size.width > 0 && surf.size.height > 0) {
          ctx.drawImage(surf.base, dx, dy, dw, dh);
          if (includeCrosshair) ctx.drawImage(surf.overlay, dx, dy, dw, dh);
        }
      }
    }
  }
  return {
    toCanvas: () => canvas,
    toBlob: (type?: string, quality?: number) =>
      new Promise<Blob | null>((resolve) => canvas.toBlob((b) => resolve(b), type, quality)),
  };
}
