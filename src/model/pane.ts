import { mergeOptions, type DeepPartial } from '../core';
import { PriceNavigator } from './price-scale/navigator';
import { PriceScaleMode, isAutoScaleForced, type MinMax } from './price-scale/modes';
import { DEFAULT_PRICE_SCALE_OPTIONS, type PaneId, type PriceScaleOptions } from './shared';

/** Structural view of a series; the pane only needs identity + kind. */
export interface PaneSeries {
  kind(): string;
}

/** Price-scale state (options, drag navigator, mode). Geometry is built per frame elsewhere. */
export class PriceScale {
  readonly #id: string;
  readonly #defaults: PriceScaleOptions;
  #options: PriceScaleOptions;
  readonly #navigator: PriceNavigator;

  constructor(id: string, defaults: PriceScaleOptions) {
    this.#id = id;
    this.#defaults = defaults;
    this.#options = { ...defaults, scaleMargins: { ...defaults.scaleMargins } };
    this.#navigator = new PriceNavigator({
      range: null,
      autoScale: defaults.autoScale,
      mode: defaults.mode,
      inverted: defaults.invertScale,
      height: 0,
    });
  }

  id(): string {
    return this.#id;
  }

  /** A snapshot copy, never the live object. */
  options(): PriceScaleOptions {
    return { ...this.#options, scaleMargins: { ...this.#options.scaleMargins } };
  }

  /** Percentage / Indexed force autoScale on; the navigator mirrors mode + autoScale. */
  applyOptions(patch: DeepPartial<PriceScaleOptions>): void {
    this.#options = mergeOptions(this.#options, patch, this.#defaults);
    if (isAutoScaleForced(this.#options.mode)) {
      this.#options = { ...this.#options, autoScale: true };
    }
    this.#navigator.setMode(this.#options.mode);
    this.#navigator.setAutoScale(this.#options.autoScale);
  }

  mode(): PriceScaleMode {
    return this.#options.mode;
  }

  isAutoScale(): boolean {
    return this.#navigator.isAutoScale();
  }

  /** Logical-space range, or null on an empty/unset scale. */
  range(): MinMax | null {
    return this.#navigator.range();
  }

  setRange(range: MinMax | null): void {
    this.#navigator.setRange(range);
  }

  /** Sets the navigator flag directly, bypassing applyOptions. */
  setAutoScale(on: boolean): void {
    this.#navigator.setAutoScale(on);
  }

  setHeight(height: number): void {
    this.#navigator.setHeight(height);
  }

  navigator(): PriceNavigator {
    return this.#navigator;
  }
}

export class Pane {
  readonly #id: PaneId;
  #stretchFactor = 1;
  #preserveEmpty = false;
  readonly #scales = new Map<string, PriceScale>();
  readonly #series: PaneSeries[] = [];

  constructor(id: PaneId) {
    this.#id = id;
    this.#scales.set('right', new PriceScale('right', DEFAULT_PRICE_SCALE_OPTIONS.right));
    this.#scales.set('left', new PriceScale('left', DEFAULT_PRICE_SCALE_OPTIONS.left));
  }

  id(): PaneId {
    return this.#id;
  }

  stretchFactor(): number {
    return this.#stretchFactor;
  }
  setStretchFactor(f: number): void {
    this.#stretchFactor = f;
  }

  preserveEmptyPane(): boolean {
    return this.#preserveEmpty;
  }
  setPreserveEmptyPane(keep: boolean): void {
    this.#preserveEmpty = keep;
  }

  /** null on a miss; the api layer maps that to a ChartError. */
  priceScale(id: string): PriceScale | null {
    return this.#scales.get(id) ?? null;
  }

  /** Get or create an overlay scale for a non-left/right id. */
  ensureOverlayScale(id: string): PriceScale {
    const existing = this.#scales.get(id);
    if (existing !== undefined) return existing;
    // overlay scales always autoscale and never render an axis.
    const overlay = new PriceScale(id, { ...DEFAULT_PRICE_SCALE_OPTIONS.right, visible: false });
    this.#scales.set(id, overlay);
    return overlay;
  }

  /** Right, left, then overlays in insertion order. */
  priceScales(): readonly PriceScale[] {
    return [...this.#scales.values()];
  }

  series(): readonly PaneSeries[] {
    return this.#series.slice();
  }

  addSeries(series: PaneSeries): void {
    this.#series.push(series);
  }

  removeSeries(series: PaneSeries): void {
    const i = this.#series.indexOf(series);
    if (i >= 0) this.#series.splice(i, 1);
  }

  isEmpty(): boolean {
    return this.#series.length === 0;
  }
}
