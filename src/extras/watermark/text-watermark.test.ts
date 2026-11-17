// Expected positions use the plugin's width estimate (len × fontSize × 0.6) and ascent
// (fontSize × 0.8).
import { describe, expect, test } from 'vitest';
import { ZBand } from '../../gfx';
import type { DisplayList, SceneSource, TextCommand, ViewFrame } from '../../gfx';
import type { IPrimitive } from '../../api';
import { createTextWatermark, textWatermarkDefaults } from './text-watermark';

function makePane(width = 600, height = 400) {
  const attached: IPrimitive[] = [];
  const detached: IPrimitive[] = [];
  return {
    attached,
    detached,
    width,
    height,
    size(): { width: number; height: number } {
      return { width: this.width, height: this.height };
    },
    attachPrimitive(p: IPrimitive): void {
      attached.push(p);
    },
    detachPrimitive(p: IPrimitive): void {
      detached.push(p);
    },
  };
}

function makeCtx(pane: ReturnType<typeof makePane>) {
  const updates: string[] = [];
  return {
    updates,
    requestUpdate(scope: 'overlay' | 'render' | 'layout'): void {
      updates.push(scope);
    },
    pane: { size: () => pane.size() },
  };
}

const frame = (): ViewFrame => ({
  now: 0,
  frame: { mediaSize: { width: 600, height: 400 }, bitmapSize: { width: 600, height: 400 }, hr: 1, vr: 1 },
});

function getSource(primitive: IPrimitive): SceneSource {
  const srcs = primitive.sources?.() ?? [];
  expect(srcs.length).toBe(1);
  return srcs[0]!.source as unknown as SceneSource;
}

function attach(
  pane: ReturnType<typeof makePane>,
  ctx: ReturnType<typeof makeCtx>,
  opts?: Parameters<typeof createTextWatermark>[1],
): { handle: ReturnType<typeof createTextWatermark>; primitive: IPrimitive; source: SceneSource } {
  const handle = createTextWatermark(pane, opts);
  const primitive = pane.attached[0]!;
  primitive.attached?.(ctx as never);
  return { handle, primitive, source: getSource(primitive) };
}

function textItems(source: SceneSource): TextCommand['items'] {
  const lists = source.displayLists() as readonly DisplayList[];
  if (lists.length === 0) return [];
  expect(lists[0]!.space).toBe('media');
  const cmd = lists[0]!.commands.find((c) => c.kind === 'text') as TextCommand | undefined;
  return cmd?.items ?? [];
}

describe('createTextWatermark — lifecycle (design 05 §2.2 / §2.7)', () => {
  test('construction attaches exactly one primitive to the pane (the §2.2 attach)', () => {
    const pane = makePane();
    createTextWatermark(pane);
    expect(pane.attached.length).toBe(1);
    expect(pane.detached.length).toBe(0);
  });

  test('the primitive registers ONE pane source on the BelowSeries band (§2.7 item 3)', () => {
    const pane = makePane();
    createTextWatermark(pane, { lines: [{ text: 'X', color: '#000', fontSize: 12 }] });
    const primitive = pane.attached[0]!;
    const srcs = primitive.sources!();
    expect(srcs.length).toBe(1);
    expect(srcs[0]!.target).toBe('pane');
    expect((srcs[0]!.source as unknown as SceneSource).zBand).toBe(ZBand.BelowSeries);
  });

  test('detach() detaches exactly once; double-detach is a no-op (§2.2)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { handle, primitive } = attach(pane, ctx);
    handle.detach();
    expect(pane.detached).toEqual([primitive]);
    handle.detach();
    handle.detach();
    expect(pane.detached).toEqual([primitive]);
  });

  test('detached() drops the captured context (auto-detach lifecycle, §2.2)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { handle, primitive } = attach(pane, ctx, {
      lines: [{ text: 'X', color: '#000', fontSize: 12 }],
    });
    primitive.detached?.();
    ctx.updates.length = 0;
    handle.applyOptions({ visible: false });
    expect(ctx.updates).toEqual([]);
  });
});

