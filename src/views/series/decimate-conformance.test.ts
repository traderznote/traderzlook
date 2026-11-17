// Headless decimation conformance, composed against the stub ColumnRaster fixture.
import { describe, expect, test } from 'vitest';
import { decimateColumns, shouldDecimate } from './decimate';
import { createLineKind } from './line';
import { createCandlestickKind } from './candlestick';
import { itemWindow } from './window';
import { DisplayListBuilder } from '../../gfx';
import type { PolylineCommand } from '../../gfx';
import type { Coordinate } from '../../core';
import {
  AA_TOLERANCE,
  S8_SCENE,
  composeColumns,
  diffColumns,
  fixtureFrame,
  fixtureHorz,
  fixturePrice,
  fixtureStore,
  referenceColumnEnvelope,
  seededWalk,
} from './decimate-conformance.fixture';
import type { StoreDiff } from '../../data';

const REPLACE: StoreDiff = { kind: 'replace' };

/** The non-decimated baseline: a Line kind's convert→emit output. */
function emitLineFull(
  store: ReturnType<typeof fixtureStore>,
  from: number,
  to: number,
  frame: ReturnType<typeof fixtureFrame>,
  horz: ReturnType<typeof fixtureHorz>,
  price: ReturnType<typeof fixturePrice>,
) {
  const kind = createLineKind({ color: '#0af', lineWidth: 1 });
  const buf = kind.createBuffer();
  kind.itemsFromStore(store, REPLACE, buf);
  const w = itemWindow(from, to);
  kind.convert(buf, w, frame, horz, price);
  const b = new DisplayListBuilder();
  kind.emit(buf, w, frame, b);
  return { lists: b.finish(), buf };
}

function emitLineDecimated(
  store: ReturnType<typeof fixtureStore>,
  from: number,
  to: number,
  frame: ReturnType<typeof fixtureFrame>,
  horz: ReturnType<typeof fixtureHorz>,
  price: ReturnType<typeof fixturePrice>,
) {
  const kind = createLineKind({ color: '#0af', lineWidth: 1 });
  const b = new DisplayListBuilder();
  kind.decimate(store, itemWindow(from, to), frame, horz, price, b);
  return b.finish();
}

describe('decimation — bit-identical at barSpacing·hr ≥ 1 (§6.3 / §11.1)', () => {
  // barSpacing·hr = 1 exactly: the threshold is strict `< 1`, so this is the normal path.
  const store = fixtureStore([10, 12, 11, 13, 12], [10, 12, 11, 13, 12]);
  const frame = fixtureFrame(40, 100, 2);
  const horz = fixtureHorz(0.5, 4, 40);

  test('shouldDecimate is false at exactly barSpacing·hr = 1 (strict <)', () => {
    expect(shouldDecimate(0.5, 2)).toBe(false);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    expect(
      decimateColumns(store, itemWindow(0, 5), frame, horz, fixturePrice(), b, { shape: 'line', color: '#0af' }),
    ).toBeNull();
  });

  test('the decimated path equals the full convert→emit path BYTE-FOR-BYTE', () => {
    const price = fixturePrice();
    const full = emitLineFull(store, 0, 5, frame, horz, price);
    const decimated = emitLineDecimated(store, 0, 5, frame, horz, price);

    // The helper returned null, so decimate drew nothing and the engine renders the
    // convert→emit output; the two rasters must then agree exactly.
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
    const rFull = composeColumns(full.lists, deviceWidth);
    const rDecim = composeColumns(decimated, deviceWidth);
    expect(rDecim.touched.some((t) => t === 1)).toBe(false);

    // non-vacuous: the full path actually drew
    expect(rFull.touched.some((t) => t === 1)).toBe(true);

    const full2 = emitLineFull(store, 0, 5, frame, horz, price);
    const rFull2 = composeColumns(full2.lists, deviceWidth);
    expect(diffColumns(rFull, rFull2)).toEqual({ maxDelta: 0, coverageMismatch: 0, firstMismatchCol: -1 });

    const cmdA = full.lists[0]!.commands[0] as PolylineCommand;
    const cmdB = full2.lists[0]!.commands[0] as PolylineCommand;
    expect(Array.from(cmdA.points)).toEqual(Array.from(cmdB.points));
    expect(cmdA.points.length).toBeGreaterThan(0);
  });
});

