// Text watermark: one or more lines of text drawn behind the series of a pane. Lines too
// wide for the pane are shrunk to fit.
import { CachedTextMeasurer, DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, SceneSource, TextItem, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

export type TextWatermarkHorzAlign = 'left' | 'center' | 'right';
export type TextWatermarkVertAlign = 'top' | 'center' | 'bottom';

/** One line. `lineHeight` defaults to `fontSize × 1.2`. */
export interface TextWatermarkLine {
  text: string;
  color: string;
  fontSize: number;
  fontFamily?: string;
  fontStyle?: string;
  lineHeight?: number;
}

export interface TextWatermarkOptions {
  visible: boolean;
  horzAlign: TextWatermarkHorzAlign;
  vertAlign: TextWatermarkVertAlign;
  lines: readonly TextWatermarkLine[];
}

const DEFAULT_FONT_FAMILY =
  "-apple-system, system-ui, 'Helvetica Neue', Helvetica, Arial, sans-serif";

export const textWatermarkDefaults: TextWatermarkOptions = {
  visible: true,
  horzAlign: 'center',
  vertAlign: 'center',
  lines: [],
};

export type TextWatermarkHandle = PrimitiveAdapter<TextWatermarkOptions>;

const EMPTY: readonly DisplayList[] = [];

interface PlacedLine {
  readonly item: TextItem;
}

interface PaneLike {
  size(): { width: number; height: number };
}

function createWatermarkSource(
  getOptions: () => TextWatermarkOptions,
  getPane: () => PaneLike | null,
  getRev: () => number,
): SceneSource {
  const builder = new DisplayListBuilder();
  // No backend measurer is reachable from a primitive, so estimate per char. The actual
  // draw is measured by the backend; the fit math only needs a stable, cached width.
  const measurer = new CachedTextMeasurer((text, font) => ({
    width: text.length * font.size * 0.6,
    ascent: font.size * 0.8,
    descent: font.size * 0.2,
  }));
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  function layout(paneW: number, paneH: number): readonly PlacedLine[] {
    const opts = getOptions();
    if (!opts.visible || opts.lines.length === 0 || paneW <= 0 || paneH <= 0) return [];

    // Pass 1: per-line fit zoom and total stacked height.
    interface Pass1 {
      readonly line: TextWatermarkLine;
      readonly lineHeight: number;
      readonly zoom: number;
    }
    const rows: Pass1[] = [];
    let totalHeight = 0;
    for (const line of opts.lines) {
      const lineHeight = line.lineHeight ?? line.fontSize * 1.2;
      if (line.text.length === 0) {
        // An empty line still takes up its height.
        rows.push({ line, lineHeight, zoom: 1 });
        totalHeight += lineHeight;
        continue;
      }
      const w = measurer.measure(line.text, {
        family: line.fontFamily ?? DEFAULT_FONT_FAMILY,
        size: line.fontSize,
        style: line.fontStyle === 'italic' ? 'italic' : 'normal',
      }).width;
      // Only ever shrink, never enlarge.
      const zoom = w > paneW ? paneW / w : 1;
      rows.push({ line, lineHeight, zoom });
      totalHeight += lineHeight * zoom;
    }

    // Clamped at 0 so overflowing text is clipped at the bottom, not the top.
    let vertOffset =
      opts.vertAlign === 'top'
        ? 0
        : opts.vertAlign === 'center'
          ? Math.max((paneH - totalHeight) / 2, 0)
          : Math.max(paneH - totalHeight, 0);

    // Pass 2: place each line.
    const out: PlacedLine[] = [];
    for (const r of rows) {
      const zh = r.lineHeight * r.zoom;
      if (r.line.text.length > 0) {
        const size = r.line.fontSize * r.zoom;
        const family = r.line.fontFamily ?? DEFAULT_FONT_FAMILY;
        const style = r.line.fontStyle === 'italic' ? 'italic' : 'normal';
        const w = measurer.measure(r.line.text, { family, size: r.line.fontSize, style }).width * r.zoom;
        // TextItem.x is the left edge, so offset by the share of w the alignment implies.
        const lh = r.lineHeight * r.zoom;
        let x: number;
        if (opts.horzAlign === 'left') x = lh / 2;
        else if (opts.horzAlign === 'center') x = paneW / 2 - w / 2;
        else x = paneW - 1 - lh / 2 - w;
        // vertOffset is the line's top; TextItem.y is the alphabetic baseline, one ascent lower.
        out.push({
          item: {
            x,
            y: vertOffset + size * 0.8,
            text: r.line.text,
            font: { family, size, style },
            color: r.line.color,
          },
        });
      }
      vertOffset += zh;
    }
    return out;
  }

  function build(): readonly DisplayList[] {
    const pane = getPane();
    if (pane === null) return EMPTY;
    const { width, height } = pane.size();
    const placed = layout(width, height);
    if (placed.length === 0) return EMPTY;
    builder.reset();
    builder.beginList('media');
    builder.text(placed.map((p) => p.item));
    return builder.finish();
  }

  return {
    zBand: ZBand.BelowSeries,
    update(_frame: ViewFrame): void {
      const sz = getPane()?.size();
      // `rev` forces a rebuild on option edits that leave the pane size unchanged.
      const next = `${getRev()}|${sz?.width}|${sz?.height}`;
      if (next === sig) return;
      sig = next;
      cached = build();
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}

/** Attach a text watermark to `pane`; update it later with `applyOptions`. */
export function createTextWatermark(
  pane: PrimitiveTarget & PaneLike,
  options?: DeepPartial<TextWatermarkOptions>,
): TextWatermarkHandle {
  let opts: TextWatermarkOptions = resolve(options);
  let rev = 0;

  let ctx: PrimitiveContext | null = null;
  // Before attach, read the size from the pane handle passed in.
  const source = createWatermarkSource(
    () => opts,
    () => (ctx?.pane as unknown as PaneLike | undefined) ?? pane,
    () => rev,
  );

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
    },
    detached(): void {
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<TextWatermarkOptions>({
    target: pane,
    primitive,
    options: opts,
    defaults: textWatermarkDefaults,
    onChange(next): void {
      opts = next;
      rev++;
      ctx?.requestUpdate('render');
    },
    methods: {},
  });
}

/** Shallow resolve over the defaults; `lines` is replaced wholesale, never merged per element. */
function resolve(patch?: DeepPartial<TextWatermarkOptions>): TextWatermarkOptions {
  if (patch === undefined) return { ...textWatermarkDefaults };
  return {
    visible: patch.visible ?? textWatermarkDefaults.visible,
    horzAlign: (patch.horzAlign as TextWatermarkHorzAlign) ?? textWatermarkDefaults.horzAlign,
    vertAlign: (patch.vertAlign as TextWatermarkVertAlign) ?? textWatermarkDefaults.vertAlign,
    lines: (patch.lines as readonly TextWatermarkLine[]) ?? textWatermarkDefaults.lines,
  };
}
