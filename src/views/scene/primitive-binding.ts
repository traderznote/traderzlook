// Registers a tagged primitive `SceneSource` into the surface named by its own
// `target` tag ('pane' | 'price-axis' | 'time-axis'). Re-homing on a pane or scale
// change just recomputes the surface key; it never re-fires attached/detached.
import { assert } from '../../core';
import type { SceneSource, ZBand } from '../../gfx';

export type SurfaceKind = 'pane' | 'price-axis-left' | 'price-axis-right' | 'time-axis';

/** The model's `PrimitiveSource` with `source` narrowed from `unknown` to a gfx
 *  `SceneSource` (model may not name gfx types). */
export interface TaggedPrimitiveSource {
  readonly target: 'pane' | 'price-axis' | 'time-axis';
  readonly axis?: 'left' | 'right';
  readonly source: SceneSource;
}

/** Series-attached price-axis sources follow the series' current scale and render
 *  nowhere while it sits on an overlay scale. */
export interface OwnerPlacement {
  readonly paneId: string;
  /** Null when series-attached to an overlay scale. */
  readonly priceScaleId: string | null;
  /** Null when the owner's scale has no axis (overlay scale). */
  readonly axisSide: 'left' | 'right' | null;
}

export class PrimitiveBinding {
  readonly tagged: TaggedPrimitiveSource;
  #placement: OwnerPlacement;
  #surfaceKey: SurfaceKind | null;

  constructor(tagged: TaggedPrimitiveSource, placement: OwnerPlacement) {
    this.tagged = tagged;
    this.#placement = placement;
    this.#surfaceKey = resolveSurface(tagged, placement);
  }

  /** Same object identity across re-homes. */
  source(): SceneSource {
    return this.tagged.source;
  }

  zBand(): ZBand {
    return this.tagged.source.zBand;
  }

  /** Null when the source renders nowhere (price-axis source on an overlay scale). */
  surfaceKey(): SurfaceKind | null {
    return this.#surfaceKey;
  }

  /** Recompute the home surface and return the previous key; the host moves the
   *  source between scenes if it changed. */
  rehome(placement: OwnerPlacement): SurfaceKind | null {
    const prev = this.#surfaceKey;
    this.#placement = placement;
    this.#surfaceKey = resolveSurface(this.tagged, placement);
    return prev;
  }

  movedFrom(prevKey: SurfaceKind | null): boolean {
    return prevKey !== this.#surfaceKey;
  }

  placement(): OwnerPlacement {
    return this.#placement;
  }
}

export function resolveSurface(tagged: TaggedPrimitiveSource, placement: OwnerPlacement): SurfaceKind | null {
  switch (tagged.target) {
    case 'pane':
      return 'pane';
    case 'time-axis':
      return 'time-axis';
    case 'price-axis': {
      // An explicit `axis` wins; otherwise follow the owner's current scale side.
      const side = tagged.axis ?? placement.axisSide;
      if (side === null || side === undefined) return null;
      if (__DEV__) assert(side === 'left' || side === 'right', "price-axis side must be 'left' or 'right'");
      return side === 'left' ? 'price-axis-left' : 'price-axis-right';
    }
  }
}
