// Contract violations throw ChartError with a `code`; malformed numeric input throws RangeError.
import { assert } from '../core';

// Const object, not an enum (erasableSyntaxOnly); the same-named type is the public discriminant.
export const ChartErrorCode = {
  ContainerNotFound: 'container-not-found',
  Disposed: 'disposed',
  InvalidDataOrder: 'invalid-data-order',
  NonFiniteValue: 'non-finite-value',
  ValueOutOfBounds: 'value-out-of-bounds',
  MixedTimeKinds: 'mixed-time-kinds',
  InvalidDateString: 'invalid-date-string',
  StaleUpdate: 'stale-update',
  UnknownSeriesDefinition: 'unknown-series-definition',
  NoSuchScale: 'no-such-scale',
} as const;
export type ChartErrorCode = (typeof ChartErrorCode)[keyof typeof ChartErrorCode];

/** Library-raised error. Branch on `code`, which is stable and message-independent. */
export class ChartError extends Error {
  readonly code: ChartErrorCode;
  constructor(code: ChartErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'ChartError';
    this.code = code;
    // Restore the prototype chain across the Error super-call (down-level targets).
    Object.setPrototypeOf(this, ChartError.prototype);
  }
}

/** `detail` (offending id/index/keys) is appended to the message; `.code` stays clean. */
export function throwChartError(code: ChartErrorCode, detail?: string): never {
  if (__DEV__) {
    assert(typeof code === 'string', 'throwChartError: code must be a ChartErrorCode');
  }
  throw new ChartError(code, detail === undefined ? code : `${code}: ${detail}`);
}
