// views: scene sources → display lists, series kinds, hit testing, axis layout.
// Headless; other modules must import `views` only through this index.

// `SeriesKind`, `ItemBuffer` and `ItemWindow` form the public custom-series seam.
export type { SeriesKind } from './series/kind';
export type { ItemBuffer, ItemFactory } from './series/buffer';
export { ReusableItemBuffer } from './series/buffer';
export type { ItemWindow } from './series/window';
export { MutableItemWindow, itemWindow } from './series/window';

export { createLineKind, LineType } from './series/line';
export type { LineItem, LineKind, LineKindOptions } from './series/line';
export { createAreaKind } from './series/area';
export type { AreaItem, AreaKindOptions, AreaPointColors } from './series/area';
export { createBaselineKind } from './series/baseline';
export type { BaselineItem, BaselineKind, BaselineKindOptions } from './series/baseline';
export { createHistogramKind } from './series/histogram';
export type { HistogramItem, HistogramKind, HistogramKindOptions } from './series/histogram';
export { createBarKind } from './series/bar';
export type { BarItem, BarKind, BarKindOptions } from './series/bar';
export { createCandlestickKind } from './series/candlestick';
export type { CandlestickItem, CandlestickKind, CandlestickKindOptions } from './series/candlestick';

export { createGridSource } from './series/grid';
export type { GridSource, GridSideStyle } from './series/grid';
export { createCrosshairSource } from './series/crosshair-source';
export type { CrosshairLineOptions, CrosshairSourceOptions } from './series/crosshair-source';
export { createPriceLineSource } from './series/price-line';
export type { PriceLineSource, PriceLineState, PriceLineOptions } from './series/price-line';
export { createLastValueLabelSource, generateContrastColors } from './series/last-value-label';
export type { LastValueLabelState, LastValueLabelOptions } from './series/last-value-label';

export { decimateColumns, shouldDecimate } from './series/decimate';
export type { DecimateOptions, DecimateResult, DecimateShape } from './series/decimate';

export { PaneScene } from './scene/pane-scene';
export type { SourceMeta } from './scene/pane-scene';
export { PrimitiveBinding, resolveSurface } from './scene/primitive-binding';
export type { OwnerPlacement, SurfaceKind, TaggedPrimitiveSource } from './scene/primitive-binding';

export { hitTestPane, toHoverTarget } from './hit-test';
export type { HitResult, HitSource, RankedHit } from './hit-test';

export { layoutPriceAxis, layoutTimeAxis, boldWeight, AxisWidthRatchet } from './axis-layout';
export type {
  PriceAxisInput,
  PriceAxisLayout,
  PriceTickLabel,
  PriceLabelPlacement,
  CrosshairSample,
  TimeAxisInput,
  TimeAxisLayout,
  TimeMarkInput,
  TimeLabelPlacement,
} from './axis-layout';