describe('decimation — one min/max segment per on-screen device column (§6.3 / caps §4.2)', () => {
  test('each touched device column carries exactly one [yTop,yBot] span', () => {
    // 9 rows squeezed into ~5 device columns
    const lows = [10, 14, 11, 9, 13, 12, 15, 8, 16];
    const highs = [12, 16, 13, 11, 15, 14, 17, 10, 18];
    const store = fixtureStore(lows, highs);
    const frame = fixtureFrame(5, 100, 2);
    const horz = fixtureHorz(0.1, 8, 5); // 0.1·2 = 0.2 < 1 → sub-pixel
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(store, itemWindow(0, 9), frame, horz, fixturePrice(), b, {
      shape: 'line',
      color: '#0af',
      lineWidth: 2,
    });
    expect(res).not.toBeNull();
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    // (top, bottom, gap) vertices = 6 floats per column
    expect(cmd.points.length).toBe(res!.columns * 6);
    const raster = composeColumns(b.finish(), Math.ceil(frame.frame.bitmapSize.width));
    let touched = 0;
    for (let c = 0; c < raster.width; c++) if (raster.touched[c]) touched++;
    expect(touched).toBe(res!.columns);
  });

  test('rows mapping OFF the device grid (extended window) are NOT emitted; columns ≤ deviceWidth', () => {
    // The right edge sits at the last row, so the early rows map to x < 0.
    const N = 300;
    const lows: number[] = [];
    const highs: number[] = [];
    for (let i = 0; i < N; i++) {
      lows.push(100 + (i % 7));
      highs.push(110 + (i % 5));
    }
    const store = fixtureStore(lows, highs);
    const deviceWidthMedia = 50;
    const frame = fixtureFrame(deviceWidthMedia, 100, 2);
    const horz = fixtureHorz(deviceWidthMedia / N, N - 1, deviceWidthMedia);
    const b = new DisplayListBuilder();
    b.beginList('bitmap');
    const res = decimateColumns(store, itemWindow(0, N), frame, horz, fixturePrice(), b, {
      shape: 'line',
      color: '#0af',
    });
    expect(res).not.toBeNull();
    expect(res!.rowsScanned).toBe(N);
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);
    expect(res!.columns).toBeLessThanOrEqual(deviceWidth);
    const cmd = b.finish()[0]!.commands[0] as PolylineCommand;
    for (let o = 0; o < cmd.points.length; o += 2) {
      const x = cmd.points[o]!;
      if (Number.isNaN(x)) continue;
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(deviceWidth);
    }
  });
});

describe('decimation — S8 scene ≤ 60 commands, buffer bypassed, hitTest null (§4.4.3 / S8)', () => {
  // A tractable row count: the helper is O(rows), but the cap is on commands, which
  // is bounded by width, not N.
  const N = 4000;
  const line = seededWalk(N, 0x7eadbeef);
  const candle = seededWalk(N, 0x1234abcd);
  const frame = fixtureFrame(S8_SCENE.mediaWidth, S8_SCENE.mediaHeight, S8_SCENE.hr);
  const barSpacing = S8_SCENE.mediaWidth / N;
  const horz = fixtureHorz(barSpacing, N - 1, S8_SCENE.mediaWidth);
  const price = fixturePrice();

  test('barSpacing·hr is sub-pixel (decimation engages) for the S8 scene', () => {
    expect(barSpacing * S8_SCENE.hr).toBeLessThan(1);
    expect(shouldDecimate(barSpacing, S8_SCENE.hr)).toBe(true);
  });

  test('the decimated S8 frame emits ≤ 60 draw commands across both series', () => {
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const candleKind = createCandlestickKind({ upColor: '#26a69a', downColor: '#ef5350' });
    const b = new DisplayListBuilder();
    lineKind.decimate(line, itemWindow(0, N), frame, horz, price, b);
    candleKind.decimate(candle, itemWindow(0, N), frame, horz, price, b);
    const lists = b.finish();
    let commands = 0;
    for (const l of lists) commands += l.commands.length;
    // The cap leaves room for the axis and grid runs a real frame also emits.
    expect(commands).toBeLessThanOrEqual(S8_SCENE.commandCap);
    expect(commands).toBe(2); // exactly one command per decimated series
  });

  test('the decimate path never fills an ItemBuffer (the §6.3 bypass)', () => {
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const buf = lineKind.createBuffer();
    expect(buf.length).toBe(0);
    const b = new DisplayListBuilder();
    lineKind.decimate(line, itemWindow(0, N), frame, horz, price, b);
    expect(buf.length).toBe(0);
  });

  test('hitTest returns null at sub-pixel spacing (buffer empty ⇒ nothing hoverable)', () => {
    // Crosshair values come from store-index lookups, not the ItemBuffer.
    const lineKind = createLineKind({ color: '#0af', lineWidth: 1 });
    const buf = lineKind.createBuffer();
    const candleKind = createCandlestickKind({});
    const cbuf = candleKind.createBuffer();
    expect(lineKind.hitTest(buf, 100 as Coordinate, 100 as Coordinate)).toBeNull();
    expect(candleKind.hitTest(cbuf, 100 as Coordinate, 100 as Coordinate)).toBeNull();
  });
});

describe('decimation — sub-pixel visual parity within AA tolerance (§6.3 / §11.1)', () => {
  test('the decimated min/max envelope matches the overlapping-1px picture per column to ≤ 0.5 device px', () => {
    // Compare against the overlapping-1px-marks envelope, not the connected emit
    // polyline: its slanted cross-column segments paint pixels the marks never did.
    const N = 1200;
    const store = seededWalk(N, 0x7eadbeef);
    const frame = fixtureFrame(300, 200, 2);
    const barSpacing = 300 / N;
    const horz = fixtureHorz(barSpacing, N - 1, 300);
    const price = fixturePrice();
    expect(shouldDecimate(barSpacing, 2)).toBe(true);
    const deviceWidth = Math.ceil(frame.frame.bitmapSize.width);

    const reference = referenceColumnEnvelope(store, 0, N, frame, horz, price);
    const decimated = composeColumns(emitLineDecimated(store, 0, N, frame, horz, price), deviceWidth);

    const diff = diffColumns(reference, decimated);
    expect(diff.coverageMismatch).toBe(0);
    expect(diff.maxDelta).toBeLessThanOrEqual(AA_TOLERANCE);
    // non-vacuous: the picture covers most of the device width
    let touched = 0;
    for (let c = 0; c < decimated.width; c++) if (decimated.touched[c]) touched++;
    expect(touched).toBeGreaterThan(deviceWidth / 2);
  });
});
