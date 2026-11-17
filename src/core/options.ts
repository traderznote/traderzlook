/** `null` is allowed only at primitive leaves and means "reset to default". */
export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[]
    ? T[K]
    : T[K] extends (...args: never[]) => unknown
      ? T[K]
      : T[K] extends object
        ? DeepPartial<T[K]>
        : T[K] | null;
};

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer U)[]
    ? ReadonlyArray<DeepReadonly<U>>
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T;

const POLLUTION_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

// Deep-copies plain objects so merge results never alias the base/defaults graph.
function clonePlain<T>(value: T): T {
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(value)) out[k] = clonePlain(value[k]);
    return out as T;
  }
  return value;
}

function mergeInto(
  base: Record<string, unknown>,
  patch: Record<string, unknown>,
  defaults: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(base)) out[k] = clonePlain(base[k]);

  for (const k of Object.keys(patch)) {
    if (POLLUTION_KEYS.has(k)) {
      throw new Error(`mergeOptions: refusing prototype-pollution key "${k}"`);
    }
    const pv = patch[k];
    if (pv === undefined) continue;
    if (pv === null) {
      out[k] = clonePlain(defaults[k]);
      continue;
    }
    if (isPlainObject(pv)) {
      const bv = isPlainObject(base[k]) ? base[k] : {};
      const dv = isPlainObject(defaults[k]) ? defaults[k] : {};
      out[k] = mergeInto(bv, pv, dv);
    } else {
      out[k] = pv;
    }
  }
  return out;
}

/** Returns a new object and never mutates its inputs (safe on frozen objects). */
export function mergeOptions<T>(base: T, patch: DeepPartial<T>, defaults: T): T {
  return mergeInto(
    base as Record<string, unknown>,
    patch as Record<string, unknown>,
    defaults as Record<string, unknown>,
  ) as T;
}

function diff(before: unknown, after: unknown, prefix: string, out: Set<string>): void {
  if (isPlainObject(before) && isPlainObject(after)) {
    for (const k of new Set([...Object.keys(before), ...Object.keys(after)])) {
      diff(before[k], after[k], prefix ? `${prefix}.${k}` : k, out);
    }
    return;
  }
  if (!Object.is(before, after)) out.add(prefix);
}

/** Dot-paths of changed leaves; arrays, functions and instances compare by reference. */
export function changedPaths(before: unknown, after: unknown): ReadonlySet<string> {
  const out = new Set<string>();
  diff(before, after, '', out);
  return out;
}
