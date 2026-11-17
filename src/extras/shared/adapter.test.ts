import { describe, expect, test, vi } from 'vitest';
import type { IPrimitive } from '../../api';
import { createPrimitiveAdapter, type PrimitiveTarget } from './adapter';

function makeTarget(): PrimitiveTarget & { attached: IPrimitive[]; detached: IPrimitive[] } {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    attachPrimitive(p): void {
      attached.push(p);
    },
    detachPrimitive(p): void {
      detached.push(p);
    },
  };
}

// Identity is all the adapter keys on, so an empty object is enough.
const stubPrimitive = (): IPrimitive => ({});

interface Opts {
  color: string;
  size: number;
  shape: { kind: string; outline: boolean };
  ids: number[];
}
const DEFAULTS: Opts = { color: 'red', size: 10, shape: { kind: 'circle', outline: true }, ids: [1, 2] };

describe('extras/shared adapter convention (§12.4 / §2.2)', () => {
  test('construction attaches the primitive to its owner exactly once (§2.2 attach)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
    });
    expect(target.attached).toEqual([primitive]);
    expect(target.detached).toEqual([]);
  });

  test('detach() forwards detachPrimitive(primitive) exactly once; double-detach is a no-op (§2.2)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    const adapter = createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
    });

    adapter.detach();
    expect(target.detached).toEqual([primitive]);
    adapter.detach();
    adapter.detach();
    expect(target.detached).toEqual([primitive]);
  });

  test('onDetach runs exactly once, BEFORE detachPrimitive (§2.2 ordering)', () => {
    const target = makeTarget();
    const primitive = stubPrimitive();
    const order: string[] = [];
    target.detachPrimitive = (p): void => {
      order.push('detachPrimitive');
      target.detached.push(p);
    };
    const adapter = createPrimitiveAdapter({
      target,
      primitive,
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: {},
      onDetach: () => order.push('onDetach'),
    });

    adapter.detach();
    adapter.detach();
    expect(order).toEqual(['onDetach', 'detachPrimitive']);
  });

  test('applyOptions runs the standard §5.1 deep-merge and forwards the merged result to onChange', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { color: 'red', size: 10, shape: { kind: 'circle', outline: true }, ids: [1, 2] },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    const newIds = [9];
    adapter.applyOptions({ size: 42, shape: { kind: 'square' }, ids: newIds });
    expect(onChange).toHaveBeenCalledTimes(1);
    const merged = onChange.mock.calls[0][0];
    expect(merged).toEqual({ color: 'red', size: 42, shape: { kind: 'square', outline: true }, ids: [9] });
    expect(merged.ids).toBe(newIds); // arrays assign by reference, never deep-merged
  });

  test('applyOptions(null leaf) resets that leaf to its effective default (§5.1 law 2)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { color: 'blue', size: 99, shape: { kind: 'square', outline: false }, ids: [7] },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({ color: null });
    expect(onChange.mock.calls[0][0].color).toBe('red');
  });

  test('a no-op patch does NOT invalidate — onChange is not called (§5.1 unchanged = no-op)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({});
    adapter.applyOptions({ size: 10 });
    adapter.applyOptions({ shape: { kind: 'circle' } });
    expect(onChange).not.toHaveBeenCalled();
  });

  test('options are accumulated across applyOptions calls (the adapter holds the live merged state)', () => {
    const target = makeTarget();
    const onChange = vi.fn<(o: Opts) => void>();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange,
      methods: {},
    });

    adapter.applyOptions({ size: 20 });
    adapter.applyOptions({ color: 'green' });
    expect(onChange.mock.calls[1][0]).toEqual({
      color: 'green',
      size: 20,
      shape: { kind: 'circle', outline: true },
      ids: [1, 2],
    });
  });

  test('factory-specific methods are spread onto the returned handle alongside detach/applyOptions', () => {
    const target = makeTarget();
    const setMarkers = vi.fn();
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS },
      defaults: DEFAULTS,
      onChange: () => {},
      methods: { setMarkers, markers: () => [1, 2, 3] },
    });

    expect(typeof adapter.detach).toBe('function');
    expect(typeof adapter.applyOptions).toBe('function');
    expect(typeof adapter.setMarkers).toBe('function');
    adapter.setMarkers('x');
    expect(setMarkers).toHaveBeenCalledWith('x');
    expect(adapter.markers()).toEqual([1, 2, 3]);
  });

  test('user patch is never aliased into stored state (§5.1 law 6 — cloned at the boundary)', () => {
    const target = makeTarget();
    let stored: Opts | null = null;
    const adapter = createPrimitiveAdapter({
      target,
      primitive: stubPrimitive(),
      options: { ...DEFAULTS, shape: { ...DEFAULTS.shape } },
      defaults: DEFAULTS,
      onChange: (o) => {
        stored = o;
      },
      methods: {},
    });

    const patch = { shape: { kind: 'triangle' } };
    adapter.applyOptions(patch);
    patch.shape.kind = 'MUTATED';
    expect((stored as unknown as Opts).shape.kind).toBe('triangle');
  });
});
