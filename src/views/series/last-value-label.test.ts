import { describe, expect, test } from 'vitest';
import { createLastValueLabelSource, generateContrastColors } from './last-value-label';
import type { LastValueLabelState } from './last-value-label';
import { ZBand } from '../../gfx';
import type { DisplayList, FontSpec, ITextMeasurer, RectsCommand, TextCommand, ViewFrame } from '../../gfx';

function frame(w = 60, h = 100, hr = 2, vr = 2): ViewFrame {
  return {
    frame: { mediaSize: { width: w, height: h }, bitmapSize: { width: w * hr, height: h * vr }, hr, vr },
    now: 0,
  };
}

/** Text width = 6·chars, ascent 8, descent 2. */
function fakeMeasurer(): ITextMeasurer {
  return { measure: (t: string, _f: FontSpec) => ({ width: t.length * 6, ascent: 8, descent: 2 }) };
}

function mutableProvider(init: LastValueLabelState): {
  provider: () => LastValueLabelState;
  set: (s: LastValueLabelState) => void;
} {
  let cur = init;
  return { provider: () => cur, set: (s) => { cur = s; } };
}

const rectsOf = (lists: readonly DisplayList[]): RectsCommand => {
  for (const l of lists) for (const c of l.commands) if (c.kind === 'rects') return c;
  throw new Error('no rects');
};
const textOf = (lists: readonly DisplayList[]): TextCommand => {
  for (const l of lists) for (const c of l.commands) if (c.kind === 'text') return c;
  throw new Error('no text');
};

// text width 30; #2196f3 has luma ≈ 137 ≤ 160 → white text
const STATE: LastValueLabelState = { y: 30, text: '30.00', color: '#2196f3' };

describe('generateContrastColors — study 06 §4.14 exact spec', () => {
  test('alpha-stripped rgb background; foreground by the NTSC-tweaked luma > 160 rule', () => {
    expect(generateContrastColors('#ffffff')).toEqual({ background: 'rgb(255, 255, 255)', foreground: 'black' });
    expect(generateContrastColors('#000000')).toEqual({ background: 'rgb(0, 0, 0)', foreground: 'white' });
    // .199·33 + .687·150 + .114·243 = 137.319
    expect(generateContrastColors('#2196f3')).toEqual({ background: 'rgb(33, 150, 243)', foreground: 'white' });
  });

  test('the luma > 160 threshold splits dark vs light fills', () => {
    expect(generateContrastColors('#9f9f9f').foreground).toBe('white'); // luma 159
    expect(generateContrastColors('#a1a1a1').foreground).toBe('black'); // luma 161
  });

  test('parses #rgb shorthand, rgb()/rgba() (alpha discarded)', () => {
    expect(generateContrastColors('#fff').background).toBe('rgb(255, 255, 255)');
    expect(generateContrastColors('rgb(33, 150, 243)').background).toBe('rgb(33, 150, 243)');
    expect(generateContrastColors('rgba(0, 0, 0, 0.5)')).toEqual({ background: 'rgb(0, 0, 0)', foreground: 'white' });
  });
});

describe('last-value-label.emit — pill + text (design 03 §8.5 / study 06 §4.14)', () => {
  test('a single media-space list: a rounded rect (raw-color border, contrast fill) then text', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    src.update(frame());
    const lists = src.displayLists();
    expect(lists).toHaveLength(1);
    expect(lists[0]!.space).toBe('media'); // text is only legal in media lists
    expect(lists[0]!.commands[0]!.kind).toBe('rects');
    expect(lists[0]!.commands[1]!.kind).toBe('text');
  });

  test('pill geometry: text box + symmetric padding, right-aligned at the axis edge', () => {
    // pillW = 30 + 2·4 = 38, pillH = 8 + 2 + 2·2 = 14; left = 60 − 38, top = 30 − 7
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    src.update(frame());
    const cmd = rectsOf(src.displayLists());
    expect(Array.from(cmd.coords)).toEqual([22, 23, 38, 14]);
    expect(cmd.radius).toBe(2);
    expect(cmd.runs).toHaveLength(1);
    expect(cmd.runs[0]!.count).toBe(1);
    expect(cmd.runs[0]!.fill).toBe('rgb(33, 150, 243)');
    // the border keeps the raw colour, not the alpha-stripped fill
    expect(cmd.stroke).toEqual({ width: 1, color: '#2196f3' });
  });

  test('text is centered in the pill: x = centerX − width/2, baseline y = cy + (ascent−descent)/2', () => {
    // centerX = 22 + 19 = 41 → x = 41 − 15; y = 30 + (8 − 2)/2
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    src.update(frame());
    const item = textOf(src.displayLists()).items[0]!;
    expect(item.x).toBe(26);
    expect(item.y).toBe(33);
    expect(item.text).toBe('30.00');
    expect(item.color).toBe('white');
  });

  test('the margin pushes the pill left of the axis edge', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer(), { margin: 5 });
    src.update(frame());
    expect(rectsOf(src.displayLists()).coords[0]).toBe(17); // 60 − 5 − 38
  });

  test('a wider surface re-anchors the pill to the new right edge', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    src.update(frame(80));
    expect(rectsOf(src.displayLists()).coords[0]).toBe(42); // 80 − 38
  });
});

