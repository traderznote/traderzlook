// Markers must reach the pane: they position themselves through series.priceToCoordinate and
// series.dataByIndex, which returned null before the join layer was fixed.
import { expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../../gfx';
import type { Time } from '../../api';
import { CandlestickSeries, createChartWith, timeBehavior } from '../../api';
import { createSeriesMarkers } from './series-markers';

test('series markers draw on the pane', () => {
  const lists: DisplayList[][] = [];
  const backend: IRenderBackend = {
    createSurface: () => {
      let size = { width: 0, height: 0 };
      const mine: DisplayList[] = [];
      lists.push(mine);
      return {
        setMediaSize: (s: { width: number; height: number }) => void (size = s),
        beginFrame: () => ({ mediaSize: size, bitmapSize: size, hr: 1, vr: 1 }),
        renderLayer: (layer: string, ls: readonly DisplayList[]) => {
          if (layer === 'base') mine.splice(0, mine.length, ...ls);
        },
        endFrame: () => {},
        resolutionChanged: { subscribe: () => () => {} },
        snapshot: () => ({}),
        dispose: () => {},
      } as unknown as ISurface;
    },
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({}) as never,
    text: { measure: (t: string) => ({ width: 6 * t.length, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
  let pending: ((t: number) => void)[] = [];
  const flush = (): void => {
    for (let i = 0; i < 5 && pending.length > 0; i++) {
      const run = pending;
      pending = [];
      for (const cb of run) cb(i);
    }
  };
  const el = (): unknown => ({
    ownerDocument: { createElement: el },
    style: {},
    appendChild: (c: unknown) => c,
    removeChild: (c: unknown) => c,
    contains: () => true,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  });
  const chart = createChartWith(el() as HTMLElement, backend, timeBehavior(), {}, {
    scheduler: { schedule: (cb) => (pending.push(cb), () => {}), dispose: () => {} },
  });
  const s = chart.addSeries(CandlestickSeries);
  const bars = Array.from({ length: 20 }, (_, i) => ({
    time: (1767225600 + i * 86400) as Time,
    open: 10,
    high: 12,
    low: 9,
    close: 11,
  }));
  s.setData(bars);
  const count = (): number => lists.flat().reduce((n, l) => n + l.commands.length, 0);
  chart.timeScale().fitContent();
  flush();
  const without = count();
  createSeriesMarkers(chart, s as never, [
    { time: bars[5]!.time, position: 'belowBar', color: '#0000ff', shape: 'arrowUp', text: 'BUY' },
  ] as never);
  flush();
  expect(count()).toBeGreaterThan(without);
  expect(JSON.stringify(lists)).toContain('#0000ff');
});
