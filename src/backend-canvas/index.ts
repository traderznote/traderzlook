// Canvas 2D render backend: the only module that touches a CanvasRenderingContext2D.
// Imports core + gfx only (never model/views/data).
import type { Size } from '../core';
import type {
  ImageHandle,
  IRenderBackend,
  ISurface,
  Snapshot,
  SnapshotTile,
  ITextMeasurer,
} from '../gfx';
import { CanvasBinding } from './binding';
import { composeSnapshot, createCanvasImage } from './image';
import { devicePixelRatio, makeBitmapObserver } from './observer';
import { CanvasSurface } from './surface';
import { CanvasTextMeasurer } from './text';

export interface CanvasBackendOptions {
  colorSpace?: PredefinedColorSpace; // default 'srgb'
}

/** The DOM dependencies, injectable so the factory is testable headless. */
export interface BackendEnv {
  createCanvas(): HTMLCanvasElement;
  makeObserver(canvas: HTMLCanvasElement): import('./binding').BitmapObserver;
  getDpr(): number;
}

const domEnv: BackendEnv = {
  createCanvas: () => document.createElement('canvas'),
  makeObserver: makeBitmapObserver,
  getDpr: devicePixelRatio,
};

function styleLayer(canvas: HTMLCanvasElement, zIndex: number): void {
  const s = canvas.style;
  s.position = 'absolute';
  s.left = '0';
  s.top = '0';
  s.zIndex = String(zIndex);
  s.pointerEvents = 'none'; // input goes to the host's mount element
}

export function makeBackend(env: BackendEnv, options?: CanvasBackendOptions): IRenderBackend<HTMLElement, CanvasImageSource> {
  const colorSpace: PredefinedColorSpace = options?.colorSpace ?? 'srgb';

  const measureCanvas = env.createCanvas();
  const measureCtx = measureCanvas.getContext('2d', { colorSpace });
  // measureCtx is non-null on every real engine; the cast keeps headless mocks happy.
  const text: ITextMeasurer = new CanvasTextMeasurer(measureCtx as CanvasRenderingContext2D);

  function createSurface(mount: HTMLElement): ISurface {
    const baseCanvas = env.createCanvas();
    const overlayCanvas = env.createCanvas();
    styleLayer(baseCanvas, 1);
    styleLayer(overlayCanvas, 2);
    mount.appendChild(baseCanvas);
    mount.appendChild(overlayCanvas);

    const baseBinding = new CanvasBinding(baseCanvas, env.makeObserver(baseCanvas), env.getDpr, () => {
      const r = baseCanvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });
    const overlayBinding = new CanvasBinding(overlayCanvas, env.makeObserver(overlayCanvas), env.getDpr, () => {
      const r = overlayCanvas.getBoundingClientRect();
      return { left: r.left, top: r.top, width: r.width, height: r.height };
    });

    return new CanvasSurface({
      baseCanvas,
      overlayCanvas,
      baseBinding,
      overlayBinding,
      createCanvas: env.createCanvas,
      colorSpace,
      onDispose: () => {
        baseCanvas.remove();
        overlayCanvas.remove();
      },
    });
  }

  function createImage(source: CanvasImageSource): ImageHandle {
    return createCanvasImage(source);
  }

  // `includeCrosshair` is an optional extra beyond the IRenderBackend signature;
  // callers that omit it get the crosshair included.
  function snapshot(tiles: readonly SnapshotTile[], mediaSize: Size, includeCrosshair?: boolean): Snapshot {
    return composeSnapshot(tiles, mediaSize, env.getDpr(), env.createCanvas, includeCrosshair);
  }

  return {
    createSurface,
    createImage,
    composeSnapshot: snapshot,
    text,
    dispose: () => {
      // Release the measuring canvas's memory (iOS canvas-memory cap).
      measureCanvas.width = 1;
      measureCanvas.height = 1;
    },
  };
}

export function canvasBackend(options?: CanvasBackendOptions): IRenderBackend<HTMLElement, CanvasImageSource> {
  return makeBackend(domEnv, options);
}
