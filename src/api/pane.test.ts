// Headless: a recording PanePort over a small mutable state object. Handle caching
// (panes()[i] === panes()[i]) is chart.ts's job and is not exercised here.
import { describe, expect, test } from 'vitest';
import type { IPrimitive } from '../model';
import { ChartError } from './errors';
import type { SeriesType, SeriesDefinition } from './series-defs';
import {
  createPaneApi,
  type IPriceScaleHandle,
  type ISeriesHandle,
  type PanePort,
} from './pane';

interface PortState {
  disposed: boolean;
  index: number;
  id: string;
  size: { width: number; height: number };
  height: number;
  stretch: number;
  preserve: boolean;
  element: HTMLElement | null;
  /** Left/right are always present; overlays appear and vanish. */
  scales: Map<string, IPriceScaleHandle>;
  seriesHandles: ISeriesHandle[];
}

interface RecordingPort extends PanePort<unknown> {
  state: PortState;
  setHeights: number[];
  setStretches: number[];
  movedTo: number[];
  added: { definition: SeriesDefinition<SeriesType, unknown, unknown>; options: unknown }[];
  attached: IPrimitive[];
  detached: IPrimitive[];
}

function makePort(over?: Partial<PortState>): RecordingPort {
  const state: PortState = {
    disposed: false,
    index: 0,
    id: 'p0',
    size: { width: 800, height: 400 },
    height: 400,
    stretch: 1,
    preserve: false,
    element: null,
    scales: new Map<string, IPriceScaleHandle>([
      ['right', { id: () => 'right' }],
      ['left', { id: () => 'left' }], // present even though visible:false
    ]),
    seriesHandles: [],
    ...over,
  };

  const port: RecordingPort = {
    state,
    setHeights: [],
    setStretches: [],
    movedTo: [],
    added: [],
    attached: [],
    detached: [],

    isDisposed: () => state.disposed,
    index: () => state.index,
    id: () => state.id,
    size: () => state.size,
    height: () => state.height,
    setHeight(px) {
      this.setHeights.push(px);
      state.height = Math.max(30, px); // mimics the model's 30 px floor
    },
    stretchFactor: () => state.stretch,
    setStretchFactor(f) {
      this.setStretches.push(f);
      state.stretch = f;
    },
    moveTo(index) {
      if (index < 0 || index > 3) throw new RangeError(`pane index ${index} out of bounds`);
      this.movedTo.push(index);
      state.index = index;
    },
    series: () => state.seriesHandles.slice(),
    addSeries(definition, options) {
      this.added.push({ definition, options });
      const handle: ISeriesHandle = { seriesType: () => definition.type };
      state.seriesHandles.push(handle);
      return handle;
    },
    priceScale: (id) => state.scales.get(id) ?? null,
    preserveEmptyPane: () => state.preserve,
    setPreserveEmptyPane(keep) {
      state.preserve = keep;
    },
    element: () => state.element,
    attachPrimitive(p) {
      this.attached.push(p);
    },
    detachPrimitive(p) {
      this.detached.push(p);
    },
  };
  return port;
}

const lineDef = { type: 'line' } as unknown as SeriesDefinition<SeriesType, unknown, unknown>;

describe('§2 / §10 priceScale resolution & identity', () => {
  test('left/right always resolve on a live pane regardless of visibility (§10/§11)', () => {
    const pane = createPaneApi(makePort());
    expect(pane.priceScale('right').id()).toBe('right');
    expect(pane.priceScale('left').id()).toBe('left');
  });

  test('priceScale(id) returns the SAME cached handle across calls (=== twice, §2)', () => {
    const pane = createPaneApi(makePort());
    expect(pane.priceScale('right')).toBe(pane.priceScale('right'));
  });

  test('an absent scale id throws ChartError("no-such-scale") at the call (§10/§11)', () => {
    const pane = createPaneApi(makePort());
    expect(() => pane.priceScale('volume')).toThrowError(ChartError);
    try {
      pane.priceScale('volume');
    } catch (e) {
      expect((e as ChartError).code).toBe('no-such-scale');
    }
  });

  test('a destroyed overlay handle dies, and re-creating the id mints a FRESH one (§10)', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    const first: IPriceScaleHandle = { id: () => 'vol' };
    port.state.scales.set('vol', first);
    expect(pane.priceScale('vol')).toBe(first);

    // The last series leaves: the overlay is destroyed.
    port.state.scales.delete('vol');
    expect(() => pane.priceScale('vol')).toThrowError(ChartError);

    const second: IPriceScaleHandle = { id: () => 'vol' };
    port.state.scales.set('vol', second);
    const got = pane.priceScale('vol');
    expect(got).toBe(second);
    expect(got).not.toBe(first);
  });
});

