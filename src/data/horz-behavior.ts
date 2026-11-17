// IHorzScaleBehavior makes the time scale data-type agnostic: the core round-trips the
// behavior's opaque internal item `I` and only asks for keys, weights and formatting.
// Also the built-in UTC time behavior.
import { DEFAULT_DATE_FORMAT, formatDate, formatTime } from '../fmt';
import type { HorzKey } from '../core';
import { TickMarkType } from './options-groups';
import type {
  HorzScaleOptionGroups,
  LocalizationOptions,
  TimeScaleFormatOptions,
} from './options-groups';

export type { HorzScaleOptionGroups, LocalizationOptions, TimeScaleFormatOptions };
export { TickMarkType };

export type UTCTimestamp = number;
export interface BusinessDay {
  year: number;
  month: number; // 1-based
  day: number;
}
export type Time = UTCTimestamp | number | BusinessDay | string;

/** One slot on the merged timeline as the behavior sees it; fillWeights writes `weight`. */
export interface HorzPoint<I> {
  readonly item: I;
  readonly key: HorzKey;
  weight: number;
}

/** `H` = the user time form; `I` = the behavior's opaque internal item. */
export interface IHorzScaleBehavior<H, I = H> {
  key(item: H | I): HorzKey; // sortable numeric key (ordering, search, dedup)
  /** The internal item for a key with no data (e.g. a future slot under the crosshair). */
  fromKey?(key: HorzKey): I;
  cacheKey(item: I): number; // label-cache identity
  toInternal(items: readonly H[]): (item: H) => I; // one converter per batch
  formatItem(item: I, loc: LocalizationOptions<H>, fmt: TimeScaleFormatOptions<H>): string;
  formatTick(item: I, weight: number, loc: LocalizationOptions<H>, fmt: TimeScaleFormatOptions<H>): string;
  fillWeights(points: readonly HorzPoint<I>[], startIndex: number): void;
  maxTickWeight(weights: readonly number[]): number;
  augmentDefaults(defaults: HorzScaleOptionGroups<H>): void;
  timezoneOffset?(item: I): number;
}

export interface TimeInternal {
  readonly timestamp: UTCTimestamp; // seconds, UTC
  readonly businessDay?: BusinessDay;
}

const WEIGHT_LESS_THAN_SECOND = 0;
const WEIGHT_SECOND = 10;
const WEIGHT_MINUTE1 = 20;
const WEIGHT_MINUTE5 = 21;
const WEIGHT_MINUTE30 = 22;
const WEIGHT_HOUR1 = 30;
const WEIGHT_DAY = 50;
const WEIGHT_MONTH = 60;
const WEIGHT_YEAR = 70;

// [bucket width in ms, weight for crossing its boundary], largest → smallest.
const INTRADAY: ReadonlyArray<readonly [number, number]> = [
  [12 * 3600_000, 33], // Hour12
  [6 * 3600_000, 32], // Hour6
  [3 * 3600_000, 31], // Hour3
  [3600_000, WEIGHT_HOUR1], // Hour1
  [30 * 60_000, WEIGHT_MINUTE30],
  [5 * 60_000, WEIGHT_MINUTE5],
  [60_000, WEIGHT_MINUTE1],
  [1000, WEIGHT_SECOND],
];

const DATE_STRING = /^\d{4}-\d{2}-\d{2}$/;

function isBusinessDay(t: Time): t is BusinessDay {
  return typeof t !== 'number' && typeof t !== 'string';
}

function businessDayToTimestamp(bd: BusinessDay): number {
  return Math.round(Date.UTC(bd.year, bd.month - 1, bd.day, 0, 0, 0, 0) / 1000);
}

function parseDateString(s: string): BusinessDay {
  if (__DEV__ && !DATE_STRING.test(s)) {
    throw new Error(`[traderzlook] invalid date string: ${JSON.stringify(s)} (expected yyyy-mm-dd)`);
  }
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`[traderzlook] invalid date string: ${JSON.stringify(s)}`);
  }
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function timestampConverter(item: Time): TimeInternal {
  if (typeof item !== 'number') {
    throw new Error('[traderzlook] expected a UTC timestamp number');
  }
  return { timestamp: item };
}

