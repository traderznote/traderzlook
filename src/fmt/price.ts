// Price / percent / volume formatting. The price formatter uses integer arithmetic
// (not toFixed) so tick snapping and the half-up carry are exact.

export interface IPriceFormatter {
  format(price: number): string;
}

/** Decimal digits implied by a tick size (`0.25 → 2`, `0.001 → 3`), capped at 8. */
export function precisionByMinMove(minMove: number): number {
  if (minMove >= 1) return 0;
  let i = 0;
  for (; i < 8; i++) {
    if (Math.abs(Math.round(minMove) - minMove) < 1e-8) return i;
    minMove *= 10;
  }
  return i;
}

function leftPadZeros(value: string, length: number): string {
  return value.length >= length ? value : '0'.repeat(length - value.length) + value;
}

class PriceFormatterImpl implements IPriceFormatter {
  readonly #p: number; // 10^precision
  readonly #m: number; // minMove * 10^precision  (falsy → 1)
  readonly #precision: number;

  constructor(precision: number, minMove: number) {
    this.#precision = precision;
    this.#p = 10 ** precision;
    const m = minMove * this.#p;
    this.#m = m > 0 && Number.isFinite(m) ? m : 1;
  }

  format(price: number): string {
    if (typeof price !== 'number' || !Number.isFinite(price)) return 'n/a';
    const sign = price < 0 ? '−' : '';
    const v = Math.abs(price);
    const base = this.#p / this.#m; // rounds to the nearest minMove
    let int = Math.floor(v);
    let fracStr: string;
    if (base > 1) {
      let frac = Math.round(v * base) - int * base;
      if (frac >= base) {
        frac -= base;
        int += 1;
      }
      fracStr = '.' + leftPadZeros(String(frac * this.#m), this.#precision);
    } else {
      int = Math.round(int * base) / base;
      fracStr = this.#precision > 0 ? '.' + '0'.repeat(this.#precision) : '';
    }
    return sign + int + fracStr;
  }
}

export function priceFormatter(precision: number, minMove: number): IPriceFormatter {
  return new PriceFormatterImpl(precision, minMove);
}

export function percentFormatter(precision: number, minMove: number): IPriceFormatter {
  const inner = new PriceFormatterImpl(precision, minMove);
  return {
    format(price: number): string {
      const s = inner.format(price);
      return s === 'n/a' ? s : s + '%';
    },
  };
}

// Not "toFixed + strip": values ≥ 1 take String() after rounding (float noise can
// surface), and the strip only removes zeros after digits 1-9 ("1.1050" is untouched).
function formatNumber(value: number, precision: number): string {
  const scale = 10 ** precision;
  const rounded = Math.round(value * scale) / scale;
  let s: string;
  if (rounded >= 1e-15 && rounded < 1) {
    s = rounded.toFixed(precision).replace(/\.?0+$/, '');
  } else {
    s = String(rounded);
  }
  return s.replace(/(\.[1-9]*)0+$/, '$1');
}

export function volumeFormatter(precision: number): IPriceFormatter {
  return {
    format(value: number): string {
      if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
      const sign = value < 0 ? '-' : ''; // ASCII '-', unlike PriceFormatter's U+2212
      let av = Math.abs(value);
      let body: string;
      if (av < 995) {
        body = formatNumber(av, precision);
      } else if (av < 999995) {
        body = formatNumber(av / 1000, precision) + 'K';
      } else if (av < 999999995) {
        av = 1000 * Math.round(av / 1000);
        body = formatNumber(av / 1e6, precision) + 'M';
      } else {
        av = 1e6 * Math.round(av / 1e6);
        body = formatNumber(av / 1e9, precision) + 'B';
      }
      return sign + body;
    },
  };
}
