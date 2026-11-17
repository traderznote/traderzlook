// SeriesKind<Item>: the view-side half of a series definition (`{ contract, kind }`),
// re-exported publicly by `api` as the custom-series seam.
import type { Coordinate } from '../../core';
import type { PlotStoreView, StoreDiff } from '../../data';
import type { HorzGeometry, PriceConverter } from '../../model';
import type { DisplayListBuilder, HitCandidate, ViewFrame } from '../../gfx';
import type { ItemBuffer } from './buffer';
import type { ItemWindow } from './window';

export interface SeriesKind<Item> {
  /** Patch the `ItemBuffer` in place from the store + diff. Skipped on the decimated path. */
  itemsFromStore(store: PlotStoreView, diff: StoreDiff, items: ItemBuffer<Item>): void;

  /** Fill the buffer's `x`/`y`/`extra` lanes for the visible `window`: rows → X via
   *  `horz`, values → media-px Y via `price`. Skipped on the decimated path. */
  convert(
    items: ItemBuffer<Item>,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
  ): void;

  /** Emit display lists from the converted lanes. Skipped on the decimated path. */
  emit(items: ItemBuffer<Item>, window: ItemWindow, frame: ViewFrame, out: DisplayListBuilder): void;

  /**
   * Replaces `convert`+`emit` when bar spacing is sub-pixel (`barSpacing · hr < 1`):
   * reads the store lanes directly and writes one min/max segment per device-pixel
   * column. The `ItemBuffer` is not filled on this path, so `hitTest` returns null.
   * Built-in kinds delegate to `decimateColumns`.
   */
  decimate(
    store: PlotStoreView,
    window: ItemWindow,
    frame: ViewFrame,
    horz: HorzGeometry,
    price: PriceConverter,
    out: DisplayListBuilder,
  ): void;

  /** Hit-test over the same converted coordinates `emit` drew. Null when the buffer
   *  is unfilled (decimated path) or nothing is under the cursor. */
  hitTest(items: ItemBuffer<Item>, x: Coordinate, y: Coordinate): HitCandidate | null;

  /** Whether the engine must widen the window by ±1 neighbour (line-likes need the
   *  off-screen segment endpoints; bar-likes do not). */
  readonly extendedRange: boolean;
}