function businessDayConverter(item: Time): TimeInternal {
  const bd = typeof item === 'string' ? parseDateString(item) : (item as BusinessDay);
  return { timestamp: businessDayToTimestamp(bd), businessDay: { year: bd.year, month: bd.month, day: bd.day } };
}

function instantOf(item: TimeInternal): Date {
  return item.businessDay !== undefined
    ? new Date(Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day))
    : new Date(item.timestamp * 1000);
}

// Only feeds the timezoneOffset hook; stored times always stay UTC.
function utcSecondsOf(item: TimeInternal): number {
  return item.businessDay !== undefined
    ? Math.round(Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day) / 1000)
    : item.timestamp;
}

/**
 * The instant shifted by the timezoneOffset hook, so getUTC* reads the configured wall
 * clock. Display and weight bucketing only; without a hook this is `instantOf`.
 */
function displayInstantOf(self: IHorzScaleBehavior<Time, TimeInternal>, item: TimeInternal): Date {
  if (self.timezoneOffset === undefined) return instantOf(item);
  const utc = utcSecondsOf(item);
  return new Date((utc + self.timezoneOffset(item)) * 1000);
}

/** The user-facing `originalTime` value that user formatters receive. */
function originalOf(item: TimeInternal): Time {
  return item.businessDay !== undefined ? { ...item.businessDay } : (item.timestamp as UTCTimestamp);
}

function weightByTime(curMs: number, prevMs: number): number {
  const cur = new Date(curMs);
  const prev = new Date(prevMs);
  if (cur.getUTCFullYear() !== prev.getUTCFullYear()) return WEIGHT_YEAR;
  if (cur.getUTCMonth() !== prev.getUTCMonth()) return WEIGHT_MONTH;
  if (cur.getUTCDate() !== prev.getUTCDate()) return WEIGHT_DAY;
  for (const [divisor, weight] of INTRADAY) {
    if (Math.floor(prevMs / divisor) !== Math.floor(curMs / divisor)) return weight;
  }
  return WEIGHT_LESS_THAN_SECOND;
}

function weightToType(weight: number, timeVisible: boolean, secondsVisible: boolean): TickMarkType {
  if (weight >= WEIGHT_YEAR) return TickMarkType.Year;
  if (weight >= WEIGHT_MONTH) return TickMarkType.Month;
  if (weight >= WEIGHT_DAY) return TickMarkType.DayOfMonth;
  if (!timeVisible) return TickMarkType.DayOfMonth;
  return weight <= WEIGHT_SECOND && secondsVisible ? TickMarkType.TimeWithSeconds : TickMarkType.Time;
}

function defaultTickLabel(d: Date, type: TickMarkType, locale: string): string {
  switch (type) {
    case TickMarkType.Year:
      return String(d.getUTCFullYear());
    case TickMarkType.Month:
      return formatDate(d, 'MMM', locale);
    case TickMarkType.DayOfMonth:
      return String(d.getUTCDate());
    case TickMarkType.TimeWithSeconds:
      return formatTime(d); // HH:mm:ss
    default: {
      const hms = formatTime(d);
      return hms.slice(0, 5); // HH:mm
    }
  }
}

