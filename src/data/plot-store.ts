// Columnar per-series storage: one Float64Array per lane plus a chunked min/max cache
// so visible-range autoscale does not rescan every row.
import { lowerBound } from '../core';
import type { TimeIndex, IFrameCounters } from '../core';
import type { StoreDiff } from './diffs';
import type { SeriesDataContract } from './series-contract';

const CHUNK = 30;
const lt = (a: number, b: number): boolean => a < b;

export interface PlotStoreView {
  readonly length: number;
  timeIndex(i: number): TimeIndex;
  current(i: number): number; // close / value
  min(i: number): number; // low / value
  max(i: number): number; // high / value
  lane(n: number, i: number): number;
  firstIndexAt(timeIndex: TimeIndex): number | null; // exact; null on miss
  nearestIndexAt(timeIndex: TimeIndex, dir: 'left' | 'right'): number; // clamps to ends
  minMaxInRows?(lo: number, hi: number): { min: number; max: number };
  /** Per-row color overrides from the user's item (e.g. a volume bar's `color`). */
  pointColors?(i: number): { color?: string; lineColor?: string; borderColor?: string; wickColor?: string } | undefined;
}

export class PlotStore<TItem = unknown> implements PlotStoreView {
  readonly #contract: SeriesDataContract<TItem>;
  readonly #laneCount: number;
  readonly #roleCurrent: number;
  readonly #roleMin: number;
  readonly #roleMax: number;
  #lanes: Float64Array[] = [];
  #times = new Int32Array(0);
  #length = 0;
  #chunkMin: number[] = [];
  #chunkMax: number[] = [];
  #counters: IFrameCounters | undefined;

  setCounters(counters: IFrameCounters): void {
    this.#counters = counters;
  }

