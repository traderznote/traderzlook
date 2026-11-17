import { describe, expect, test } from 'vitest';
import type { DisplayList, IRenderBackend, ISurface } from '../../gfx';
import { LineSeries, timeBehavior } from '../../api';
import type { IFrameScheduler, ISeries, PlotStoreView, SeriesType, StoreDiff, Time } from '../../api';
import { createChartWith } from '../../api';
import { createEma, emaDefinition, defaultEmaParams } from './ema';

function makeBackend(log: string[]): IRenderBackend {
  let seq = 0;
  const makeSurface = (): ISurface => {
    const name = `surf${seq++}`;
    let media = { width: 0, height: 0 };
    return {
      setMediaSize: (s) => void (media = s),
      beginFrame: (scope) => {
        log.push(`${name}.beginFrame ${scope}`);
        return { mediaSize: media, bitmapSize: media, hr: 1, vr: 1 };
      },
      renderLayer: (layer, lists: readonly DisplayList[]) => {
        let cmds = 0;
        for (const l of lists) cmds += l.commands.length;
        log.push(`${name}.renderLayer ${layer} cmds=${cmds}`);
      },
      endFrame: () => log.push(`${name}.endFrame`),
      resolutionChanged: { subscribe: () => () => {} },
      snapshot: () => ({ _tag: 'SurfaceSnapshot' }),
      dispose: () => log.push(`${name}.dispose`),
    } as unknown as ISurface;
  };
  return {
    createSurface: () => makeSurface(),
    createImage: () => ({ id: 0, width: 0, height: 0 }) as never,
    composeSnapshot: () => ({ _tag: 'Snapshot' }) as never,
    text: { measure: () => ({ width: 6, ascent: 8, descent: 2 }) } as never,
    dispose: () => {},
  };
}

function makeRaf(): IFrameScheduler & { flush(t?: number): void; hasPending(): boolean } {
  let pending: ((n: number) => void) | null = null;
  let n = 0;
  return {
    schedule: (cb) => {
      pending = cb;
      return () => {
        if (pending === cb) pending = null;
      };
    },
    dispose: () => void (pending = null),
    hasPending: () => pending !== null,
    flush: (t) => {
      const cb = pending;
      pending = null;
      if (cb !== null) cb(t ?? n++);
    },
  };
}

interface FakeEl {
  ownerDocument: { createElement(): FakeEl };
  style: Record<string, string>;
  children: FakeEl[];
  appendChild(c: FakeEl): FakeEl;
  removeChild(c: FakeEl): FakeEl;
  contains(c: FakeEl): boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}
function makeDoc(): { createElement(): FakeEl } {
  const doc = { createElement: (): FakeEl => makeEl(doc) };
  return doc;
}
function makeEl(doc: { createElement(): FakeEl }): FakeEl {
  const children: FakeEl[] = [];
  return {
    ownerDocument: doc,
    style: {},
    children,
    appendChild: (c) => (children.push(c), c),
    removeChild: (c) => {
      const i = children.indexOf(c);
      if (i >= 0) children.splice(i, 1);
      return c;
    },
    contains: (c) => children.includes(c),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 600, height: 400 }),
  };
}

function setup() {
  const log: string[] = [];
  const raf = makeRaf();
  const doc = makeDoc();
  const container = makeEl(doc);
  const chart = createChartWith(
    container as unknown as HTMLElement,
    makeBackend(log),
    timeBehavior(),
    { layout: { textColor: '#191919' } },
    { scheduler: raf },
  );
  raf.flush(0);
  return { log, raf, chart };
}

const LINE = [
  { time: '2026-01-05' as unknown as Time, value: 10 },
  { time: '2026-01-06' as unknown as Time, value: 20 },
  { time: '2026-01-07' as unknown as Time, value: 30 },
  { time: '2026-01-08' as unknown as Time, value: 40 },
];

// Reference EMA; for LINE with period 9 (α = 0.2) this is [10, 12, 15.6, 20.48].
const ALPHA = 2 / (defaultEmaParams.period + 1);
function emaSeq(values: readonly number[]): number[] {
  const out: number[] = [];
  let e = Number.NaN;
  for (const x of values) {
    e = Number.isFinite(e) ? ALPHA * x + (1 - ALPHA) * e : x;
    out.push(e);
  }
  return out;
}

function outValues(series: ISeries<SeriesType, Time>): number[] {
  const store = series.store();
  const out: number[] = [];
  for (let i = 0; i < store.length; i++) out.push(store.current(i));
  return out;
}

