// Browser BitmapObserver strategies, kept out of binding.ts so the binding can be
// tested headless with a fake observer.
import type { BitmapObserver, ClientRect } from './binding';

function supportsDevicePixelContentBox(): boolean {
  if (typeof ResizeObserver === 'undefined' || typeof ResizeObserverEntry === 'undefined') return false;
  // Absent on older WebKit, which then takes the matchMedia fallback.
  const proto = ResizeObserverEntry.prototype as object;
  return 'devicePixelContentBoxSize' in proto;
}

/** Preferred: reports exact device pixels, so no prediction is needed. */
class ResizeObserverStrategy implements BitmapObserver {
  readonly reprediction = false;
  readonly #canvas: HTMLCanvasElement;
  #ro: ResizeObserver | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  start(onDiscovered: (w: number, h: number) => void): void {
    this.#ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const box = entry.devicePixelContentBoxSize?.[0];
        if (box) onDiscovered(box.inlineSize, box.blockSize);
      }
    });
    this.#ro.observe(this.#canvas, { box: 'device-pixel-content-box' });
  }

  dispose(): void {
    this.#ro?.disconnect();
    this.#ro = undefined;
  }
}

/** Fallback: watches DPR via matchMedia and predicts the bitmap size from the CSS rect. */
class MatchMediaStrategy implements BitmapObserver {
  readonly reprediction = true;
  readonly #canvas: HTMLCanvasElement;
  #mql: MediaQueryList | undefined;
  #handler: (() => void) | undefined;
  #onDiscovered: ((w: number, h: number) => void) | undefined;

  constructor(canvas: HTMLCanvasElement) {
    this.#canvas = canvas;
  }

  start(onDiscovered: (w: number, h: number) => void): void {
    this.#onDiscovered = onDiscovered;
    this.#install();
    this.#predict();
  }

  #install(): void {
    const dpr = devicePixelRatio();
    this.#mql = matchMedia(`(resolution: ${dpr}dppx)`);
    this.#handler = () => {
      // matchMedia matches one resolution; reinstall with the new value after it fires.
      this.#teardownListener();
      this.#install();
      this.#predict();
    };
    this.#mql.addEventListener('change', this.#handler);
  }

  #predict(): void {
    const r = this.#canvas.getBoundingClientRect();
    const rect: ClientRect = { left: r.left, top: r.top, width: r.width, height: r.height };
    const dpr = devicePixelRatio();
    // Same edge-snapped formula as the binding, inlined to avoid an import cycle.
    const w = Math.round(rect.left * dpr + rect.width * dpr) - Math.round(rect.left * dpr);
    const h = Math.round(rect.top * dpr + rect.height * dpr) - Math.round(rect.top * dpr);
    this.#onDiscovered?.(w, h);
  }

  #teardownListener(): void {
    if (this.#mql && this.#handler) this.#mql.removeEventListener('change', this.#handler);
  }

  dispose(): void {
    this.#teardownListener();
    this.#mql = undefined;
    this.#handler = undefined;
  }
}

export function devicePixelRatio(): number {
  return typeof window !== 'undefined' && window.devicePixelRatio ? window.devicePixelRatio : 1;
}

export function makeBitmapObserver(canvas: HTMLCanvasElement): BitmapObserver {
  return supportsDevicePixelContentBox()
    ? new ResizeObserverStrategy(canvas)
    : new MatchMediaStrategy(canvas);
}