const timeBehaviorImpl: IHorzScaleBehavior<Time, TimeInternal> = {
  fromKey: (key) => ({ timestamp: key as unknown as UTCTimestamp }),
  key(item: Time | TimeInternal): HorzKey {
    if (typeof item === 'object' && item !== null && 'timestamp' in item) {
      return (item as TimeInternal).timestamp as unknown as HorzKey;
    }
    const t = item as Time;
    if (typeof t === 'number') return t as unknown as HorzKey;
    if (typeof t === 'string') return businessDayToTimestamp(parseDateString(t)) as unknown as HorzKey;
    return businessDayToTimestamp(t) as unknown as HorzKey;
  },

  cacheKey(item: TimeInternal): number {
    return item.businessDay !== undefined
      ? Date.UTC(item.businessDay.year, item.businessDay.month - 1, item.businessDay.day)
      : item.timestamp * 1000;
  },

  toInternal(items: readonly Time[]): (item: Time) => TimeInternal {
    // the first item picks the converter for the whole batch.
    const first = items.length > 0 ? items[0] : undefined;
    const useBusinessDay = first !== undefined && (typeof first === 'string' || isBusinessDay(first));
    return useBusinessDay ? businessDayConverter : timestampConverter;
  },

  formatItem(item: TimeInternal, loc: LocalizationOptions<Time>, fmt: TimeScaleFormatOptions<Time>): string {
    if (loc.timeFormatter !== undefined) return loc.timeFormatter(originalOf(item));
    const d = instantOf(item);
    const datePart = formatDate(d, loc.dateFormat, loc.locale);
    if (!fmt.timeVisible) return datePart;
    const hms = formatTime(d);
    const timePart = fmt.secondsVisible ? hms : hms.slice(0, 5);
    return `${datePart}   ${timePart}`;
  },

  formatTick(
    item: TimeInternal,
    weight: number,
    loc: LocalizationOptions<Time>,
    fmt: TimeScaleFormatOptions<Time>,
  ): string {
    const type = weightToType(weight, fmt.timeVisible, fmt.secondsVisible);
    if (fmt.tickMarkFormatter !== undefined) {
      const out = fmt.tickMarkFormatter(originalOf(item), type, loc.locale);
      if (out !== null) return out;
    }
    return defaultTickLabel(displayInstantOf(this, item), type, loc.locale);
  },

  fillWeights(points: readonly HorzPoint<TimeInternal>[], startIndex: number): void {
    const n = points.length;
    if (n === 0) return;
    // With a timezoneOffset hook, bucket on the shifted instant so local day/session
    // boundaries get their weight. Business-day timestamps already equal UTC midnight.
    const off = this.timezoneOffset;
    const displayMs =
      off === undefined
        ? (item: TimeInternal): number => item.timestamp * 1000
        : (item: TimeInternal): number => (utcSecondsOf(item) + off(item)) * 1000;
    let prevMs = startIndex > 0 ? displayMs(points[startIndex - 1].item) : null;
    let totalTimeDiff = 0;
    for (let i = startIndex; i < n; i++) {
      const curMs = displayMs(points[i].item);
      if (prevMs !== null) {
        points[i].weight = weightByTime(curMs, prevMs);
        totalTimeDiff += curMs - prevMs;
      }
      prevMs = curMs;
    }
    if (startIndex === 0 && n > 1) {
      // the first point has no predecessor: invent one an average gap back.
      const avg = Math.ceil(totalTimeDiff / (n - 1));
      const firstMs = displayMs(points[0].item);
      points[0].weight = weightByTime(firstMs, firstMs - avg);
    }
  },

  maxTickWeight(weights: readonly number[]): number {
    let max = 0;
    for (const w of weights) if (w > max) max = w;
    // a max strictly between Hour1 and Day is reduced to Hour1, so all hour marks bold alike.
    if (max > WEIGHT_HOUR1 && max < WEIGHT_DAY) max = WEIGHT_HOUR1;
    return max;
  },

  augmentDefaults(defaults: HorzScaleOptionGroups<Time>): void {
    defaults.localization.dateFormat = DEFAULT_DATE_FORMAT;
  },
};

/**
 * UTC time behavior. With no options returns a shared singleton; with `timezoneOffset`
 * (fed UTC seconds, returns an offset in seconds) weights and tick labels use the shifted
 * wall clock while stored times stay UTC.
 */
export function timeBehavior(options?: {
  timezoneOffset?: (utcSeconds: number) => number;
}): IHorzScaleBehavior<Time, TimeInternal> {
  if (options?.timezoneOffset === undefined) return timeBehaviorImpl;
  const offset = options.timezoneOffset;
  return {
    ...timeBehaviorImpl,
    timezoneOffset: (item: TimeInternal): number => offset(utcSecondsOf(item)),
  };
}
