// Pure axis layout: price-axis width, time-axis height/labels, and the width ratchet.
import type { FontSpec, ITextMeasurer } from '../gfx';
import type { AxisLabel } from '../model';

const evenCeil = (n: number): number => {
  const c = Math.ceil(n);
  return c % 2 === 0 ? c : c + 1;
};

const PRICE_FALLBACK_WIDTH = 34;
const CROSSHAIR_DIGITS = 0.11111111111111; // digit-heavy value, reserves room for the widest crosshair label

export interface PriceTickLabel {
  readonly text: string;
}

/** Prices at 1 px inside the top/bottom edges, reserved for the crosshair label.
 *  `null` skips it (crosshair off or no first value). */
export interface CrosshairSample {
  readonly topValue: number; // coordinateToPrice(y = 1)
  readonly bottomValue: number; // coordinateToPrice(y = height − 2)
  readonly format: (price: number) => string;
}

export interface PriceAxisInput {
  readonly ticks: readonly PriceTickLabel[]; // ordered; only first + last measured
  readonly backLabels: readonly AxisLabel[];
  readonly crosshair: CrosshairSample | null;
  readonly font: FontSpec;
  readonly minimumWidth?: number;
}

export interface PriceLabelPlacement {
  readonly text: string;
  readonly y: number;
  readonly width: number;
  readonly fixed: boolean; // fixedCoordinate pill: render pinned, never aligned
}

export interface PriceAxisLayout {
  readonly maxLabelWidth: number; // measured content width (pre-chrome, pre-ratchet)
  readonly width: number; // desired width incl. chrome, even, ≥ minimumWidth
  readonly labels: readonly PriceLabelPlacement[];
}

/** Width = chrome + max over first/last tick labels, non-fixed back-labels and the
 *  crosshair samples, rounded up to even. fixedCoordinate labels don't widen the axis. */
export function layoutPriceAxis(input: PriceAxisInput, m: ITextMeasurer): PriceAxisLayout {
  const { ticks, backLabels, crosshair, font } = input;
  const measure = (t: string): number => (t.length === 0 ? 0 : m.measure(t, font).width);
  let max = 0;

  if (ticks.length > 0) max = Math.max(measure(ticks[0]!.text), measure(ticks[ticks.length - 1]!.text));

  const labels: PriceLabelPlacement[] = [];
  for (const l of backLabels) {
    if (l.visible && l.visible() === false) continue;
    const fixedAt = l.fixedCoordinate?.();
    const fixed = fixedAt !== undefined;
    const width = measure(l.text());
    if (!fixed) max = Math.max(max, width);
    labels.push({ text: l.text(), y: fixed ? (fixedAt as number) : l.coordinate(), width, fixed });
  }

  if (crosshair !== null) {
    const lo = Math.min(crosshair.topValue, crosshair.bottomValue);
    const hi = Math.max(crosshair.topValue, crosshair.bottomValue);
    max = Math.max(
      max,
      measure(crosshair.format(Math.floor(lo) + CROSSHAIR_DIGITS)),
      measure(crosshair.format(Math.ceil(hi) - CROSSHAIR_DIGITS)),
    );
  }

  // chrome = border(1) + tickLen(5) + paddingInner + paddingOuter + labelOffset(5),
  // with each padding = fontSize/12 · 5.
  const pad = (font.size / 12) * 5;
  let width = max === 0 ? PRICE_FALLBACK_WIDTH : evenCeil(1 + 5 + 2 * pad + 5 + max);
  if (input.minimumWidth !== undefined) width = Math.max(width, input.minimumWidth);
  return { maxLabelWidth: max, width, labels };
}

const RATCHET_STEP = 8; // growth quantum, also the slack threshold (px)
const SHRINK_FRAMES = 30; // consecutive ≥STEP-slack frames before a shrink
const quantize = (w: number): number => Math.ceil(w / RATCHET_STEP) * RATCHET_STEP;

/**
 * Axis-width ratchet: growth is quantised to 8 px and immediate; shrink happens only
 * after 30 consecutive frames with ≥ 8 px slack, so a transient narrow frame never
 * collapses the axis.
 */
export class AxisWidthRatchet {
  #width = 0;
  #slackFrames = 0;

  get width(): number {
    return this.#width;
  }

  update(desired: number): number {
    if (desired > this.#width) {
      this.#width = quantize(desired);
      this.#slackFrames = 0;
    } else if (this.#width - desired >= RATCHET_STEP) {
      if (++this.#slackFrames >= SHRINK_FRAMES) {
        this.#width = quantize(desired);
        this.#slackFrames = 0;
      }
    } else {
      this.#slackFrames = 0;
    }
    return this.#width;
  }

  reset(): void {
    this.#width = 0;
    this.#slackFrames = 0;
  }
}

const WEIGHT_HOUR1 = 30;
const WEIGHT_DAY = 50;

/** `coordinate` is the media-px tick X; `needAlign` marks an edge label that may be
 *  shifted inward. */
export interface TimeMarkInput {
  readonly coordinate: number;
  readonly label: string;
  readonly weight: number;
  readonly needAlign: boolean;
}

export interface TimeAxisInput {
  readonly marks: readonly TimeMarkInput[];
  readonly font: FontSpec;
  readonly width: number; // axis surface media width (edge-clip bound)
  readonly minimumHeight?: number;
  readonly allowBoldLabels?: boolean; // default true
}

/** `x` is the left edge after the inward shift; `center` is the unclamped tick. */
export interface TimeLabelPlacement {
  readonly x: number;
  readonly center: number;
  readonly text: string;
  readonly bold: boolean;
}

export interface TimeAxisLayout {
  readonly height: number; // optimal axis height, even, ≥ minimumHeight
  readonly labels: readonly TimeLabelPlacement[];
}

/** The max visible weight, except a max strictly between Hour1 and Day drops to
 *  Hour1 so e.g. 15:00 isn't the lone bold label. `null` when there are no marks. */
export function boldWeight(marks: readonly TimeMarkInput[]): number | null {
  if (marks.length === 0) return null;
  let max = marks[0]!.weight;
  for (let i = 1; i < marks.length; i++) if (marks[i]!.weight > max) max = marks[i]!.weight;
  return max > WEIGHT_HOUR1 && max < WEIGHT_DAY ? WEIGHT_HOUR1 : max;
}

/** Height = border(1) + tickLen(5) + F + padTop(3F/12) + padBottom(3F/12) +
 *  labelBottomOffset(4F/12), rounded up to even. Labels are centred on their tick;
 *  needAlign edge labels shift inward into [0, width]. */
export function layoutTimeAxis(input: TimeAxisInput, m: ITextMeasurer): TimeAxisLayout {
  const F = input.font.size;
  let height = evenCeil(1 + 5 + F + (3 * F) / 12 + (3 * F) / 12 + (4 * F) / 12);
  if (input.minimumHeight !== undefined) height = Math.max(height, evenCeil(input.minimumHeight));

  const maxW = (input.allowBoldLabels ?? true) ? boldWeight(input.marks) : null;
  const labels: TimeLabelPlacement[] = [];
  for (const mark of input.marks) {
    const half = mark.label.length === 0 ? 0 : m.measure(mark.label, input.font).width / 2;
    let x = mark.coordinate - half;
    if (mark.needAlign) {
      if (x < 0) x = 0;
      if (x + 2 * half > input.width) x = input.width - 2 * half;
    }
    labels.push({ x, center: mark.coordinate, text: mark.label, bold: maxW !== null && mark.weight >= maxW });
  }
  return { height, labels };
}
