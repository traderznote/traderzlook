// Date/time formatting primitives. All conversions are UTC.

/** The default `localization.dateFormat`. */
export const DEFAULT_DATE_FORMAT = "dd MMM 'yy";

// Intl.DateTimeFormat construction is expensive; cache one per (locale, style).
const monthFormatters = new Map<string, Intl.DateTimeFormat>();

function monthName(date: Date, locale: string, style: 'long' | 'short'): string {
  const key = `${locale}|${style}`;
  let fmt = monthFormatters.get(key);
  if (fmt === undefined) {
    fmt = new Intl.DateTimeFormat(locale || undefined, { month: style, timeZone: 'UTC' });
    monthFormatters.set(key, fmt);
  }
  return fmt.format(date);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Tokens `yyyy yy MMMM MMM MM dd` are replaced longest-first; other characters are literal. */
export function formatDate(date: Date, format: string, locale: string): string {
  const yyyy = String(date.getUTCFullYear());
  return format
    .replace(/yyyy/g, yyyy)
    .replace(/yy/g, yyyy.slice(-2))
    .replace(/MMMM/g, monthName(date, locale, 'long'))
    .replace(/MMM/g, monthName(date, locale, 'short'))
    .replace(/MM/g, pad2(date.getUTCMonth() + 1))
    .replace(/dd/g, pad2(date.getUTCDate()));
}

export function formatTime(date: Date): string {
  return `${pad2(date.getUTCHours())}:${pad2(date.getUTCMinutes())}:${pad2(date.getUTCSeconds())}`;
}