describe('createTextWatermark — defaults + visibility', () => {
  test('default options are visible center/center with no lines (study 08 §4.5)', () => {
    expect(textWatermarkDefaults).toEqual({
      visible: true,
      horzAlign: 'center',
      vertAlign: 'center',
      lines: [],
    });
  });

  test('no lines → nothing drawn (empty display list)', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx);
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('visible:false → nothing drawn even with lines', () => {
    const pane = makePane();
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      visible: false,
      lines: [{ text: 'HIDDEN', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('a zero-size pane draws nothing (study 08 §4.5 guard)', () => {
    const pane = makePane(0, 0);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      lines: [{ text: 'X', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });
});

describe('createTextWatermark — §4.5 layout (hand-derived; w = len·fontSize·0.6)', () => {
  test('a single center/center line is centered with the right baseline', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      lines: [{ text: 'ABC', color: '#ff0000', fontSize: 48 }],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(1);
    // w = 86.4, lineHeight = 57.6, top = (400 − 57.6)/2 = 171.2
    // x = 300 − 43.2 = 256.8, y = 171.2 + 38.4 = 209.6
    expect(items[0]!.x).toBeCloseTo(256.8, 5);
    expect(items[0]!.y).toBeCloseTo(209.6, 5);
    expect(items[0]!.font.size).toBeCloseTo(48, 5);
    expect(items[0]!.color).toBe('#ff0000');
  });

  test("horzAlign 'left' anchors at lineHeight/2; 'right' uses width − 1 − lineHeight/2 − w", () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const left = attach(pane, ctx, {
      horzAlign: 'left',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    left.source.update(frame());
    // 57.6 / 2
    expect(textItems(left.source)[0]!.x).toBeCloseTo(28.8, 5);

    const pane2 = makePane(600, 400);
    const ctx2 = makeCtx(pane2);
    const right = attach(pane2, ctx2, {
      horzAlign: 'right',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    right.source.update(frame());
    // 600 − 1 − 28.8 − 86.4
    expect(textItems(right.source)[0]!.x).toBeCloseTo(483.8, 5);
  });

  test("vertAlign 'top' starts at 0; 'bottom' anchors total height to the bottom", () => {
    const pane = makePane(600, 400);
    const ctxTop = makeCtx(pane);
    const top = attach(pane, ctxTop, {
      vertAlign: 'top',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    top.source.update(frame());
    expect(textItems(top.source)[0]!.y).toBeCloseTo(38.4, 5);

    const pane2 = makePane(600, 400);
    const ctxBot = makeCtx(pane2);
    const bottom = attach(pane2, ctxBot, {
      vertAlign: 'bottom',
      lines: [{ text: 'ABC', color: '#000', fontSize: 48 }],
    });
    bottom.source.update(frame());
    // (400 − 57.6) + 38.4
    expect(textItems(bottom.source)[0]!.y).toBeCloseTo(380.8, 5);
  });

  test('multiple lines stack by line height (top-aligned, hand-derived)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      vertAlign: 'top',
      horzAlign: 'left',
      lines: [
        { text: 'AB', color: '#111', fontSize: 20 },
        { text: 'CD', color: '#222', fontSize: 30 },
      ],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(2);
    // Line 1: lineHeight 24, y = 16, x = 12.
    expect(items[0]!.y).toBeCloseTo(16, 5);
    expect(items[0]!.x).toBeCloseTo(12, 5);
    // Line 2 starts at 24: y = 24 + 24 = 48, x = 36/2 = 18.
    expect(items[1]!.y).toBeCloseTo(48, 5);
    expect(items[1]!.x).toBeCloseTo(18, 5);
  });

  test('a line wider than the pane SHRINKS (zoom < 1); a fitting line never enlarges', () => {
    const pane = makePane(60, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      horzAlign: 'center',
      vertAlign: 'top',
      lines: [{ text: 'WIDE', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    const items = textItems(source);
    const zoom = 60 / (4 * 48 * 0.6);
    expect(items[0]!.font.size).toBeCloseTo(48 * zoom, 5);
    // The shrunk line exactly fills the pane.
    expect(items[0]!.x).toBeCloseTo(0, 5);
  });

  test('an empty-text line contributes its height but emits no text item (study 08 §4.5)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { source } = attach(pane, ctx, {
      vertAlign: 'top',
      horzAlign: 'left',
      lines: [
        { text: '', color: '#000', fontSize: 20 },
        { text: 'XY', color: '#000', fontSize: 20 },
      ],
    });
    source.update(frame());
    const items = textItems(source);
    expect(items.length).toBe(1);
    // After the empty line's 24px: 24 + 16.
    expect(items[0]!.y).toBeCloseTo(40, 5);
  });
});

describe('createTextWatermark — applyOptions live-update through the §12.4 adapter', () => {
  test('applyOptions replaces lines and re-lays out; requests a Render frame', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle, source } = attach(pane, ctx, {
      lines: [{ text: 'OLD', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(textItems(source)[0]!.color).toBe('#000');

    ctx.updates.length = 0;
    handle.applyOptions({ lines: [{ text: 'NEW', color: '#abcabc', fontSize: 48 }] });
    expect(ctx.updates).toContain('render');
    source.update(frame());
    expect(textItems(source)[0]!.color).toBe('#abcabc');
  });

  test('toggling visible:false through applyOptions clears the drawn text', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle, source } = attach(pane, ctx, {
      lines: [{ text: 'SHOW', color: '#000', fontSize: 48 }],
    });
    source.update(frame());
    expect(textItems(source).length).toBe(1);
    handle.applyOptions({ visible: false });
    source.update(frame());
    expect(source.displayLists().length).toBe(0);
  });

  test('a no-op applyOptions patch does not request a frame (§5.1 unchanged = no-op)', () => {
    const pane = makePane(600, 400);
    const ctx = makeCtx(pane);
    const { handle } = attach(pane, ctx, {
      lines: [{ text: 'A', color: '#000', fontSize: 48 }],
    });
    ctx.updates.length = 0;
    handle.applyOptions({ visible: true });
    expect(ctx.updates).toEqual([]);
  });
});
