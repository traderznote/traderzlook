// Options boundary: the defaults pipeline and the boundary normalizations, applied at
// creation AND in applyOptions. A null leaf resets to the default.
import { mergeOptions } from '../core';
import type { DeepPartial, DeepReadonly } from '../core';
import { precisionByMinMove } from '../fmt';
import { rightOffsetFromPixels } from '../model';

type Rec = Record<string, unknown>;

function isPlainObject(value: unknown): value is Rec {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

/** Plain objects are cloned recursively; arrays, functions and instances are shared. */
export function cloneOptions<T>(value: T): T {
  if (isPlainObject(value)) {
    const out: Rec = {};
    for (const k of Object.keys(value)) out[k] = cloneOptions((value as Rec)[k]);
    return out as T;
  }
  return value;
}

/** What every `options()` getter returns: a deep copy, recursively frozen in dev only. */
export function snapshot<T>(value: T): DeepReadonly<T> {
  const copy = cloneOptions(value);
  if (__DEV__) deepFreeze(copy);
  return copy as DeepReadonly<T>;
}

function deepFreeze(value: unknown): void {
  if (!isPlainObject(value)) return;
  for (const k of Object.keys(value)) deepFreeze(value[k]);
  Object.freeze(value);
}

export interface HandleScrollOptions {
  mouseWheel: boolean;
  pressedMouseMove: boolean;
  horzTouchDrag: boolean;
  vertTouchDrag: boolean;
}

export interface HandleScaleOptions {
  mouseWheel: boolean;
  pinch: boolean;
  axisPressedMouseMove: { time: boolean; price: boolean };
  axisDoubleClickReset: { time: boolean; price: boolean };
}

function scrollAll(on: boolean): HandleScrollOptions {
  return { mouseWheel: on, pressedMouseMove: on, horzTouchDrag: on, vertTouchDrag: on };
}

function scaleAll(on: boolean): HandleScaleOptions {
  return {
    mouseWheel: on,
    pinch: on,
    axisPressedMouseMove: { time: on, price: on },
    axisDoubleClickReset: { time: on, price: on },
  };
}

/** A bare boolean fans out to all four flags; a partial object is left for the merge. */
export function normalizeHandleScroll(value: unknown): unknown {
  return typeof value === 'boolean' ? scrollAll(value) : value;
}

/** A bare boolean fans out to every flag; inside an object, a boolean axis member
 *  expands to `{ time, price }`. */
export function normalizeHandleScale(value: unknown): unknown {
  if (typeof value === 'boolean') return scaleAll(value);
  if (!isPlainObject(value)) return value;
  const out: Rec = { ...value };
  for (const axis of ['axisPressedMouseMove', 'axisDoubleClickReset'] as const) {
    const v = out[axis];
    if (typeof v === 'boolean') out[axis] = { time: v, price: v };
  }
  return out;
}

/** Converts `rightOffsetPixels` to a bar `rightOffset` and drops the pixel key (the offset
 *  is bar-denominated internally). A `0` behaves as unset. Mutates and returns `timeScale`. */
export function normalizeRightOffsetPixels(timeScale: Rec, barSpacing: number): Rec {
  const px = timeScale.rightOffsetPixels;
  if (typeof px === 'number' && px !== 0 && barSpacing > 0) {
    timeScale.rightOffset = rightOffsetFromPixels(px, barSpacing);
  }
  delete timeScale.rightOffsetPixels;
  return timeScale;
}

/** Returns a new patch; the input is never mutated, so a frozen user partial is safe. */
export function normalizeChartPatch<T extends Rec>(patch: T, barSpacing: number): T {
  const out: Rec = { ...patch };
  if ('handleScroll' in out) out.handleScroll = normalizeHandleScroll(out.handleScroll);
  if ('handleScale' in out) out.handleScale = normalizeHandleScale(out.handleScale);
  if (isPlainObject(out.timeScale)) {
    out.timeScale = normalizeRightOffsetPixels({ ...out.timeScale }, barSpacing);
  }
  return out as T;
}

/** A definition's shorthand-expansion hook (candlestick borderColor/wickColor). */
export type NormalizeOptionsHook = (patch: Rec) => void;

/** Derives `precision` from `minMove` when not given explicitly. Runs on every
 *  applyOptions carrying minMove, not only at creation. Mutates `priceFormat`. */
export function normalizePriceFormat(priceFormat: Rec): Rec {
  if (typeof priceFormat.minMove === 'number' && priceFormat.precision === undefined) {
    priceFormat.precision = precisionByMinMove(priceFormat.minMove);
  }
  return priceFormat;
}

/** Returns a new patch (input never mutated). The hook fans out write-only shorthands
 *  and drops them, so `options()` never returns them. */
export function normalizeSeriesPatch<T extends Rec>(patch: T, hook?: NormalizeOptionsHook): T {
  const out: Rec = { ...patch };
  if (isPlainObject(out.priceFormat)) out.priceFormat = normalizePriceFormat({ ...out.priceFormat });
  if (hook) hook(out);
  return out as T;
}

/** A behavior's in-place augmentation of the cloned defaults (timeScale/localization). */
export type AugmentDefaults<G> = (groups: G) => void;

/**
 * Library defaults cloned, then augmented by the behavior. This is the reset target for
 * null leaves, so e.g. `localization.dateFormat: null` restores the augmented value.
 */
export function effectiveDefaults<T extends object, G>(
  libraryDefaults: T,
  augment: AugmentDefaults<G> | undefined,
): T {
  const defaults = cloneOptions(libraryDefaults);
  if (augment) augment(defaults as unknown as G);
  return defaults;
}

/**
 * merge(effectiveDefaults(...), normalize(userPatch)). `barSpacing` is what
 * rightOffsetPixels resolves against. Never aliases the user partial.
 */
export function createChartOptions<T extends object, G>(
  libraryDefaults: T,
  augment: AugmentDefaults<G> | undefined,
  userPatch: DeepPartial<T> | undefined,
  barSpacing: number,
): T {
  const defaults = effectiveDefaults(libraryDefaults, augment);
  if (userPatch === undefined) return defaults;
  const normalized = normalizeChartPatch(userPatch as Rec, barSpacing);
  return mergeOptions(defaults, normalized as DeepPartial<T>, defaults);
}

/** `defaults` must be the same effective defaults used at creation (the null-leaf reset target). */
export function applyChartOptions<T extends object>(
  stored: T,
  defaults: T,
  patch: DeepPartial<T>,
  barSpacing: number,
): T {
  const normalized = normalizeChartPatch(patch as Rec, barSpacing);
  return mergeOptions(stored, normalized as DeepPartial<T>, defaults);
}

/** `libraryDefaults` is the definition's style defaults already merged with the common ones. */
export function createSeriesOptions<T extends object>(
  libraryDefaults: T,
  userPatch: DeepPartial<T> | undefined,
  hook?: NormalizeOptionsHook,
): T {
  const defaults = cloneOptions(libraryDefaults);
  if (userPatch === undefined) return defaults;
  const normalized = normalizeSeriesPatch(userPatch as Rec, hook);
  return mergeOptions(defaults, normalized as DeepPartial<T>, defaults);
}

export function applySeriesOptions<T extends object>(
  stored: T,
  defaults: T,
  patch: DeepPartial<T>,
  hook?: NormalizeOptionsHook,
): T {
  const normalized = normalizeSeriesPatch(patch as Rec, hook);
  return mergeOptions(stored, normalized as DeepPartial<T>, defaults);
}
