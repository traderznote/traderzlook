// EMA indicator: reads the input series through `store()` and writes an ordinary output
// LineSeries via its own setData/update, recomputing incrementally on each data change.
import { mergeOptions } from '../../core';
import type { DeepPartial, Disposable, Unsubscribe } from '../../core';
import { LineSeries } from '../../api';
import type {
  IChart,
  ISeries,
  PlotStoreView,
  SeriesDefinition,
  SeriesType,
  StoreDiff,
  Time,
} from '../../api';

/** One output series. `pane: 'input'` overlays the input's pane; `'own'` opens a new pane. */
export interface IndicatorOutput {
  readonly id: string;
  readonly definition: SeriesDefinition<SeriesType, unknown, unknown>;
  readonly pane: 'input' | 'own';
}

export type IndicatorPatchMode = 'append' | 'updateLast' | 'replace';

/** Values for one output, aligned to input rows starting at `fromRow`. The host maps rows
 *  to times, so the computer never deals with the horizontal key type. */
export interface IndicatorOutputPatch {
  readonly outputId: string;
  readonly mode: IndicatorPatchMode;
  readonly fromRow: number;
  /** One value per input row from `fromRow`; `null` is a whitespace row. */
  readonly rows: readonly (number | null)[];
}

export interface IndicatorComputer {
  /** Rows of lookback an `updateLast` recompute needs. */
  readonly warmup: number;
  apply(diff: StoreDiff, input: PlotStoreView): readonly IndicatorOutputPatch[];
}

export interface IndicatorDefinition<P> {
  readonly type: string;
  readonly defaultParams: P;
  readonly outputs: readonly IndicatorOutput[];
  createComputer(params: P): IndicatorComputer;
}

/** `period` is the span N (α = 2/(N+1)). */
export interface EmaParams {
  period: number;
}

export const defaultEmaParams: EmaParams = { period: 9 };

const EMA_OUTPUT_ID = 'ema';

/**
 * EMA over the input's `current` lane (close for OHLC): `e[i] = α·x[i] + (1−α)·e[i−1]`,
 * seeded with the first finite x. Running state keeps tail updates O(count).
 */
function createEmaComputer(params: EmaParams): IndicatorComputer {
  if (!Number.isFinite(params.period) || params.period < 1) {
    throw new RangeError(`ema: period must be a finite number >= 1, got ${params.period}`);
  }
  const alpha = 2 / (params.period + 1);
  // `emaAt` is the EMA at row `emaRow`; `emaBefore` is the EMA one row earlier, so
  // `updateLast` can recompute the last row from its true predecessor.
  let emaAt = Number.NaN;
  let emaBefore = Number.NaN;
  let emaRow = -1;

  /** EMA for rows [from, length) seeded with the EMA at `from − 1` (NaN = seed at first finite x). */
  const run = (input: PlotStoreView, from: number, seed: number): (number | null)[] => {
    const out: (number | null)[] = [];
    let e = seed;
    let before = seed;
    for (let i = from; i < input.length; i++) {
      const x = input.current(i);
      if (!Number.isFinite(x)) {
        out.push(null);
        continue;
      }
      before = e;
      e = Number.isFinite(e) ? alpha * x + (1 - alpha) * e : x;
      out.push(e);
    }
    emaAt = e;
    emaBefore = before;
    emaRow = input.length - 1;
    return out;
  };

  const reset = (): void => {
    emaAt = Number.NaN;
    emaBefore = Number.NaN;
    emaRow = -1;
  };

  return {
    warmup: 1,
    apply(diff: StoreDiff, input: PlotStoreView): readonly IndicatorOutputPatch[] {
      if (input.length === 0) {
        reset();
        return [{ outputId: EMA_OUTPUT_ID, mode: 'replace', fromRow: 0, rows: [] }];
      }
      switch (diff.kind) {
        case 'append': {
          // Resume from the first uncomputed row rather than trusting `count`, so a
          // coalesced multi-append is still correct.
          const from = Math.max(0, emaRow + 1);
          return [{ outputId: EMA_OUTPUT_ID, mode: 'append', fromRow: from, rows: run(input, from, emaAt) }];
        }
        case 'updateLast': {
          const from = Math.max(0, input.length - 1);
          const seed = from > 0 ? emaBefore : Number.NaN;
          return [{ outputId: EMA_OUTPUT_ID, mode: 'updateLast', fromRow: from, rows: run(input, from, seed) }];
        }
        default: {
          // replace / insert / reindex: full rebuild.
          reset();
          return [{ outputId: EMA_OUTPUT_ID, mode: 'replace', fromRow: 0, rows: run(input, 0, Number.NaN) }];
        }
      }
    },
  };
}

