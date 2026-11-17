// Public surface of core; other modules import core only through this index.

export { Emitter } from './emitter';
export type { ISubscription, Unsubscribe } from './emitter';
export type { Disposable } from './disposable';
export { reportError, setReportError } from './report-error';
export type { ReportError } from './report-error';
export { mergeOptions, changedPaths } from './options';
export type { DeepPartial, DeepReadonly } from './options';
export { lowerBound, upperBound } from './search';
export { assert } from './assert';
export type {
  Brand,
  Coordinate,
  BitmapCoordinate,
  TimeIndex,
  Logical,
  HorzKey,
  BarPrice,
  CursorStyle,
  Size,
  Rect,
} from './brands';
export { createFrameCounters, FrameCounters } from './profiling';
export type { IFrameCounters } from './profiling';
