// traderzlook/extras — tree-shakable first-party plugins built on the public api only.
// Each factory attaches an IPrimitive and returns a { detach, applyOptions, ... } handle.

export { createSeriesMarkers, defaultSeriesMarkersOptions } from './markers/series-markers';
export type {
  SeriesMarker,
  SeriesMarkerPosition,
  SeriesMarkerShape,
  SeriesMarkersOptions,
  SeriesMarkersHandle,
} from './markers/series-markers';

export { createUpDownMarkers, upDownMarkersDefaults } from './markers/up-down-markers';
export type {
  UpDownMarker,
  UpDownSign,
  UpDownMarkersOptions,
  UpDownMarkersMethods,
  UpDownMarkersHandle,
} from './markers/up-down-markers';

export { createTextWatermark, textWatermarkDefaults } from './watermark/text-watermark';
export type {
  TextWatermarkOptions,
  TextWatermarkLine,
  TextWatermarkHorzAlign,
  TextWatermarkVertAlign,
  TextWatermarkHandle,
} from './watermark/text-watermark';

export { createImageWatermark, imageWatermarkDefaults } from './watermark/image-watermark';
export type { ImageWatermarkOptions, ImageWatermarkHandle } from './watermark/image-watermark';

export { createToolHost, TrendLineTool, trendLineDefaults } from './tools/tool-host';
export type {
  IToolHost,
  Anchor,
  SerializedShape,
  IShapePrimitive,
  ToolDefinition,
  ShapeHandle,
  ToolHostEvent,
  TrendLineStyle,
} from './tools/tool-host';

export { createEma, emaDefinition, defaultEmaParams } from './indicators/ema';
export type {
  EmaParams,
  EmaHandle,
  IndicatorDefinition,
  IndicatorComputer,
  IndicatorOutput,
  IndicatorOutputPatch,
  IndicatorPatchMode,
} from './indicators/ema';

export { createSyncGroup } from './sync/sync-group';
export type { SyncGroupOptions } from './sync/sync-group';

export { priceAxisBehavior, yieldCurveBehavior } from './behaviors/price-axis-behavior';

export { timezoneTimeBehavior, offsetFor } from './behaviors/timezone-time-behavior';

export { createSessionHighlight, sessionHighlightDefaults } from './behaviors/session-highlight';
export type { SessionSpec, SessionHighlightOptions, SessionHighlightHandle } from './behaviors/session-highlight';
