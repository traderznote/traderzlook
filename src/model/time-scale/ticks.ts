// Time tick-mark selection and density math. Weights come from the behavior (via the
// Timeline); the selection cache key ignores scroll, so panning at a stable zoom never rebuilds.

/** `index` is the union TimeIndex. Extra caller fields round-trip untouched. */
export interface TickMark {
  readonly index: number;
  readonly weight: number;
}

export interface BuildParams<M extends TickMark = TickMark> {
  /** Minimum index distance between two kept labels. */
  readonly maxIndexesPerMark: number;
  /** All-or-nothing: a weight level is drawn only if every one of its marks fits. */
  readonly uniformDistribution?: boolean;
  /** false ⇒ the mark is never selected. Default: all includable. */
  readonly includable?: (mark: M) => boolean;
  /** Part of the cache key. */
  readonly whitespaceFlag?: boolean;
  /** Part of the cache key; bump it when the whitespace set changes. */
  readonly whitespaceSetId?: number;
}

const DEFAULT_TICK_MAX_CHARS = 8;

/** ((fontSize + 4)·5 / 8) · (maxChars ?? 8) */
export function maxLabelWidthFor(fontSize: number, maxChars: number | undefined): number {
  const pixelsPerChar = ((fontSize + 4) * 5) / 8;
  return pixelsPerChar * (maxChars ?? DEFAULT_TICK_MAX_CHARS);
}

/** Min index distance so two labels cannot overlap. */
export function maxIndexesPerMark(maxLabelWidth: number, barSpacing: number): number {
  return Math.ceil(maxLabelWidth / barSpacing);
}

export function indexPerLabel(maxLabelWidth: number, barSpacing: number): number {
  return Math.round(maxLabelWidth / barSpacing);
}

interface CacheEntry<M extends TickMark> {
  readonly maxIndexesPerMark: number;
  readonly uniform: boolean;
  readonly whitespaceFlag: boolean;
  readonly whitespaceSetId: number;
  readonly result: readonly M[];
}

export class TickMarkEngine<M extends TickMark = TickMark> {
  /** weight → index-ascending marks. */
  #byWeight = new Map<number, M[]>();
  #weightsDesc: number[] = [];
  #cache: CacheEntry<M> | null = null;

  /** Re-buckets the full set and clears the cache. */
  setMarks(marks: readonly M[]): void {
    const byWeight = new Map<number, M[]>();
    for (const m of marks) {
      let bucket = byWeight.get(m.weight);
      if (bucket === undefined) {
        bucket = [];
        byWeight.set(m.weight, bucket);
      }
      bucket.push(m);
    }
    // the merge walk needs each bucket index-ascending.
    for (const bucket of byWeight.values()) bucket.sort((a, b) => a.index - b.index);
    this.#byWeight = byWeight;
    this.#weightsDesc = [...byWeight.keys()].sort((a, b) => b - a);
    this.#cache = null;
  }

  /** Non-overlapping marks, index-ascending; served from the one-entry cache on a key match. */
  build(params: BuildParams<M>): readonly M[] {
    const uniform = params.uniformDistribution ?? false;
    const whitespaceFlag = params.whitespaceFlag ?? false;
    const whitespaceSetId = params.whitespaceSetId ?? 0;

    const c = this.#cache;
    if (
      c !== null &&
      c.maxIndexesPerMark === params.maxIndexesPerMark &&
      c.uniform === uniform &&
      c.whitespaceFlag === whitespaceFlag &&
      c.whitespaceSetId === whitespaceSetId
    ) {
      return c.result;
    }

    const result = this.#select(params.maxIndexesPerMark, uniform, params.includable);
    this.#cache = { maxIndexesPerMark: params.maxIndexesPerMark, uniform, whitespaceFlag, whitespaceSetId, result };
    return result;
  }

  /** Greedy by descending weight: a lower-weight mark is kept only if it is ≥ gap from
   *  its accepted neighbors on both sides. */
  #select(gap: number, uniform: boolean, includable?: (mark: M) => boolean): M[] {
    const canInclude = (m: M): boolean => (includable === undefined ? true : includable(m));

    let accepted: M[] = [];
    for (const weight of this.#weightsDesc) {
      const marks = this.#byWeight.get(weight) as M[];
      const prev = accepted;
      accepted = [];
      let p = 0;
      let left = -Infinity;
      let right = Infinity;

      for (const mark of marks) {
        while (p < prev.length && prev[p].index < mark.index && canInclude(prev[p])) {
          accepted.push(prev[p]);
          left = prev[p].index;
          right = Infinity;
          p++;
        }
        if (p < prev.length && !(prev[p].index < mark.index && canInclude(prev[p]))) {
          right = prev[p].index;
        }
        if (right - mark.index >= gap && mark.index - left >= gap && canInclude(mark)) {
          accepted.push(mark);
          left = mark.index;
        } else if (uniform) {
          // one non-fitting mark rejects this whole level and every lower one.
          return prev;
        }
      }
      for (; p < prev.length; p++) {
        if (canInclude(prev[p])) accepted.push(prev[p]);
      }
    }
    return accepted;
  }
}
