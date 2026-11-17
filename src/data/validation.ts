// Cheap checks (order, finiteness, bounds, date strings) run in every build unless 'off';
// the OHLC sanity check is dev-only. 'warn' logs once per call and drops offending items.
import type { IHorzScaleBehavior } from './horz-behavior';
import type { SeriesDataContract } from './series-contract';

export type ValidationMode = 'throw' | 'warn' | 'off';

export interface ValidationOptions {
  validation: ValidationMode;
}

const MAX_MAGNITUDE = Math.pow(2, 53) / 100;
const DATE_STRING = /^\d{4}-\d{2}-\d{2}$/;

interface TimedItem {
  time: unknown;
}

export type DataValidationKind = 'order' | 'date' | 'non-finite' | 'bounds' | 'ohlc';

export class DataValidationError extends Error {
  readonly kind: DataValidationKind;
  constructor(kind: DataValidationKind, message: string) {
    super(`[traderzlook] ${message}`);
    this.name = 'DataValidationError';
    this.kind = kind;
  }
}

/** Returns the input array unless 'warn' mode dropped items (then a filtered copy). */
export function validateSeriesData<TItem extends TimedItem, H, I>(
  items: readonly TItem[],
  contract: SeriesDataContract<TItem>,
  behavior: IHorzScaleBehavior<H, I>,
  options: ValidationOptions,
): readonly TItem[] {
  if (options.validation === 'off') return items;
  const warn = options.validation === 'warn';

  const lanes = new Float64Array(contract.laneCount);
  const kept: TItem[] = [];
  let warned = false;
  let prevKey: number | null = null;

  // true = skip the item ('warn'); otherwise throws.
  const report = (index: number, reason: string, kind: DataValidationKind): boolean => {
    if (warn) {
      if (!warned) {
        warned = true;
        console.warn(`[traderzlook] dropped invalid series data: ${reason} (item index ${index})`);
      }
      return true;
    }
    throw new DataValidationError(kind, `${reason} (item index ${index})`);
  };

  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    const t = item.time;
    if (typeof t === 'string' && !DATE_STRING.test(t)) {
      if (report(i, `invalid date string ${JSON.stringify(t)} (expected yyyy-mm-dd)`, 'date')) continue;
    }

    const key = behavior.key(item.time as H | I) as unknown as number;
    if (prevKey !== null && key <= prevKey) {
      const reason = `keys must be strictly ascending and unique: key ${key} is not greater than the previous key ${prevKey}`;
      if (report(i, reason, 'order')) continue; // prevKey stays, so the kept keys stay ascending
    }

    if (!contract.isWhitespace(item)) {
      contract.extractLanes(item, lanes, 0);
      let bad: string | null = null;
      let badKind: DataValidationKind = 'non-finite';
      for (let n = 0; n < contract.laneCount; n++) {
        const val = lanes[n];
        if (!Number.isFinite(val)) {
          bad = `non-finite value ${val} in lane ${n}`;
          break;
        }
        if (Math.abs(val) > MAX_MAGNITUDE) {
          bad = `value ${val} exceeds the magnitude bound 2^53/100 in lane ${n}`;
          badKind = 'bounds';
          break;
        }
      }
      if (bad === null && __DEV__ && contract.laneCount === 4) {
        const open = lanes[0];
        const high = lanes[1];
        const low = lanes[2];
        const close = lanes[3];
        if (high < Math.max(open, close)) bad = `high ${high} below max(open,close)`;
        else if (low > Math.min(open, close)) bad = `low ${low} above min(open,close)`;
        if (bad !== null) badKind = 'ohlc';
      }
      if (bad !== null && report(i, bad, badKind)) continue;
    }

    prevKey = key;
    if (warn) kept.push(item);
  }

  return warn ? kept : items;
}
