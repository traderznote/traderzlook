// Text measurement on a hidden context. Called during layout only, never from replay.
import type { FontSpec, ITextMeasurer, TextSize } from '../gfx';

/** CSS font shorthand in the order Canvas expects: `style weight size family`. */
export function fontString(font: FontSpec): string {
  const style = font.style ?? 'normal';
  const weight = font.weight ?? 'normal';
  return `${style} ${weight} ${font.size}px ${font.family}`;
}

export class CanvasTextMeasurer implements ITextMeasurer {
  readonly #ctx: CanvasRenderingContext2D;

  constructor(ctx: CanvasRenderingContext2D) {
    this.#ctx = ctx;
  }

  measure(text: string, font: FontSpec): TextSize {
    this.#ctx.font = fontString(font);
    const m = this.#ctx.measureText(text);
    const ascent = m.actualBoundingBoxAscent;
    const descent = m.actualBoundingBoxDescent;
    return {
      width: m.width,
      // Older engines lack the bounding-box fields; fall back to 0.8 / 0.2 of the size.
      ascent: typeof ascent === 'number' ? ascent : font.size * 0.8,
      descent: typeof descent === 'number' ? descent : font.size * 0.2,
    };
  }
}
