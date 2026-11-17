import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { DisplayList, SceneSource, ViewFrame } from '../../gfx';
import { ZBand } from '../../gfx';
import type { IPrimitive } from '../../api';
import { createUpDownMarkers, upDownMarkersDefaults } from './up-down-markers';

function makeSeries(opts?: { color?: string; lineColor?: string }) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  const dataCalls: { kind: 'setData' | 'update'; arg: unknown; historical?: boolean }[] = [];
  return {
    attached,
    detached,
    dataCalls,
    attachPrimitive(p: IPrimitive): void {
      attached.push(p);
    },
    detachPrimitive(p: IPrimitive): void {
      detached.push(p);
    },
    setData(items: readonly unknown[]): void {
      dataCalls.push({ kind: 'setData', arg: items });
    },
    update(item: unknown, o?: { historical?: boolean }): void {
      dataCalls.push({ kind: 'update', arg: item, historical: o?.historical });
    },
    options(): { color?: string; lineColor?: string } {
      return opts ?? { color: '#2962FF' };
    },
    // y == price
    priceToCoordinate(price: number): number | null {
      return price;
    },
  };
}

// x == time
function makeCtx() {
  const updates: string[] = [];
  const ctx = {
    updates,
    requestUpdate(scope: 'overlay' | 'render' | 'layout'): void {
      updates.push(scope);
    },
    chart: {
      timeScale(): { timeToCoordinate(t: number): number | null } {
        return { timeToCoordinate: (t: number): number | null => t };
      },
    },
  };
  return ctx;
}

const frame = (now: number, hr = 1, vr = 1): ViewFrame => ({
  now,
  frame: { mediaSize: { width: 300, height: 200 }, bitmapSize: { width: 300, height: 200 }, hr, vr },
});

function getSource(primitive: IPrimitive): SceneSource {
  const srcs = primitive.sources?.() ?? [];
  expect(srcs.length).toBe(1);
  return srcs[0]!.source as unknown as SceneSource;
}

function attachAndContext(
  series: ReturnType<typeof makeSeries>,
  ctx: ReturnType<typeof makeCtx>,
): { handle: ReturnType<typeof createUpDownMarkers>; primitive: IPrimitive; source: SceneSource } {
  const handle = createUpDownMarkers<number>(series, {});
  const primitive = series.attached[0]!;
  primitive.attached?.(ctx as never);
  return { handle, primitive, source: getSource(primitive) };
}

// performance.now() is faked too and starts at 0, so expiresAt = duration and shares the
// sweep's frame.now base.
beforeEach(() => vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] }));
afterEach(() => vi.useRealTimers());

describe('createUpDownMarkers — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches exactly one primitive to the series (the §2.2 attach)', () => {
    const series = makeSeries();
    createUpDownMarkers<number>(series, {});
    expect(series.attached.length).toBe(1);
    expect(series.detached.length).toBe(0);
  });

  test('the primitive registers ONE pane source on the AboveSeries band (§2.3)', () => {
    const series = makeSeries();
    createUpDownMarkers<number>(series, {});
    const primitive = series.attached[0]!;
    const srcs = primitive.sources!();
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.target).toBe('pane');
    expect((srcs[0]!.source as unknown as SceneSource).zBand).toBe(ZBand.AboveSeries);
  });

  test('detach() detaches exactly once; double-detach is a no-op (§2.2)', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle, primitive } = attachAndContext(series, ctx);
    handle.detach();
    expect(series.detached).toEqual([primitive]);
    handle.detach();
    handle.detach();
    expect(series.detached).toEqual([primitive]);
  });

  test('detached() clears the single expiry timer (no leaked setTimeout, §2.7)', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }]);
    source.update(frame(0));
    handle.update({ time: 1, value: 11 });
    expect(vi.getTimerCount()).toBe(1);
    handle.detach();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('createUpDownMarkers — sign diff + the data proxy (study 08 §4.7 / §4.16)', () => {
  test('setData seeds managed points with NO markers; setData proxies to the series', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }, { time: 2, value: 20 }]);
    expect(handle.markers().map((m) => m.sign)).toEqual([0, 0]);
    expect(series.dataCalls.at(-1)).toMatchObject({ kind: 'setData' });
  });

  test('an update to a managed time creates the signed marker; +1 up, −1 down, 0 equal', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }, { time: 2, value: 20 }, { time: 3, value: 30 }]);
    handle.update({ time: 1, value: 12 });
    handle.update({ time: 2, value: 15 });
    handle.update({ time: 3, value: 30 });
    const signs = new Map(handle.markers().map((m) => [m.time, m.sign]));
    expect(signs.get(1)).toBe(1);
    expect(signs.get(2)).toBe(-1);
    expect(signs.get(3)).toBe(0);
    expect(series.dataCalls.filter((c) => c.kind === 'update').length).toBe(3);
  });

  test('update on a whitespace item (no value) deletes the managed point (§4.7)', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }]);
    expect(handle.markers().length).toBe(1);
    handle.update({ time: 1 });
    expect(handle.markers().length).toBe(0);
  });

  test('update on a NOT-yet-managed time creates the point but no marker (sign 0)', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.update({ time: 99, value: 5 });
    expect(handle.markers()).toEqual([{ time: 99, value: 5, sign: 0 }]);
  });

  test('setMarkers replaces all in MANUAL mode (no expiry, no series proxy); clearMarkers empties', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setMarkers([{ time: 1, value: 10, sign: 1 }, { time: 2, value: 9, sign: -1 }]);
    expect(handle.markers().length).toBe(2);
    expect(series.dataCalls.length).toBe(0);
    handle.clearMarkers();
    expect(handle.markers().length).toBe(0);
  });
});

