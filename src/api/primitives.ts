// Public primitive shapes. The model IPrimitive is a subset (no host lifecycle), so a
// primitive built against these stays assignable to attachPrimitive.
import type { ImageHandle } from '../gfx';
import type { AutoscaleInfo, AxisLabel, PrimitiveSource } from '../model';
import type { Time } from '../data';
import type { IInteractionRouter } from '../host';
import type { IChart, IPane } from './chart';
import type { ISeries, LogicalRange } from './series';
import type { SeriesType } from './series-defs';

export type { AutoscaleInfo, AxisLabel, PrimitiveSource, ImageHandle };

/** A series- or pane-attached primitive. Every member is optional; `{}` is valid. */
export interface IPrimitive<H = Time> {
  attached?(ctx: PrimitiveContext<H>): void;
  detached?(): void;
  /** Scene sources to register; polled at attach + after `requestUpdate('layout')`. */
  sources?(): readonly PrimitiveSource[];
  /** Auto-placed axis labels (overlap-shifted like series labels). */
  priceAxisLabels?(): readonly AxisLabel[];
  timeAxisLabels?(): readonly AxisLabel[];
  /** Extra range + MAX-merged margins for autoscale. Series-attached only; per frame. */
  autoscale?(range: LogicalRange): AutoscaleInfo | null;
}

/**
 * Passed to `attached(ctx)`. `series` is present iff series-attached; only
 * `requestUpdate('layout')` re-polls `sources()`; `images` is the only image-upload path.
 */
export interface PrimitiveContext<H = Time> {
  chart: IChart<H>;
  series?: ISeries<SeriesType, H>;
  pane: IPane<H>;
  requestUpdate(scope: 'overlay' | 'render' | 'layout'): void;
  input: IInteractionRouter;
  images: { create(src: unknown): ImageHandle };
}
