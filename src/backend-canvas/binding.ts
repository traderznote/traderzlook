// Per-canvas bitmap sizing. A discovered size is only stored as a suggestion; the
// content-destroying canvas.width/height write happens in applySuggested.
import type { ISubscription, Size } from '../core';
import { Emitter } from '../core';

export interface ClientRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** `reprediction`: setMediaSize must re-predict the bitmap itself (matchMedia fallback). */
export interface BitmapObserver {
  readonly reprediction: boolean;
  start(onDiscovered: (bitmapW: number, bitmapH: number) => void): void;
  dispose(): void;
}

/**
 * Predict the rasterized bitmap size: snap both physical edges to the pixel grid and
 * take the difference, as the browser does for CSS edges between physical pixels.
 */
export function predictBitmapSize(rect: ClientRect, dpr: number): Size {
  const width = Math.round(rect.left * dpr + rect.width * dpr) - Math.round(rect.left * dpr);
  const height = Math.round(rect.top * dpr + rect.height * dpr) - Math.round(rect.top * dpr);
  return { width, height };
}

export class CanvasBinding {
  readonly #canvas: HTMLCanvasElement;
  readonly #observer: BitmapObserver;
  readonly #getDpr: () => number;
  readonly #getClientRect: (() => ClientRect) | undefined;
  readonly #resolutionChanged = new Emitter();

  #clientSize: Size = { width: 0, height: 0 };
  #bitmapSize: Size = { width: 0, height: 0 };
  #suggested: Size | undefined;

  constructor(
    canvas: HTMLCanvasElement,
    observer: BitmapObserver,
    getDpr: () => number = () => 1,
    getClientRect?: () => ClientRect,
  ) {
    this.#canvas = canvas;
    this.#observer = observer;
    this.#getDpr = getDpr;
    this.#getClientRect = getClientRect;
    this.#observer.start((w, h) => this.#discover(w, h));
  }

  get resolutionChanged(): ISubscription {
    return this.#resolutionChanged;
  }

  get bitmapSize(): Size {
    return this.#bitmapSize;
  }

  get suggestedBitmapSize(): Size | undefined {
    return this.#suggested;
  }

  setMediaSize(size: Size): void {
    this.#clientSize = { width: size.width, height: size.height };
    this.#canvas.style.width = `${size.width}px`;
    this.#canvas.style.height = `${size.height}px`;
    // A pure CSS resize at the same DPR never fires matchMedia, so re-derive here.
    if (this.#observer.reprediction) {
      const rect = this.#getClientRect ? this.#getClientRect() : { left: 0, top: 0, ...size };
      const p = predictBitmapSize(rect, this.#getDpr());
      this.#discover(p.width, p.height);
    }
  }

  #discover(rawW: number, rawH: number): void {
    // Clamp to ≥ client size (guards sub-1 DPR and transient zero sizes).
    const final: Size = {
      width: Math.max(rawW, this.#clientSize.width),
      height: Math.max(rawH, this.#clientSize.height),
    };
    const target = this.#suggested ?? this.#bitmapSize;
    if (final.width === target.width && final.height === target.height) return;
    if (final.width === this.#bitmapSize.width && final.height === this.#bitmapSize.height) {
      this.#suggested = undefined;
      return;
    }
    this.#suggested = final;
    this.#resolutionChanged.fire();
  }

  /** Content-destroying; called only from beginFrame('full'). */
  applySuggested(): Size {
    const s = this.#suggested;
    if (s === undefined) return this.#bitmapSize;
    this.#suggested = undefined;
    if (s.width !== this.#bitmapSize.width || s.height !== this.#bitmapSize.height) {
      this.#canvas.width = s.width;
      this.#canvas.height = s.height;
      this.#bitmapSize = s;
    }
    return this.#bitmapSize;
  }

  dispose(): void {
    this.#observer.dispose();
    this.#resolutionChanged.dispose();
    // iOS Safari canvas-memory cap: shrink to 1×1 and clear before removal.
    this.#canvas.width = 1;
    this.#canvas.height = 1;
    const ctx = this.#canvas.getContext('2d');
    if (ctx !== null) ctx.clearRect(0, 0, 1, 1);
  }
}
