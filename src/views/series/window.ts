// ItemWindow: the visible slice widened to integer item indices. Carries raw
// numbers, not the public branded `Logical`/`Time` range types.

/** Integer `[from, to)` over the item buffer / store rows. */
export interface ItemWindow {
  readonly from: number;
  readonly to: number;
}

/** Re-pointed in place each frame by the engine, so a steady-state frame never
 *  allocates a window. */
export class MutableItemWindow implements ItemWindow {
  #from = 0;
  #to = 0;

  get from(): number {
    return this.#from;
  }
  get to(): number {
    return this.#to;
  }

  /** Clamps so that `from ≤ to`. */
  set(from: number, to: number): this {
    this.#from = from;
    this.#to = to < from ? from : to;
    return this;
  }

  count(): number {
    return this.#to - this.#from;
  }

  isEmpty(): boolean {
    return this.#to <= this.#from;
  }
}

/** Immutable snapshot for tests/setup; the engine reuses a `MutableItemWindow`. */
export function itemWindow(from: number, to: number): ItemWindow {
  return { from, to: to < from ? from : to };
}