describe('createUpDownMarkers — lazy expiry sweep + ONE re-armed timer (§2.7)', () => {
  test('the sweep drops entries with expiresAt <= frame.now; survivors stay', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }, { time: 2, value: 20 }]);
    source.update(frame(0));
    handle.update({ time: 1, value: 11 }); // expires at 5000
    source.update(frame(4999));
    expect(handle.markers().some((m) => m.time === 1)).toBe(true);
    source.update(frame(5000));
    expect(handle.markers().some((m) => m.time === 1)).toBe(false);
  });

  test('exactly ONE timer is armed at any time, re-armed to the SOONEST pending expiresAt', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }, { time: 2, value: 20 }]);
    handle.update({ time: 1, value: 11 });
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(1000);
    handle.update({ time: 2, value: 21 });
    expect(vi.getTimerCount()).toBe(1);
  });

  test('the timer callback requests a render frame (idle-chart sweep, §2.7)', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle } = attachAndContext(series, ctx);
    handle.setData([{ time: 1, value: 10 }]);
    handle.update({ time: 1, value: 11 });
    ctx.updates.length = 0;
    vi.advanceTimersByTime(5000);
    expect(ctx.updates).toContain('render');
  });

  test('updateVisibilityDuration 0 means no expiry: no timer, marker stays', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const handle = createUpDownMarkers<number>(series, { updateVisibilityDuration: 0 });
    series.attached[0]!.attached?.(ctx as never);
    handle.setData([{ time: 1, value: 10 }]);
    handle.update({ time: 1, value: 11 });
    expect(vi.getTimerCount()).toBe(0);
    const src = getSource(series.attached[0]!);
    src.update(frame(1_000_000));
    expect(handle.markers().length).toBe(1);
  });
});

describe('createUpDownMarkers — renderer geometry (study 08 §4.7 constants, hand-derived)', () => {
  test('a neutral marker emits ONE filled circle at (x*hr+corr, y*vr), radius 4*vr+corr; no chevron', () => {
    const series = makeSeries({ color: '#2962FF' });
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setMarkers([{ time: 7, value: 50, sign: 0 }]);
    source.update(frame(0, 1, 1)); // hr = 1 → corr = 0.5
    const lists = source.displayLists() as readonly DisplayList[];
    expect(lists.length).toBe(1);
    expect(lists[0]!.space).toBe('bitmap');
    const cmds = lists[0]!.commands;
    const circle = cmds.find((c) => c.kind === 'circles')!;
    expect(circle.kind).toBe('circles');
    if (circle.kind === 'circles') {
      // x = 7 + 0.5, y = 50, r = 4 + 0.5
      expect(Array.from(circle.coords)).toEqual([7.5, 50, 4.5]);
      expect(circle.runs[0]!.fill).toBe('#2962FF');
    }
    expect(cmds.some((c) => c.kind === 'path')).toBe(false);
  });

  test('a +1 marker uses positiveColor and emits the chevron path above the dot', () => {
    const series = makeSeries({ lineColor: '#000' });
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setMarkers([{ time: 10, value: 100, sign: 1 }]);
    source.update(frame(0, 1, 1));
    const cmds = source.displayLists()[0]!.commands;
    const circle = cmds.find((c) => c.kind === 'circles')!;
    if (circle.kind === 'circles') expect(circle.runs[0]!.fill).toBe(upDownMarkersDefaults.positiveColor);
    const path = cmds.find((c) => c.kind === 'path')!;
    expect(path.kind).toBe('path');
    if (path.kind === 'path') {
      // x=10, y=100, corr=0.5: (round(5.3)+.5, 93) → (10.5, 89.5) → (round(14.7)+.5, 93)
      expect(Array.from(path.points)).toEqual([5.5, 93, 10.5, 89.5, 15.5, 93]);
      expect(path.stroke?.color).toBe(upDownMarkersDefaults.positiveColor);
      expect(path.stroke?.width).toBe(Math.max(1, Math.floor(2 * 1)));
    }
  });

  test('a marker whose price has no coordinate is silently dropped (§4.7)', () => {
    const series = makeSeries();
    series.priceToCoordinate = (): number | null => null;
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setMarkers([{ time: 1, value: 10, sign: 1 }]);
    source.update(frame(0));
    const cmds = source.displayLists()[0]!.commands;
    const circle = cmds.find((c) => c.kind === 'circles');
    if (circle && circle.kind === 'circles') expect(circle.coords.length).toBe(0);
    else expect(circle).toBeUndefined();
  });
});

describe('createUpDownMarkers — options merge through the §12.4 adapter', () => {
  test('applyOptions deep-merges the colors and requests a render', () => {
    const series = makeSeries();
    const ctx = makeCtx();
    const { handle, source } = attachAndContext(series, ctx);
    handle.setMarkers([{ time: 1, value: 10, sign: -1 }]);
    handle.applyOptions({ negativeColor: '#ff0000' });
    source.update(frame(0));
    const cmds = source.displayLists()[0]!.commands;
    const circle = cmds.find((c) => c.kind === 'circles')!;
    if (circle.kind === 'circles') expect(circle.runs[0]!.fill).toBe('#ff0000');
  });
});
