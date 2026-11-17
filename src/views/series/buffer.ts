// Columnar per-series scratch buffer, reused frame-to-frame. `ensure` grows by
// amortised doubling and never shrinks, so a steady-state frame allocates nothing.
import { assert } from '../../core';
import type { IFrameCounters } from '../../core';

/** `convert` fills `x`/`y`/`extra`; `emit`/`hitTest` read them. `item(i)` lazily
 *  materialises a payload view for style/colour reads. */
export interface ItemBuffer<Item> {
  length: number;
  /** media-px centre X per item. */
  readonly x: Float32Array;
  /** media-px Y per item; NaN = gap (whitespace / NaN value). */
  readonly y: Float32Array;
  /** Kind-private extra lane (OHLC hi/lo pixel pairs, baseline split-Y),
   *  `laneStride` floats per item. */
  readonly extra: Float32Array;
  readonly laneStride: number;
  readonly timeIndex: Int32Array;
  item(i: number): Item;
  ensure(capacity: number): void;
}

/** Receives the buffer and row index so a kind can read its own lanes or reuse one
 *  flyweight object. */
export type ItemFactory<Item> = (buffer: ItemBuffer<Item>, index: number) => Item;

const INITIAL_CAPACITY = 16;

/** `length` is set by the engine after `convert`/`itemsFromStore`. */
export class ReusableItemBuffer<Item> implements ItemBuffer<Item> {
  length = 0;
  #x: Float32Array;
  #y: Float32Array;
  #extra: Float32Array;
  #timeIndex: Int32Array;
  readonly #laneStride: number;
  readonly #factory: ItemFactory<Item>;
  #capacity: number;
  /** Incremented on every backing-array grow; expected 0 after warm-up. */
  reallocs = 0;
  // Set under __TN_PROFILE__; the ++ strips out without the define.
  #counters: IFrameCounters | undefined;

  setCounters(counters: IFrameCounters): void {
    this.#counters = counters;
  }

  constructor(laneStride: number, factory: ItemFactory<Item>, initialCapacity = INITIAL_CAPACITY) {
    if (__DEV__) assert(laneStride >= 0 && Number.isInteger(laneStride), 'laneStride must be a non-negative integer');
    this.#laneStride = laneStride;
    this.#factory = factory;
    this.#capacity = Math.max(1, initialCapacity);
    this.#x = new Float32Array(this.#capacity);
    this.#y = new Float32Array(this.#capacity);
    this.#extra = new Float32Array(this.#capacity * laneStride);
    this.#timeIndex = new Int32Array(this.#capacity);
  }

  get x(): Float32Array {
    return this.#x;
  }
  get y(): Float32Array {
    return this.#y;
  }
  get extra(): Float32Array {
    return this.#extra;
  }
  get laneStride(): number {
    return this.#laneStride;
  }
  get timeIndex(): Int32Array {
    return this.#timeIndex;
  }

  capacity(): number {
    return this.#capacity;
  }

  ensure(capacity: number): void {
    if (capacity <= this.#capacity) return;
    let cap = this.#capacity;
    while (cap < capacity) cap *= 2;
    const x = new Float32Array(cap);
    x.set(this.#x);
    const y = new Float32Array(cap);
    y.set(this.#y);
    const ti = new Int32Array(cap);
    ti.set(this.#timeIndex);
    this.#x = x;
    this.#y = y;
    this.#timeIndex = ti;
    if (this.#laneStride > 0) {
      const extra = new Float32Array(cap * this.#laneStride);
      extra.set(this.#extra);
      this.#extra = extra;
    }
    this.#capacity = cap;
    this.reallocs++;
    if (__TN_PROFILE__ && this.#counters !== undefined) this.#counters.bufferReallocs++;
  }

  item(i: number): Item {
    if (__DEV__) assert(i >= 0 && i < this.length, 'item index out of range');
    return this.#factory(this, i);
  }
}
