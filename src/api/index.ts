// Re-export point of the api module: public facades, wiring seams and the factories.
export { EventHub, buildSeriesData, buildHoverInfo, surfaceStoreDiff } from './events';
export type {
  MouseEventParams,
  MouseEventHandler,
  HoverInfo,
  PointerEventData,
  StoreDiff,
  SeriesDataCandidate,
  HoverOwnership,
  HoverResolver,
} from './events';

export { createSeriesApi } from './series';
export type { DeepPartial, Unsubscribe } from '../core';
export type {
  ISeries,
  IPriceLine,
  IPriceFormatter,
  IPriceScaleHandle,
  IPaneHandle,
  SeriesPort,
  BarsInfo,
  LogicalRange,
  MismatchDirection,
  WhitespaceData,
  PriceLineOptions,
} from './series';

// Canonical ITimeScale / IPriceScale / IPane come from their own modules, not from
// ./chart's structural placeholders.
export { createTimeScaleApi } from './time-scale';
export type {
  ITimeScale,
  TimeRange,
  TimeScalePort,
  TimeScaleApiDeps,
} from './time-scale';

export { createChartApi } from './chart';
export type {
  IChart,
  ChartApiDeps,
  ChartHostFacade,
  ChartWiring,
  DisposedCell,
} from './chart';

export { createPriceScaleApi } from './price-scale';
export type { IPriceScale, PriceScalePort, PriceScaleApiDeps } from './price-scale';

export { createPaneApi } from './pane';
export type { IPane, PanePort } from './pane';

export { createPriceLineApi } from './price-line';
export type { PriceLinePort, PriceLineApiDeps } from './price-line';

export { createChart, createChartWith, canvasBackend, timeBehavior, version } from './create-chart';
export type { ChartEnvironment } from './create-chart';
export * from './re-exports';

export {
  LineSeries,
  AreaSeries,
  BaselineSeries,
  BarSeries,
  CandlestickSeries,
  HistogramSeries,
  defineSeries,
  defaultSeriesOptions,
  isBusinessDay,
  isUTCTimestamp,
} from './series-defs';
export type { SeriesType, SeriesDefinition } from './series-defs';

export { ChartError, ChartErrorCode } from './errors';
