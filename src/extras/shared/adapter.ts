// The shared plugin handle: every extras factory wraps its IPrimitive in
// { detach, applyOptions } plus its own methods.
import { mergeOptions, changedPaths } from '../../core';
import type { DeepPartial } from '../../core';
import type { IPrimitive } from '../../api';

/** The attach surface shared by ISeries and IPane. */
export interface PrimitiveTarget {
  attachPrimitive(p: IPrimitive): void;
  detachPrimitive(p: IPrimitive): void;
}

/** The handle every plugin returns: the lifecycle pair plus plugin-specific methods `M`. */
export type PrimitiveAdapter<O, M = unknown> = {
  /** Unregister the primitive from its owner. Idempotent. */
  detach(): void;
  /** Deep-merge a patch over the current options; an unchanged patch is a no-op. */
  applyOptions(patch: DeepPartial<O>): void;
} & M;

export interface PrimitiveAdapterInit<O, M> {
  /** The owning series or pane; the primitive is attached immediately. */
  target: PrimitiveTarget;
  primitive: IPrimitive;
  options: O;
  /** Reset target for a leaf-null patch. */
  defaults: O;
  /** Called by applyOptions only when the merge actually changed the options. */
  onChange(next: O): void;
  methods: M;
  /** Extra teardown run once inside detach, before detachPrimitive. */
  onDetach?(): void;
}

/**
 * Attach the primitive and return its handle. `detach()` runs exactly once;
 * `applyOptions()` only calls `onChange` when the merge changed something.
 */
export function createPrimitiveAdapter<O, M = unknown>(
  init: PrimitiveAdapterInit<O, M>,
): PrimitiveAdapter<O, M> {
  let options = init.options;
  let detached = false;

  init.target.attachPrimitive(init.primitive);

  const handle = {
    ...init.methods,
    detach(): void {
      if (detached) return;
      detached = true;
      init.onDetach?.();
      init.target.detachPrimitive(init.primitive);
    },
    applyOptions(patch: DeepPartial<O>): void {
      const next = mergeOptions(options, patch, init.defaults);
      if (changedPaths(options, next).size === 0) return;
      options = next;
      init.onChange(next);
    },
  } as PrimitiveAdapter<O, M>;

  return handle;
}