  constructor(contract: SeriesDataContract<TItem>) {
    this.#contract = contract;
    this.#laneCount = contract.laneCount;
    this.#roleCurrent = contract.roles.current;
    this.#roleMin = contract.roles.min;
    this.#roleMax = contract.roles.max;
    for (let n = 0; n < this.#laneCount; n++) this.#lanes.push(new Float64Array(0));
  }

  get length(): number {
    return this.#length;
  }

  setData(items: readonly TItem[], timeIndices: readonly number[]): StoreDiff {
    let count = 0;
    for (let i = 0; i < items.length; i++) if (!this.#contract.isWhitespace(items[i])) count++;
    for (let n = 0; n < this.#laneCount; n++) this.#lanes[n] = new Float64Array(count);
    this.#times = new Int32Array(count);
    this.#fillRows(items, timeIndices, 0);
    this.#length = count;
    this.#buildChunksFrom(0);
    return { kind: 'replace' };
  }

  append(items: readonly TItem[], timeIndices: readonly number[]): StoreDiff {
    let add = 0;
    for (let i = 0; i < items.length; i++) if (!this.#contract.isWhitespace(items[i])) add++;
    const oldLen = this.#length;
    this.#reserve(oldLen + add);
    this.#fillRows(items, timeIndices, oldLen);
    this.#length = oldLen + add;
    this.#buildChunksFrom(oldLen);
    return { kind: 'append', count: add };
  }

  /** Overwrite the last row in place (a live update of the forming bar). */
  updateLast(item: TItem, timeIndex: number): StoreDiff {
    if (this.#length === 0) return this.append([item], [timeIndex]);
    const last = this.#length - 1;
    const tmp = new Float64Array(this.#laneCount);
    this.#contract.extractLanes(item, tmp, 0);
    for (let n = 0; n < this.#laneCount; n++) this.#lanes[n][last] = tmp[n];
    this.#times[last] = timeIndex;
    this.#buildChunksFrom(last);
    return { kind: 'updateLast' };
  }

  /** Replace every row's slot after the shared timeline gained slots before them. */
  retime(timeIndices: ArrayLike<number>): void {
    for (let i = 0; i < this.#length; i++) this.#times[i] = timeIndices[i];
  }

  #reserve(capacity: number): void {
    if (this.#times.length >= capacity) return;
    const next = Math.max(capacity, Math.ceil(this.#times.length * 1.5), 16);
    for (let n = 0; n < this.#laneCount; n++) {
      const bigger = new Float64Array(next);
      bigger.set(this.#lanes[n].subarray(0, this.#length));
      this.#lanes[n] = bigger;
    }
    const times = new Int32Array(next);
    times.set(this.#times.subarray(0, this.#length));
    this.#times = times;
  }

  #fillRows(items: readonly TItem[], timeIndices: readonly number[], startRow: number): void {
    const tmp = new Float64Array(this.#laneCount);
    let row = startRow;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (this.#contract.isWhitespace(item)) continue;
      this.#contract.extractLanes(item, tmp, 0);
      for (let n = 0; n < this.#laneCount; n++) this.#lanes[n][row] = tmp[n];
      this.#times[row] = timeIndices[i];
      row++;
    }
  }

  #buildChunksFrom(firstRow: number): void {
    const firstChunk = Math.floor(firstRow / CHUNK);
    const chunks = Math.ceil(this.#length / CHUNK);
    this.#chunkMin.length = chunks;
    this.#chunkMax.length = chunks;
    const minLane = this.#lanes[this.#roleMin];
    const maxLane = this.#lanes[this.#roleMax];
    if (__TN_PROFILE__ && this.#counters !== undefined) this.#counters.chunkRecomputes += Math.max(0, chunks - firstChunk);
    for (let c = firstChunk; c < chunks; c++) {
      const lo = c * CHUNK;
      const hi = Math.min(lo + CHUNK, this.#length);
      let mn = Number.POSITIVE_INFINITY;
      let mx = Number.NEGATIVE_INFINITY;
      for (let i = lo; i < hi; i++) {
        if (minLane[i] < mn) mn = minLane[i];
        if (maxLane[i] > mx) mx = maxLane[i];
      }
      this.#chunkMin[c] = mn;
      this.#chunkMax[c] = mx;
    }
  }

  valueRange(): { min: number; max: number } {
    if (this.#length === 0) return { min: Number.NaN, max: Number.NaN };
    return this.minMaxInRows(0, this.#length - 1);
  }

  /** Min over the min-role lane and max over the max-role lane for rows [lo, hi]. */
  minMaxInRows(lo: number, hi: number): { min: number; max: number } {
    const minLane = this.#lanes[this.#roleMin];
    const maxLane = this.#lanes[this.#roleMax];
    let mn = Number.POSITIVE_INFINITY;
    let mx = Number.NEGATIVE_INFINITY;
    let i = Math.max(0, lo);
    const end = Math.min(hi, this.#length - 1);
    while (i <= end) {
      const c = Math.floor(i / CHUNK);
      if (i === c * CHUNK && i + CHUNK - 1 <= end) {
        if (this.#chunkMin[c] < mn) mn = this.#chunkMin[c];
        if (this.#chunkMax[c] > mx) mx = this.#chunkMax[c];
        i += CHUNK;
        continue;
      }
      if (minLane[i] < mn) mn = minLane[i];
      if (maxLane[i] > mx) mx = maxLane[i];
      i++;
    }
    return { min: mn, max: mx };
  }

  timeIndex(i: number): TimeIndex {
    return this.#times[i] as TimeIndex;
  }
  current(i: number): number {
    return this.#lanes[this.#roleCurrent][i];
  }
  min(i: number): number {
    return this.#lanes[this.#roleMin][i];
  }
  max(i: number): number {
    return this.#lanes[this.#roleMax][i];
  }
  lane(n: number, i: number): number {
    return this.#lanes[n][i];
  }

  firstIndexAt(timeIndex: TimeIndex): number | null {
    const ti = timeIndex as number;
    const pos = lowerBound(this.#times, ti, lt, 0, this.#length);
    return pos < this.#length && this.#times[pos] === ti ? pos : null;
  }

  nearestIndexAt(timeIndex: TimeIndex, dir: 'left' | 'right'): number {
    if (this.#length === 0) return -1;
    const ti = timeIndex as number;
    const pos = lowerBound(this.#times, ti, lt, 0, this.#length);
    if (pos < this.#length && this.#times[pos] === ti) return pos;
    return dir === 'left' ? Math.max(0, pos - 1) : Math.min(pos, this.#length - 1);
  }
}
