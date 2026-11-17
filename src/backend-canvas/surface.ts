// ISurface over two stacked canvases (base below, overlay above). Only a 'full' frame
// applies bitmap resizes, so an overlay frame can never destroy base pixels.
import { assert } from '../core';
import type { ISubscription, Size } from '../core';
import { Emitter } from '../core';
import type { DisplayList, FrameInfo, FrameScope, LayerId, SurfaceSnapshot } from '../gfx';
import type { CanvasBinding } from './binding';
import { GradientCache } from './gradient';
import { makeSurfaceSnapshot } from './image';
import { replayLists } from './replay';

export interface CanvasSurfaceDeps {
  baseCanvas: HTMLCanvasElement;
  overlayCanvas: HTMLCanvasElement;
  baseBinding: CanvasBinding;
  overlayBinding: CanvasBinding;
  createCanvas: () => HTMLCanvasElement;
  colorSpace: PredefinedColorSpace;
  onDispose?: () => void;
}

export class CanvasSurface {
  readonly #deps: CanvasSurfaceDeps;
  readonly #resolutionChanged = new Emitter();
  readonly #baseCache = new GradientCache();
  readonly #overlayCache = new GradientCache();

  #mediaSize: Size = { width: 0, height: 0 };
  #bitmapSize: Size = { width: 0, height: 0 };
  #scope: FrameScope | undefined; // set between beginFrame and endFrame

  constructor(deps: CanvasSurfaceDeps) {
    this.#deps = deps;
    deps.baseBinding.resolutionChanged.subscribe(() => this.#resolutionChanged.fire(), { owner: this });
    deps.overlayBinding.resolutionChanged.subscribe(() => this.#resolutionChanged.fire(), { owner: this });
  }

  get resolutionChanged(): ISubscription {
    return this.#resolutionChanged;
  }

  setMediaSize(size: Size): void {
    this.#mediaSize = { width: size.width, height: size.height };
    this.#deps.baseBinding.setMediaSize(size);
    this.#deps.overlayBinding.setMediaSize(size);
  }

  beginFrame(scope: FrameScope): FrameInfo {
    this.#scope = scope;
    if (scope === 'full') {
      // The only place destructive resizes happen. Both canvases share one size; base
      // is authoritative.
      this.#bitmapSize = this.#deps.baseBinding.applySuggested();
      this.#deps.overlayBinding.applySuggested();
    }
    const m = this.#mediaSize;
    const b = this.#bitmapSize;
    // Degenerate axis: bitmap/media would be 0/0 = NaN, so pin the ratio to 1.
    const hr = m.width === 0 ? 1 : b.width / m.width;
    const vr = m.height === 0 ? 1 : b.height / m.height;
    return { mediaSize: { ...m }, bitmapSize: { ...b }, hr, vr };
  }

  renderLayer(layer: LayerId, lists: readonly DisplayList[]): void {
    if (layer === 'base' && this.#scope === 'overlay') {
      assert(false, "renderLayer('base') is illegal inside beginFrame('overlay')");
      return; // no-op in prod
    }
    if (this.#isDegenerate()) return; // drawing on a 0-size canvas can throw
    const canvas = layer === 'base' ? this.#deps.baseCanvas : this.#deps.overlayCanvas;
    const cache = layer === 'base' ? this.#baseCache : this.#overlayCache;
    const ctx = canvas.getContext('2d', { colorSpace: this.#deps.colorSpace });
    if (ctx === null) return;
    const m = this.#mediaSize;
    const b = this.#bitmapSize;
    const hr = m.width === 0 ? 1 : b.width / m.width;
    const vr = m.height === 0 ? 1 : b.height / m.height;
    replayLists(ctx, lists, b.width, b.height, hr, vr, cache);
  }

  endFrame(): void {
    this.#scope = undefined;
  }

  snapshot(): SurfaceSnapshot {
    return makeSurfaceSnapshot(
      this.#deps.baseCanvas,
      this.#deps.overlayCanvas,
      { ...this.#bitmapSize },
      this.#deps.createCanvas,
    );
  }

  dispose(): void {
    this.#resolutionChanged.dispose();
    this.#deps.baseBinding.dispose();
    this.#deps.overlayBinding.dispose();
    this.#deps.onDispose?.();
  }

  #isDegenerate(): boolean {
    return (
      this.#mediaSize.width === 0 ||
      this.#mediaSize.height === 0 ||
      this.#bitmapSize.width === 0 ||
      this.#bitmapSize.height === 0
    );
  }
}