describe('last-value-label — render gates', () => {
  test('visible:false emits nothing', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer(), { visible: false });
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('null y (no last value / no data) emits nothing', () => {
    const src = createLastValueLabelSource(() => ({ y: null, text: '', color: '#2196f3' }), fakeMeasurer());
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('empty text emits nothing (no pill for a label with no string)', () => {
    const src = createLastValueLabelSource(() => ({ y: 30, text: '', color: '#2196f3' }), fakeMeasurer());
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('off-pane y (below the surface height in media px) emits nothing', () => {
    const src = createLastValueLabelSource(() => ({ y: 120, text: '99', color: '#2196f3' }), fakeMeasurer());
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });

  test('negative y emits nothing', () => {
    const src = createLastValueLabelSource(() => ({ y: -1, text: '99', color: '#2196f3' }), fakeMeasurer());
    src.update(frame());
    expect(src.displayLists()).toHaveLength(0);
  });
});

describe('last-value-label — SceneSource contract & cache identity', () => {
  test('registers in the Labels z-band (axis back-labels, design 03 §8.5 axis table)', () => {
    expect(createLastValueLabelSource(() => STATE, fakeMeasurer()).zBand).toBe(ZBand.Labels);
  });

  test('a CLEAN re-update returns the byte-identical cached array (no re-emit)', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    const f = frame();
    src.update(f);
    const a = src.displayLists();
    src.update(f);
    expect(src.displayLists()).toBe(a);
  });

  test('a moved coordinate dirties → a NEW array with the new pill top', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createLastValueLabelSource(provider, fakeMeasurer());
    const f = frame();
    src.update(f);
    const a = src.displayLists();
    set({ y: 50, text: '30.00', color: '#2196f3' });
    src.update(f);
    const b = src.displayLists();
    expect(b).not.toBe(a);
    expect(rectsOf(b).coords[1]).toBe(50 - 7);
  });

  test('a text change dirties (width changes → pill re-lays out)', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createLastValueLabelSource(provider, fakeMeasurer());
    const f = frame();
    src.update(f);
    const a = src.displayLists();
    set({ y: 30, text: '100.00', color: '#2196f3' });
    src.update(f);
    const b = src.displayLists();
    expect(b).not.toBe(a);
    expect(rectsOf(b).coords[2]).toBe(36 + 8);
  });

  test('a color change (same y/text) dirties to a fresh array', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createLastValueLabelSource(provider, fakeMeasurer());
    const f = frame();
    src.update(f);
    const a = src.displayLists();
    set({ y: 30, text: '30.00', color: '#ffffff' });
    src.update(f);
    const b = src.displayLists();
    expect(b).not.toBe(a);
    expect(textOf(b).items[0]!.color).toBe('black');
  });

  test('a surface-width change dirties even when state is unchanged', () => {
    const src = createLastValueLabelSource(() => STATE, fakeMeasurer());
    src.update(frame(60));
    const a = src.displayLists();
    src.update(frame(80));
    expect(src.displayLists()).not.toBe(a);
  });

  test('going off-pane dirties to EMPTY, then back on-pane re-emits', () => {
    const { provider, set } = mutableProvider(STATE);
    const src = createLastValueLabelSource(provider, fakeMeasurer());
    const f = frame();
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
    set({ y: 200, text: '30.00', color: '#2196f3' });
    src.update(f);
    expect(src.displayLists()).toHaveLength(0);
    set(STATE);
    src.update(f);
    expect(src.displayLists()).toHaveLength(1);
  });
});
