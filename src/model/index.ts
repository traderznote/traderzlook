// Headless chart state. Never imports gfx; other modules import `model` only through this index.

export { ChartModel, UpdateLevel, createMask, emptyMask, mergeMasks, invalidationLevelForPaths } from './chart-model';
export type { UpdateMask, MaskInit, InvalidateCallback, ChartModelInit } from './chart-model';

export { Pane, PriceScale } from './pane';
export type { PaneSeries } from './pane';
export { PaneManager } from './pane-manager';

export {
  formatPaneId,
  buildHorzGeometry,
  buildPriceConverter,
  DEFAULT_CHART_OPTIONS,
  DEFAULT_TIME_SCALE_OPTIONS,
  DEFAULT_PRICE_SCALE_OPTIONS,
} from './shared';
export type {
  PaneId,
  ChartOptions,
  LayoutOptions,
  GridOptions,
  CrosshairOptions,
  CrosshairLineStyle,
  PriceScaleOptions,
  PriceConverter,
  PriceConverterMode,
  PriceConverterParams,
  TimeScaleOptions,
  LocalizationOptions,
  HorzScaleOptionGroups,
} from './shared';

export { Series, resolveBarColors, candlestickNormalizeOptions, rowsInRange } from './series';
export type {
  SeriesKindName,
  SeriesInit,
  SeriesOptions,
  AutoscaleInfo,
  AutoscaleInfoProvider,
  AxisLabel,
  PrimitiveSource,
  IPrimitive,
  LogicalRange as SeriesLogicalRange,
  PointColorOverrides,
  ColorerBar,
  BarColors,
  LastValue,
} from './series';

export { Crosshair, CrosshairMode, magnetSnapPrice } from './crosshair';
export type {
  CrosshairPosition,
  MagnetCandidate,
  MagnetConverters,
  MagnetSnapArgs,
  HoverTarget,
} from './crosshair';

export { createHorzGeometry } from './time-scale/geometry';
export type { HorzGeometry, HorzGeometryParams, StrictRange, LogicalRange } from './time-scale/geometry';
export {
  reduceHorzCommands,
  createKineticAnimation,
  kineticTuningForBarSpacing,
  clampBarSpacing,
  clampRightOffset,
  compensateRightOffset,
  rightOffsetFromPixels,
  rightOffsetForPixels,
  fitContentWithPixels,
  KINETIC,
} from './time-scale/navigator';
export type {
  HorzScaleCommand,
  HorzAnimation,
  KineticTuning,
  BarSpacingClampParams,
  RightOffsetClampParams,
  CompensationInput,
} from './time-scale/navigator';
export { TickMarkEngine, maxLabelWidthFor, maxIndexesPerMark, indexPerLabel } from './time-scale/ticks';
export type { TickMark, BuildParams } from './time-scale/ticks';

export {
  SCROLL_ANIMATION_DURATION_MS,
  PULSE_PERIOD_MS,
  PULSE_KEYFRAMES,
  easeOutCubic,
  createScrollAnimation,
  pulseFrameAtPhase,
  createPulseAnimation,
  extendPulseEnd,
} from './animation';
export type { PulseFrame, PulseAnimation, LastPriceAnimationMode } from './animation';

export { createPriceGeometry } from './price-scale/geometry';
export type { PriceGeometry, PriceGeometryParams } from './price-scale/geometry';
export {
  PriceScaleMode,
  refusesManualScale,
  isAutoScaleForced,
  toPercent,
  fromPercent,
  toIndexed,
  fromIndexed,
  toLog,
  fromLog,
  toLogRange,
  fromLogRange,
  defaultLogFormula,
  logFormulaForRange,
  canConvertFromLog,
  reexpressLogRange,
  deNoiseLogVisibleRange,
} from './price-scale/modes';
export type { LogFormula, MinMax, VisibleRange } from './price-scale/modes';
export {
  assembleRange,
  finiteMerge,
  mergeMargins,
} from './price-scale/autoscale';
export type { AutoscaleMargins, AutoscaleContributor, AssembledRange } from './price-scale/autoscale';
export { tickSpan, rebuildTickMarks } from './price-scale/ticks';
export type { PriceTick } from './price-scale/ticks';
export { PriceNavigator } from './price-scale/navigator';
export type { PriceNavigatorInit } from './price-scale/navigator';
