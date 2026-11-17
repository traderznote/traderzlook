// Event payloads + the subscription hub. Payloads are built lazily, only when someone
// listens (crosshair-move fires at 60 Hz).
import { Emitter } from '../core';
import type { Coordinate, Logical, TimeIndex, Unsubscribe } from '../core';
import type { HoverTarget } from '../model';
import type { StoreDiff as InternalStoreDiff } from '../data';

// `S` is the user's series-handle type; payloads stay handle-agnostic.

/** The hovered source. There is deliberately no `'marker'` kind: markers are primitives
 *  and report `'primitive'` with their marker id as `externalId`. */
export interface HoverInfo<S = unknown> {
  readonly kind: 'series' | 'price-line' | 'primitive';
  /** The owning series handle (series / series-attached price-line). */
  readonly series?: S;
  /** `HitCandidate.externalId` for a primitive, or the price-line id. */
  readonly externalId?: string;
  readonly paneIndex: number;
}

/** Sanitized pointer data (no native event leaks). All coordinates are media px. */
export interface PointerEventData {
  readonly clientX: Coordinate;
  readonly clientY: Coordinate;
  readonly pageX: Coordinate;
  readonly pageY: Coordinate;
  readonly screenX: Coordinate;
  readonly screenY: Coordinate;
  readonly localX: Coordinate;
  readonly localY: Coordinate;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly metaKey: boolean;
  readonly pointerType: 'mouse' | 'touch' | 'pen';
}

/** The click / dblClick / crosshairMove payload. `time` is the user's original value
 *  (undefined outside data); `logical` is undefined off-scale; `point` is undefined
 *  outside the chart (e.g. on leave). `seriesData` excludes whitespace rows. */
export interface MouseEventParams<H = unknown, S = unknown, Item = unknown> {
  readonly time?: H;
  readonly logical?: Logical;
  readonly point?: { x: Coordinate; y: Coordinate };
  readonly paneIndex?: number;
  readonly seriesData: Map<S, Item>;
  readonly hoveredInfo?: HoverInfo<S>;
  readonly sourceEvent?: PointerEventData;
}

export type MouseEventHandler<H = unknown, S = unknown, Item = unknown> = (
  param: MouseEventParams<H, S, Item>,
) => void;

export interface SeriesDataCandidate<S, Item> {
  readonly series: S;
  /** The item at the hovered slot; null/undefined (whitespace, no data) is skipped. */
  readonly item: Item | null | undefined;
}

/** One entry per series with a non-whitespace item, in the caller's (pane/series) order. */
export function buildSeriesData<S, Item>(
  candidates: readonly SeriesDataCandidate<S, Item>[],
): Map<S, Item> {
  const map = new Map<S, Item>();
  for (const c of candidates) {
    if (c.item !== null && c.item !== undefined) map.set(c.series, c.item);
  }
  return map;
}

export interface HoverOwnership<S> {
  readonly kind: 'series' | 'price-line' | 'primitive';
  readonly series?: S;
}

/** Null when the source is not one of the library's own (no `hoveredInfo` is reported). */
export type HoverResolver<S> = (sourceId: string) => HoverOwnership<S> | null;

/** `externalId` is omitted when absent so equality stays clean; null for unknown sources. */
export function buildHoverInfo<S>(
  target: HoverTarget,
  paneIndex: number,
  resolve: HoverResolver<S>,
): HoverInfo<S> | null {
  const owner = resolve(target.sourceId);
  if (owner === null) return null;
  const info: { -readonly [K in keyof HoverInfo<S>]: HoverInfo<S>[K] } = {
    kind: owner.kind,
    paneIndex,
  };
  if (owner.series !== undefined) info.series = owner.series;
  if (target.externalId !== undefined) info.externalId = target.externalId;
  return info;
}

/** The public series-data diff: the internal diff with its `TimeIndex` slots surfaced as
 *  `Logical` (same numbers; `TimeIndex` is not public). */
export type StoreDiff =
  | { kind: 'replace' }
  | { kind: 'append'; count: number }
  | { kind: 'updateLast' }
  | { kind: 'insert'; atSlot: Logical }
  | { kind: 'reindex'; fromSlot: Logical };

/** Slot-carrying variants get a fresh object so the payload never aliases internal state. */
export function surfaceStoreDiff(diff: InternalStoreDiff): StoreDiff {
  switch (diff.kind) {
    case 'insert':
      return { kind: 'insert', atSlot: (diff.atSlot as number) as Logical };
    case 'reindex':
      return { kind: 'reindex', fromSlot: (diff.fromSlot as number) as Logical };
    default:
      return diff;
  }
}

/**
 * One event channel. `subscribe(h)` returns an `Unsubscribe`, and `unsubscribe(h)` removes
 * the same registration by handler reference. A throwing listener does not stop dispatch.
 */
export class EventHub<A extends unknown[]> {
  readonly #emitter = new Emitter<A>();
  // The Emitter compares by listener identity, so map handler → its unsubscribe.
  readonly #offs = new Map<(...args: A) => void, Unsubscribe>();

  /** Re-subscribing the same handler: the latest registration wins for `unsubscribe(handler)`. */
  subscribe(handler: (...args: A) => void): Unsubscribe {
    const off = this.#emitter.subscribe(handler);
    this.#offs.set(handler, off);
    const unsub: Unsubscribe = () => {
      off();
      if (this.#offs.get(handler) === off) this.#offs.delete(handler);
    };
    return unsub;
  }

  /** No-op if the handler was never subscribed or already removed. */
  unsubscribe(handler: (...args: A) => void): void {
    const off = this.#offs.get(handler);
    if (off !== undefined) {
      off();
      this.#offs.delete(handler);
    }
  }

  hasListeners(): boolean {
    return this.#emitter.hasListeners();
  }

  /** `build` runs only when there are listeners. */
  emit(build: () => A): void {
    this.#emitter.fireLazy(build);
  }

  dispose(): void {
    this.#emitter.dispose();
    this.#offs.clear();
  }
}

export type { TimeIndex };
