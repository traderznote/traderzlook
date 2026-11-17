// Session-local time behavior: tick labels and day/session bucketing follow the given
// IANA zone's wall clock. Data stays keyed in UTC; only display and bucketing shift.
import { timeBehavior } from '../../api';
import type { IHorzScaleBehavior, Time } from '../../api';

/**
 * Build `(utc) => offset`: the zone's UTC offset in seconds (east-positive) at a UTC
 * instant in seconds. Cached per ~6-month segment so ticks in the same DST period share
 * one Intl computation. An unresolvable zone falls back to 0 (UTC).
 */
export function offsetFor(tz: string): (utc: number) => number {
  let fmt: Intl.DateTimeFormat | null = null;
  let usable = true;
  const ensure = (): Intl.DateTimeFormat | null => {
    if (fmt === null && usable) {
      try {
        fmt = new Intl.DateTimeFormat('en-US', {
          timeZone: tz,
          hourCycle: 'h23',
          year: 'numeric',
          month: 'numeric',
          day: 'numeric',
          hour: 'numeric',
          minute: 'numeric',
          second: 'numeric',
        });
      } catch {
        usable = false;
      }
    }
    return fmt;
  };

  const SEGMENT = 15552000; // ~180 days in seconds
  const cache = new Map<number, number>();

  return (utc: number): number => {
    const bucket = Math.floor(utc / SEGMENT);
    const hit = cache.get(bucket);
    if (hit !== undefined) return hit;
    const f = ensure();
    let offset = 0;
    if (f !== null) {
      // Rebuild the zone's wall-clock fields as a UTC instant; the difference is the offset.
      const parts = f.formatToParts(new Date(utc * 1000));
      const get = (t: string): number => {
        const p = parts.find((x) => x.type === t);
        return p === undefined ? 0 : Number(p.value);
      };
      const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
      offset = Math.round((asUtc - utc * 1000) / 1000);
    }
    cache.set(bucket, offset);
    return offset;
  };
}

/**
 * The core time behavior shifted to an IANA zone (e.g. `'America/New_York'`), so day
 * boundaries land at local midnight and ticks show local time. A custom
 * `timeFormatter`/`tickMarkFormatter` that calls a locale formatter may still use the
 * environment's zone.
 */
export function timezoneTimeBehavior(tz: string): IHorzScaleBehavior<Time> {
  return timeBehavior({ timezoneOffset: offsetFor(tz) }) as unknown as IHorzScaleBehavior<Time>;
}
