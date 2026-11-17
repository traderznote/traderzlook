// Price-axis drag state (scale and scroll). Scale and scroll share one range snapshot,
// so a gesture in progress blocks the other from starting.
import { refusesManualScale, type MinMax, type PriceScaleMode } from './modes';

const SCALE_DAMPING = 0.2; // × height
const SCALE_COEFF_FLOOR = 0.1; // caps zoom-in at 10× per gesture; zoom-out unbounded

export interface PriceNavigatorInit {
  range: MinMax | null;
  autoScale: boolean;
  mode: PriceScaleMode;
  inverted: boolean;
  height: number; // internal band height h (margins already removed by the caller)
}

export class PriceNavigator {
  #range: MinMax | null;
  #autoScale: boolean;
  #mode: PriceScaleMode;
  #inverted: boolean;
  #height: number;
  #snapshot: MinMax | null = null;
  #scaleStart: number | null = null;
  #scrollStart: number | null = null;
  #scaledThisGesture = false;

  constructor(init: PriceNavigatorInit) {
    this.#range = init.range;
    this.#autoScale = init.autoScale;
    this.#mode = init.mode;
    this.#inverted = init.inverted;
    this.#height = init.height;
  }

  range(): MinMax | null {
    return this.#range;
  }
  isAutoScale(): boolean {
    return this.#autoScale;
  }
  setMode(mode: PriceScaleMode): void {
    this.#mode = mode;
  }
  setRange(range: MinMax | null): void {
    this.#range = range;
  }
  setAutoScale(on: boolean): void {
    this.#autoScale = on;
  }
  /** Internal band height h; the caller keeps it current as the pane resizes. */
  setHeight(height: number): void {
    this.#height = height;
  }

  startScale(y: number): void {
    if (refusesManualScale(this.#mode)) return; // percent/indexed have no absolute range
    if (this.#snapshot !== null || this.#scaleStart !== null) return;
    if (this.#range === null) return;
    this.#scaleStart = this.#height - y;
    this.#snapshot = { ...this.#range };
    this.#scaledThisGesture = false;
  }

  scaleTo(y: number): void {
    if (refusesManualScale(this.#mode)) return;
    if (this.#scaleStart === null || this.#snapshot === null) return;
    if (!this.#scaledThisGesture) {
      this.#autoScale = false;
      this.#scaledThisGesture = true;
    }
    const x = Math.max(0, this.#height - y);
    const damp = (this.#height - 1) * SCALE_DAMPING;
    let coeff = (this.#scaleStart + damp) / (x + damp);
    coeff = Math.max(coeff, SCALE_COEFF_FLOOR);
    const snap = this.#snapshot;
    const length = snap.max - snap.min;
    if (length === 0 || !Number.isFinite(coeff)) return;
    const center = (snap.min + snap.max) / 2;
    const half = (length / 2) * coeff;
    this.#range = { min: center - half, max: center + half };
  }

  endScale(): void {
    if (refusesManualScale(this.#mode)) return;
    this.#scaleStart = null;
    this.#snapshot = null;
    this.#scaledThisGesture = false;
  }

  // Scroll is a no-op while autoscale is on.
  startScroll(y: number): void {
    if (this.#autoScale) return;
    if (this.#snapshot !== null || this.#scrollStart !== null) return;
    if (this.#range === null) return;
    this.#scrollStart = y;
    this.#snapshot = { ...this.#range };
  }

  scrollTo(y: number): void {
    if (this.#autoScale) return;
    if (this.#scrollStart === null || this.#snapshot === null) return;
    const snap = this.#snapshot;
    const length = snap.max - snap.min;
    let shift = (y - this.#scrollStart) * (length / (this.#height - 1));
    if (this.#inverted) shift = -shift;
    // always a new object, even for an equal range, so dependent caches refresh.
    this.#range = { min: snap.min + shift, max: snap.max + shift };
  }

  endScroll(): void {
    if (this.#autoScale) return;
    this.#scrollStart = null;
    this.#snapshot = null;
  }
}
