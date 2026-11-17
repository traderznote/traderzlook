// Backend conformance fixtures: plain gfx command streams, so any render backend can replay them.
import { LineStyle } from '../../src/gfx';
import type { DisplayList } from '../../src/gfx';

export interface Fixture {
  readonly name: string;
  readonly mediaSize: { width: number; height: number };
  readonly dpr: number;
  /** Base-layer display lists, in z-order. */
  readonly base: readonly DisplayList[];
}

// F0: rects runs, a dashed polyline and text across both coordinate spaces.
function f0(): Fixture {
  const dpr = 2;
  const W = 200;
  const H = 100;
  const background: DisplayList = {
    space: 'bitmap',
    commands: [{ kind: 'rects', coords: new Float32Array([0, 0, W * dpr, H * dpr]), runs: [{ count: 1, fill: '#101418' }] }],
  };
  const bars: DisplayList = {
    space: 'bitmap',
    commands: [
      {
        kind: 'rects',
        coords: new Float32Array([
          40, 120, 16, 60, //
          90, 80, 16, 100, //
          140, 140, 16, 40,
        ]),
        runs: [
          { count: 2, fill: '#26a69a' },
          { count: 1, fill: '#ef5350' },
        ],
      },
    ],
  };
  const line: DisplayList = {
    space: 'bitmap',
    commands: [
      {
        kind: 'polyline',
        points: new Float32Array([20, 60, 80, 40, 140, 90, 200, 30, 280, 70, 380, 50]),
        runs: [{ count: 6, fill: '#ffd54f' }],
        width: 2,
        style: LineStyle.Dashed,
        join: 'round',
      },
    ],
  };
  const label: DisplayList = {
    space: 'media',
    commands: [
      {
        kind: 'text',
        items: [{ x: 8, y: 18, text: 'F0 scene', font: { family: 'Arial, sans-serif', size: 13, weight: 'bold' }, color: '#e0e0e0' }],
      },
    ],
  };
  return { name: 'F0-primitives', mediaSize: { width: W, height: H }, dpr, base: [background, bars, line, label] };
}

// F1: grid, candles and a rounded, stroked axis pill with text.
function f1(): Fixture {
  const dpr = 2;
  const W = 320;
  const H = 180;
  const background: DisplayList = {
    space: 'bitmap',
    commands: [{ kind: 'rects', coords: new Float32Array([0, 0, W * dpr, H * dpr]), runs: [{ count: 1, fill: '#0e1117' }] }],
  };
  // NaN pairs split the single polyline into separate grid lines.
  const gridPts: number[] = [];
  for (const gx of [80, 160, 240]) {
    gridPts.push(gx * dpr, 0, gx * dpr, H * dpr, NaN, NaN);
  }
  for (const gy of [60, 120]) {
    gridPts.push(0, gy * dpr, W * dpr, gy * dpr, NaN, NaN);
  }
  const grid: DisplayList = {
    space: 'bitmap',
    commands: [
      {
        kind: 'polyline',
        points: new Float32Array(gridPts),
        runs: [{ count: gridPts.length / 2, fill: '#1e2530' }],
        width: 1,
        style: LineStyle.Dotted,
        join: 'miter',
      },
    ],
  };
  const cx = [60, 110, 160, 210, 260];
  const wickCoords: number[] = [];
  const bodyCoords: number[] = [];
  const bodyH = [[70, 120], [60, 100], [90, 150], [50, 90], [80, 140]];
  const wickH = [[55, 135], [45, 115], [75, 165], [35, 105], [65, 155]];
  for (let i = 0; i < cx.length; i++) {
    const x = cx[i] * dpr;
    wickCoords.push(x - 1, wickH[i][0] * dpr, 2, (wickH[i][1] - wickH[i][0]) * dpr);
    bodyCoords.push((cx[i] - 9) * dpr, bodyH[i][0] * dpr, 18 * dpr, (bodyH[i][1] - bodyH[i][0]) * dpr);
  }
  const up = '#26a69a';
  const down = '#ef5350';
  const runColors = [up, down, up, up, down];
  const colorRuns = runColors.map((fill) => ({ count: 1, fill }));
  const wicks: DisplayList = {
    space: 'bitmap',
    commands: [{ kind: 'rects', coords: new Float32Array(wickCoords), runs: colorRuns }],
  };
  const bodies: DisplayList = {
    space: 'bitmap',
    commands: [{ kind: 'rects', coords: new Float32Array(bodyCoords), runs: colorRuns }],
  };
  // The pill rect is inset by half a pixel so its stroke stays inside.
  const pill: DisplayList = {
    space: 'bitmap',
    commands: [
      {
        kind: 'rects',
        coords: new Float32Array([(W - 60) * dpr + 0.5, 80 * dpr + 0.5, 56 * dpr - 1, 18 * dpr - 1]),
        runs: [{ count: 1, fill: '#26a69a' }],
        radius: 3 * dpr,
        stroke: { width: 1, color: '#0e1117' },
      },
    ],
  };
  const pillText: DisplayList = {
    space: 'media',
    commands: [
      {
        kind: 'text',
        items: [{ x: W - 54, y: 93, text: '142.50', font: { family: 'Arial, sans-serif', size: 11 }, color: '#0e1117' }],
      },
    ],
  };
  return {
    name: 'F1-candles',
    mediaSize: { width: W, height: H },
    dpr,
    base: [background, grid, wicks, bodies, pill, pillText],
  };
}

export const fixtures: readonly Fixture[] = [f0(), f1()];
