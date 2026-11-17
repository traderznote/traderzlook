// Headless: a recording fake PriceLinePort, plus a series-like cache mirroring the wiring.
import { expect, test } from 'vitest';
import type { DeepPartial, DeepReadonly } from '../core';
import { ChartError } from './errors';
import { createPriceLineApi, type PriceLinePort } from './price-line';
import type { IPriceLine, PriceLineOptions } from './series';

interface FakeState {
  disposed: boolean;
  alive: boolean;
  options: PriceLineOptions;
}

function makePort(over: Partial<FakeState> = {}): {
  port: PriceLinePort;
  state: FakeState;
  calls: Record<string, unknown[]>;
} {
  const state: FakeState = {
    disposed: false,
    alive: true,
    options: { price: 100, color: '#FF0000', lineStyle: 'dashed', lineWidth: 1 },
    ...over,
  };
  const calls: Record<string, unknown[]> = {};
  const rec = (name: string, ...args: unknown[]): void => {
    (calls[name] ??= []).push(args);
  };
  const port: PriceLinePort = {
    isDisposed: () => state.disposed,
    isAlive: () => state.alive,
    applyOptions: (p) => {
      rec('applyOptions', p);
      state.options = { ...state.options, ...(p as PriceLineOptions) };
    },
    options: () => ({ ...state.options }) as DeepReadonly<PriceLineOptions>,
  };
  return { port, state, calls };
}

// Stand-in for the series' price-line cache: each line gets its own port state, and
// removePriceLine flips alive=false for good.
function makeSeriesLike(disposedCell: { value: boolean }): {
  createPriceLine(options: PriceLineOptions): IPriceLine;
  priceLines(): readonly IPriceLine[];
  removePriceLine(line: IPriceLine): void;
  stateOf(line: IPriceLine): FakeState | undefined;
} {
  const lines: IPriceLine[] = [];
  const states = new Map<IPriceLine, FakeState>();
  return {
    createPriceLine(options): IPriceLine {
      const { port, state } = makePort({ options });
      const wired: PriceLinePort = { ...port, isDisposed: () => disposedCell.value };
      const handle = createPriceLineApi({ port: wired });
      lines.push(handle);
      states.set(handle, state);
      return handle;
    },
    priceLines: () => lines.slice(),
    removePriceLine(line): void {
      const i = lines.indexOf(line);
      if (i >= 0) lines.splice(i, 1);
      const s = states.get(line);
      if (s) s.alive = false;
    },
    stateOf: (line) => states.get(line),
  };
}

test('applyOptions forwards the patch to the port (§11.1)', () => {
  const { port, calls } = makePort();
  const api = createPriceLineApi({ port });
  const patch: DeepPartial<PriceLineOptions> = { color: '#00FF00', title: 'support' };
  api.applyOptions(patch);
  expect(calls.applyOptions[0][0]).toBe(patch); // forwarded unchanged
});

test('options() returns a fresh snapshot, never the live object (§4.3)', () => {
  const { api } = (() => {
    const { port } = makePort();
    return { api: createPriceLineApi({ port }) };
  })();
  const a = api.options();
  const b = api.options();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
  expect((a as PriceLineOptions).price).toBe(100);
});

test('applyOptions then options() reflects the merged value (§11.1)', () => {
  const { port } = makePort();
  const api = createPriceLineApi({ port });
  api.applyOptions({ color: '#123456' });
  expect((api.options() as PriceLineOptions).color).toBe('#123456');
});

test('createPriceLine returns ONE stable handle; priceLines() lists the SAME object (§2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 50 });
  expect(series.priceLines()).toContain(line);
  expect(series.priceLines()[0]).toBe(series.priceLines()[0]);
  expect(series.priceLines()[0]).toBe(line);
});

test('priceLines() returns a fresh array the caller may mutate (§4.3 / §2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  series.createPriceLine({ price: 1 });
  const a = series.priceLines();
  const b = series.priceLines();
  expect(a).not.toBe(b);
  expect(a).toEqual(b);
});

test('distinct createPriceLine calls yield distinct handles (one per call, §2)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const a = series.createPriceLine({ price: 1 });
  const b = series.createPriceLine({ price: 2 });
  expect(a).not.toBe(b);
});

test('removePriceLine drops the handle from priceLines() (§11.1)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 7 });
  series.removePriceLine(line);
  expect(series.priceLines()).not.toContain(line);
});

test('after removePriceLine every method throws ChartError (dead handle, §11.1)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const line = series.createPriceLine({ price: 7 });
  series.removePriceLine(line);
  expect(series.stateOf(line)?.alive).toBe(false);

  expect(() => line.applyOptions({ color: '#fff' })).toThrow(ChartError);
  expect(() => line.options()).toThrow(ChartError);
});

test('a still-attached line keeps working after a SIBLING line is removed (§2 per-line)', () => {
  const cell = { value: false };
  const series = makeSeriesLike(cell);
  const a = series.createPriceLine({ price: 1 });
  const b = series.createPriceLine({ price: 2 });
  series.removePriceLine(a);
  expect(() => a.options()).toThrow(ChartError);
  expect(() => b.options()).not.toThrow();
  expect((b.options() as PriceLineOptions).price).toBe(2);
});

test('after chart dispose every method throws ChartError("disposed") (§16.5)', () => {
  const { port, state } = makePort();
  const api = createPriceLineApi({ port });
  state.disposed = true;

  for (const call of [() => api.applyOptions({ color: '#fff' }), () => api.options()]) {
    let thrown: unknown;
    try {
      call();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(ChartError);
    expect((thrown as ChartError).code).toBe('disposed');
  }
});

test('disposed wins over a dead line — disposed checked FIRST (§16.5 chart-wide)', () => {
  const { port, state } = makePort({ alive: false });
  const api = createPriceLineApi({ port });
  state.disposed = true;
  let thrown: unknown;
  try {
    api.options();
  } catch (e) {
    thrown = e;
  }
  expect((thrown as ChartError).code).toBe('disposed');
});