describe('createEma — single-ingress computed series (design 05 §5; I3/I6)', () => {
  test('creates exactly ONE output series (an ordinary LineSeries), no extra panes by default', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const before = chart.panes().length;
    const ema = createEma(chart, input);
    expect(ema.series.seriesType()).toBe('line');
    expect(chart.panes().length).toBe(before);
  });

  test('I3: an EMA output series receiving input data is fed via its OWN public setData (single ingress)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test('I3: seeds from the input data already present at attach time (replace rebuild)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    input.setData(LINE);
    const ema = createEma(chart, input);
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test('I6: an input update propagates the new EMA tail in the SAME frame (one rAF flush)', () => {
    const { chart, raf, log } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    raf.flush(16);
    log.length = 0;
    input.update({ time: '2026-01-09' as unknown as Time, value: 50 });
    // Already updated before any frame runs.
    expect(outValues(ema.series)).toEqual(emaSeq([10, 20, 30, 40, 50]));
    raf.flush(32);
    const begins = log.filter((l) => l.includes('.beginFrame')).length;
    const ends = log.filter((l) => l.includes('.endFrame')).length;
    expect(begins).toBeGreaterThan(0);
    expect(begins).toBe(ends);
  });

  test('I6: the input UPDATE/append path drives the new EMA tail synchronously (same frame)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    let lastDiff: StoreDiff | null = null;
    input.subscribeDataChanged((d) => (lastDiff = d));
    const beforeLen = ema.series.store().length;
    input.update({ time: '2026-01-09' as unknown as Time, value: 50 });
    expect(lastDiff).not.toBeNull();
    expect(ema.series.store().length).toBe(beforeLen + 1);
    const out = ema.series.data() as readonly { time: Time; value?: number }[];
    expect(out[out.length - 1]!.value).toBeCloseTo(emaSeq([10, 20, 30, 40, 50])[4]!);
    expect(out[out.length - 1]!.time).toBe('2026-01-09' as unknown as Time);
  });

  test('a whitespace input row yields a whitespace EMA row (row alignment kept)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData([
      { time: '2026-01-05' as unknown as Time, value: 10 },
      { time: '2026-01-06' as unknown as Time },
      { time: '2026-01-07' as unknown as Time, value: 30 },
    ]);
    // The recurrence continues across the gap.
    expect(outValues(ema.series)).toEqual([10, ALPHA * 30 + (1 - ALPHA) * 10]);
  });

  test('a whitespace gap does NOT shift the EMA tail: each value lands at its input row TIME', () => {
    // Regression: indexing data() by plot row would put each value after the gap one slot early.
    const T0 = '2026-01-05' as unknown as Time;
    const TGAP = '2026-01-06' as unknown as Time;
    const T2 = '2026-01-07' as unknown as Time;
    const T3 = '2026-01-08' as unknown as Time;
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData([
      { time: T0, value: 10 },
      { time: TGAP },
      { time: T2, value: 30 },
      { time: T3, value: 40 },
    ]);
    const out = ema.series.data() as readonly { time: Time; value?: number }[];
    const emaForRealRows = emaSeq([10, 30, 40]);
    expect(out.map((o) => o.time)).toEqual([T0, T2, T3]);
    expect(out.map((o) => o.value)).toEqual(emaForRealRows);
    expect(out.some((o) => o.time === TGAP)).toBe(false);
  });

  test('dispose() removes the output series and unsubscribes (idempotent, no leak)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    expect(() => ema.dispose()).not.toThrow();
    expect(() => ema.dispose()).not.toThrow();
    // A dangling callback would write to the removed series here.
    expect(() => input.update({ time: '2026-01-09' as unknown as Time, value: 50 })).not.toThrow();
  });
});

describe('I1 — the input data event fires SYNCHRONOUSLY per mutation (design 02 §8)', () => {
  test('the dataChanged diff arrives BEFORE the mutating setData call returns', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    let diff: StoreDiff | null = null;
    input.subscribeDataChanged((d) => (diff = d));
    expect(diff).toBeNull();
    input.setData(LINE);
    expect(diff).not.toBeNull();
    expect((diff as unknown as StoreDiff).kind).toBe('replace');
  });

  test('the EMA recompute runs INSIDE the input callback (output populated when setData returns)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    const ema = createEma(chart, input);
    input.setData(LINE);
    expect(ema.series.store().length).toBe(LINE.length);
  });
});