describe('§16.5 disposed guard', () => {
  test('every method throws ChartError("disposed") once the shared flag is set', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    const prim: IPrimitive = {} as IPrimitive;
    port.state.disposed = true;

    const calls: Array<() => unknown> = [
      () => pane.index(),
      () => pane.id(),
      () => pane.size(),
      () => pane.height(),
      () => pane.setHeight(120),
      () => pane.stretchFactor(),
      () => pane.setStretchFactor(2),
      () => pane.moveTo(1),
      () => pane.series(),
      () => pane.priceScale('right'),
      () => pane.addSeries(lineDef),
      () => pane.preserveEmptyPane(),
      () => pane.setPreserveEmptyPane(true),
      () => pane.element(),
      () => pane.attachPrimitive(prim),
      () => pane.detachPrimitive(prim),
    ];
    for (const call of calls) {
      expect(call).toThrowError(ChartError);
      try {
        call();
      } catch (e) {
        expect((e as ChartError).code).toBe('disposed');
      }
    }
  });

  test('the guard fires BEFORE the port is touched (no map-through on a disposed pane)', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    port.state.disposed = true;
    expect(() => pane.setHeight(99)).toThrowError(ChartError);
    expect(port.setHeights).toEqual([]);
  });
});

describe('§11 index vs persistent id', () => {
  test('index() reflects the live position; id() is the stable creation identity', () => {
    const port = makePort({ index: 2, id: 'p0' });
    const pane = createPaneApi(port);
    expect(pane.index()).toBe(2);
    expect(pane.id()).toBe('p0');
  });

  test('moveTo changes index() but NEVER id() (§11)', () => {
    const port = makePort({ index: 0, id: 'p0' });
    const pane = createPaneApi(port);
    pane.moveTo(2);
    expect(port.movedTo).toEqual([2]);
    expect(pane.index()).toBe(2);
    expect(pane.id()).toBe('p0');
  });

  test('moveTo out of bounds throws RangeError (§11/§16.2)', () => {
    const pane = createPaneApi(makePort());
    expect(() => pane.moveTo(99)).toThrowError(RangeError);
    expect(() => pane.moveTo(-1)).toThrowError(RangeError);
  });
});

describe('§11 geometry / stretch / retention', () => {
  test('size() / height() report the plot-area media px from the port', () => {
    const pane = createPaneApi(makePort({ size: { width: 640, height: 300 }, height: 300 }));
    expect(pane.size()).toEqual({ width: 640, height: 300 });
    expect(pane.height()).toBe(300);
  });

  test('setHeight forwards to the model (which owns proportional redistribution + 30px floor)', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    pane.setHeight(250);
    expect(port.setHeights).toEqual([250]);
    expect(pane.height()).toBe(250);
  });

  test('stretchFactor defaults to 1; setStretchFactor forwards', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    expect(pane.stretchFactor()).toBe(1);
    pane.setStretchFactor(2.5);
    expect(port.setStretches).toEqual([2.5]);
    expect(pane.stretchFactor()).toBe(2.5);
  });

  test('preserveEmptyPane is false by default and setPreserveEmptyPane toggles it', () => {
    const pane = createPaneApi(makePort());
    expect(pane.preserveEmptyPane()).toBe(false);
    pane.setPreserveEmptyPane(true);
    expect(pane.preserveEmptyPane()).toBe(true);
  });

  test('element() returns the host pane element (null before mount)', () => {
    const el = { tagName: 'DIV' } as unknown as HTMLElement;
    expect(createPaneApi(makePort()).element()).toBeNull();
    expect(createPaneApi(makePort({ element: el })).element()).toBe(el);
  });
});

describe('§11 series & primitives', () => {
  test('series() returns the pane membership (fresh array, §4.3) keyed to cached handles', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    expect(pane.series()).toEqual([]);
    const handle = pane.addSeries(lineDef);
    const list = pane.series();
    expect(list).toContain(handle);
    expect(pane.series()).not.toBe(list);
  });

  test('addSeries targets THIS pane and forwards the definition + options (§11)', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    const opts = { color: '#abc' };
    pane.addSeries(lineDef, opts);
    expect(port.added).toEqual([{ definition: lineDef, options: opts }]);
  });

  test('attachPrimitive / detachPrimitive forward to the pane-attached registry (§12)', () => {
    const port = makePort();
    const pane = createPaneApi(port);
    const prim: IPrimitive = {} as IPrimitive;
    pane.attachPrimitive(prim);
    pane.detachPrimitive(prim);
    expect(port.attached).toEqual([prim]);
    expect(port.detached).toEqual([prim]);
  });
});
