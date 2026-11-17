// Last-value axis label: a media-space rounded pill with centred text at the series'
// last-value Y, right-aligned on the price axis. Off-surface y emits nothing.
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, FontSpec, ITextMeasurer, SceneSource, ViewFrame } from '../../gfx';

/** `y` is media px (null = no data, hidden); `color` is the raw last-bar colour, used
 *  for the border and as the contrast basis. */
export interface LastValueLabelState {
  readonly y: number | null;
  readonly text: string;
  readonly color: string;
}

/** All sizes in media px. */
export interface LastValueLabelOptions {
  readonly visible: boolean;
  readonly font: FontSpec;
  readonly padH: number;
  readonly padV: number;
  readonly radius: number;
  readonly borderWidth: number;
  /** Gap from the axis right edge. */
  readonly margin: number;
}

const DEFAULTS: LastValueLabelOptions = {
  visible: true,
  font: { family: 'sans-serif', size: 11 },
  padH: 4,
  padV: 2,
  radius: 2,
  borderWidth: 1,
  margin: 0,
};

const resolve = (o?: Partial<LastValueLabelOptions>): LastValueLabelOptions => ({
  visible: o?.visible ?? DEFAULTS.visible,
  font: o?.font ?? DEFAULTS.font,
  padH: o?.padH ?? DEFAULTS.padH,
  padV: o?.padV ?? DEFAULTS.padV,
  radius: o?.radius ?? DEFAULTS.radius,
  borderWidth: o?.borderWidth ?? DEFAULTS.borderWidth,
  margin: o?.margin ?? DEFAULTS.margin,
});

const EMPTY: readonly DisplayList[] = Object.freeze([]);

/** Background = the colour with alpha stripped; foreground is 'black' when
 *  luma (0.199·r + 0.687·g + 0.114·b) > 160, else 'white'. Unparseable colours get
 *  white text. */
export function generateContrastColors(color: string): { background: string; foreground: string } {
  const rgb = parseRgb(color);
  if (rgb === null) return { background: color, foreground: 'white' };
  const [r, g, b] = rgb;
  const luma = 0.199 * r + 0.687 * g + 0.114 * b;
  return { background: `rgb(${r}, ${g}, ${b})`, foreground: luma > 160 ? 'black' : 'white' };
}

/** #rgb / #rrggbb / #rrggbbaa / rgb() / rgba() → [r, g, b]; alpha discarded. */
function parseRgb(c: string): [number, number, number] | null {
  const s = c.trim();
  if (s.charCodeAt(0) === 35 /* # */) {
    const h = s.slice(1);
    if (h.length === 3) return [d2(h[0]! + h[0]!), d2(h[1]! + h[1]!), d2(h[2]! + h[2]!)];
    if (h.length === 6 || h.length === 8) return [d2(h.slice(0, 2)), d2(h.slice(2, 4)), d2(h.slice(4, 6))];
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/i);
  if (m === null) return null;
  const p = m[1]!.split(',');
  if (p.length < 3) return null;
  return [byte(p[0]!), byte(p[1]!), byte(p[2]!)];
}

const d2 = (h: string): number => parseInt(h, 16);
const byte = (v: string): number => Math.max(0, Math.min(255, Math.round(parseFloat(v))));

export function createLastValueLabelSource(
  provider: () => LastValueLabelState,
  measurer: ITextMeasurer,
  options?: Partial<LastValueLabelOptions>,
): SceneSource {
  const o = resolve(options);
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  const drawable = (s: LastValueLabelState, h: number): boolean =>
    o.visible && s.y !== null && Number.isFinite(s.y) && s.y >= 0 && s.y <= h && s.text.length > 0;

  function signature(s: LastValueLabelState, w: number, h: number): string {
    if (!drawable(s, h)) return 'hidden';
    return `${s.y}|${s.text}|${s.color}|${w}|${h}`;
  }

  function build(s: LastValueLabelState, w: number, h: number): readonly DisplayList[] {
    if (!drawable(s, h)) return EMPTY;
    const size = measurer.measure(s.text, o.font);
    const { background, foreground } = generateContrastColors(s.color);
    const pillW = size.width + 2 * o.padH;
    const pillH = size.ascent + size.descent + 2 * o.padV;
    const right = w - o.margin;
    const left = right - pillW;
    const top = (s.y as number) - pillH / 2;
    // Centred text: baseline y = centerY + (ascent − descent)/2.
    const textX = left + pillW / 2 - size.width / 2;
    const textY = (s.y as number) + (size.ascent - size.descent) / 2;

    builder.reset();
    builder.beginList('media');
    builder
      .rects({ radius: o.radius, stroke: { width: o.borderWidth, color: s.color } })
      .quad(left, top, pillW, pillH, background);
    builder.text([{ x: textX, y: textY, text: s.text, font: o.font, color: foreground }]);
    return builder.finish();
  }

  return {
    zBand: ZBand.Labels,
    update(frame: ViewFrame): void {
      const s = provider();
      const w = frame.frame.mediaSize.width;
      const h = frame.frame.mediaSize.height;
      const next = signature(s, w, h);
      if (next === sig) return;
      sig = next;
      cached = build(s, w, h);
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}