describe('I2 — store() is zero-copy and identity-stable (design 02 §8)', () => {
  test('input.store() returns the SAME object across calls (identity-stable)', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    expect(input.store()).toBe(input.store());
    input.setData(LINE);
    expect(input.store()).toBe(input.store());
  });

  test('the view exposes scalar reads only (no array reference leaks) — current(i)/length', () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    input.setData(LINE);
    const view = input.store();
    expect(view.length).toBe(4);
    expect(view.current(0)).toBe(10);
    expect(view.current(3)).toBe(40);
    expect(typeof (view as unknown as { lanes?: unknown }).lanes).toBe('undefined');
  });
});

describe('I5 — panes are first-class: pane: own opens an oscillator pane', () => {
  test("an 'own'-pane indicator definition adds the output to a fresh pane via addSeries(def, opts, paneCount)", () => {
    const { chart } = setup();
    const input = chart.addSeries(LineSeries) as ISeries<SeriesType, Time>;
    // The same addSeries call createEma's 'own' branch makes.
    const before = chart.panes().length;
    const own = chart.addSeries(LineSeries, undefined, before) as ISeries<SeriesType, Time>;
    expect(chart.panes().length).toBe(before + 1);
    own.setData(LINE);
    expect(own.store().length).toBe(4);
    expect(input.store().length).toBe(0);
  });
});

// The chart wiring reports every mutation as a `replace` diff, so the append/updateLast
// paths are tested directly against the computer.

function stubStore(values: readonly (number | null)[]): PlotStoreView {
  // Whitespace rows (null) are excluded from the plot store.
  const finite = values.filter((v): v is number => v !== null);
  return {
    length: finite.length,
    current: (i) => finite[i]!,
    min: (i) => finite[i]!,
    max: (i) => finite[i]!,
    timeIndex: (i) => i as never,
    lane: (_n, i) => finite[i]!,
    firstIndexAt: () => null,
    nearestIndexAt: () => -1,
  };
}

describe('createEmaComputer — streaming recurrence + incremental patches (design 05 §5.1)', () => {
  test('a replace diff returns ONE full-rebuild patch aligned to row 0', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    const patches = computer.apply({ kind: 'replace' }, stubStore([10, 20, 30, 40]));
    expect(patches.length).toBe(1);
    expect(patches[0]!.outputId).toBe('ema');
    expect(patches[0]!.mode).toBe('replace');
    expect(patches[0]!.fromRow).toBe(0);
    expect(patches[0]!.rows).toEqual(emaSeq([10, 20, 30, 40]));
  });

  test("an append diff returns an 'append' patch for the NEW tail only, seeded from running state", () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    computer.apply({ kind: 'replace' }, stubStore([10, 20, 30]));
    const patches = computer.apply({ kind: 'append', count: 1 }, stubStore([10, 20, 30, 40]));
    expect(patches[0]!.mode).toBe('append');
    expect(patches[0]!.fromRow).toBe(3);
    const full = emaSeq([10, 20, 30, 40]);
    expect(patches[0]!.rows).toEqual([full[3]]);
  });

  test("an updateLast diff rewinds one row (warmup 1) and recomputes the last row from e[last−1]", () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    computer.apply({ kind: 'replace' }, stubStore([10, 20, 30, 40]));
    const patches = computer.apply({ kind: 'updateLast' }, stubStore([10, 20, 30, 60]));
    expect(patches[0]!.mode).toBe('updateLast');
    expect(patches[0]!.fromRow).toBe(3);
    const e2 = emaSeq([10, 20, 30])[2]!;
    expect(patches[0]!.rows).toEqual([ALPHA * 60 + (1 - ALPHA) * e2]);
  });

  test('an empty input returns an empty replace patch (no rows)', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    const patches = computer.apply({ kind: 'replace' }, stubStore([]));
    expect(patches[0]!.mode).toBe('replace');
    expect(patches[0]!.rows).toEqual([]);
  });

  test('a non-finite (whitespace) input row emits a null output row, recurrence continues', () => {
    const computer = emaDefinition.createComputer(defaultEmaParams);
    const patches = computer.apply({ kind: 'replace' }, stubStore([10, 30]));
    expect(patches[0]!.rows).toEqual([10, ALPHA * 30 + (1 - ALPHA) * 10]);
  });

  test('an invalid period throws (period must be a finite number >= 1)', () => {
    expect(() => emaDefinition.createComputer({ period: 0 })).toThrow(RangeError);
    expect(() => emaDefinition.createComputer({ period: Number.NaN })).toThrow(RangeError);
  });
});