/** One LineSeries output overlaid on the input's pane. */
export const emaDefinition: IndicatorDefinition<EmaParams> = {
  type: 'ema',
  defaultParams: defaultEmaParams,
  outputs: [{ id: EMA_OUTPUT_ID, definition: LineSeries as SeriesDefinition<SeriesType, unknown, unknown>, pane: 'input' }],
  createComputer: createEmaComputer,
};

/** `dispose()` removes the output series and unsubscribes from the input. */
export interface EmaHandle extends Disposable {
  readonly series: ISeries<SeriesType, Time>;
}

type OutItem = { time: Time; value: number } | { time: Time };

/**
 * Attach an EMA of `input` as a new LineSeries on `chart`. The output updates in the same
 * frame as the input because it is written inside the input's data-changed callback.
 */
export function createEma(
  chart: IChart<Time>,
  input: ISeries<SeriesType, Time>,
  params?: DeepPartial<EmaParams>,
  options?: DeepPartial<unknown>,
): EmaHandle {
  const p: EmaParams =
    params === undefined ? { ...defaultEmaParams } : mergeOptions(defaultEmaParams, params, defaultEmaParams);
  const def = emaDefinition;
  const output = def.outputs[0]!;
  const computer = def.createComputer(p);

  // A pane index equal to the pane count creates a new pane.
  const paneIndex = output.pane === 'own' ? chart.panes().length : undefined;
  const outSeries = chart.addSeries(output.definition, options, paneIndex) as ISeries<SeriesType, Time>;

  // Patch rows are plot-store indices, which skip whitespace, while `input.data()` includes
  // whitespace items. Project data() down to value-bearing times so `fromRow + k` lines up;
  // indexing data() directly would shift values past a gap onto the wrong time.
  const plotTimes = (): Time[] => {
    const data = input.data() as readonly { time: Time; value?: unknown; open?: unknown }[];
    const times: Time[] = [];
    for (const row of data) {
      if (row.value === undefined && row.open === undefined) continue;
      times.push(row.time);
    }
    return times;
  };

  const itemsFor = (patch: IndicatorOutputPatch): OutItem[] => {
    const times = plotTimes();
    const items: OutItem[] = [];
    for (let k = 0; k < patch.rows.length; k++) {
      const time = times[patch.fromRow + k];
      if (time === undefined) break;
      const v = patch.rows[k];
      items.push(v === null ? { time } : { time, value: v });
    }
    return items;
  };

  const applyPatch = (patch: IndicatorOutputPatch): void => {
    const items = itemsFor(patch);
    if (patch.mode === 'replace') {
      outSeries.setData(items);
      return;
    }
    for (const it of items) outSeries.update(it);
  };

  const recompute = (diff: StoreDiff): void => {
    for (const patch of computer.apply(diff, input.store())) applyPatch(patch);
  };

  // The input may already hold data at attach time.
  recompute({ kind: 'replace' });
  const off: Unsubscribe = input.subscribeDataChanged(recompute);

  let disposed = false;
  return {
    series: outSeries,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      off();
      chart.removeSeries(outSeries);
    },
  };
}
