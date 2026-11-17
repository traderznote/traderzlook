// Public surface of gfx, exported as the `traderzlook/gfx` subpath so third-party
// backends depend on it alone. gfx imports only core.

export { LineStyle, PathVerb, dashPattern } from './commands';
export {
  applyBarParity,
  ceiledEven,
  ceiledOdd,
  crispRound,
  crispStrokePos,
  crispWidth,
  edgeToRect,
  evenCeil,
  evenFloor,
  optimalBarWidth,
  optimalCandlestickWidth,
  tickRect,
} from './crisp';
export { DisplayListBuilder } from './builder';
export { CachedTextMeasurer } from './text-measure';
export { ZBand } from './scene';
export { HitPriority } from './hit';

export type {
  AreaCommand,
  CirclesCommand,
  DisplayList,
  DrawCommand,
  FillStyle,
  FontSpec,
  ImageCommand,
  ImageHandle,
  LinearGradientY,
  PathCommand,
  PolylineCommand,
  Rect,
  RectsCommand,
  Space,
  StrokeSpec,
  StyleRun,
  TextCommand,
  TextItem,
} from './commands';
export type { EdgeRect, TickRect } from './crisp';
export type { AreaWriter, CirclesWriter, PathWriter, PolylineWriter, RectsWriter } from './builder';
export type { ITextMeasurer, TextSize } from './text-measure';
export type {
  FrameInfo,
  FrameScope,
  IRenderBackend,
  ISurface,
  LayerId,
  Snapshot,
  SnapshotTile,
  SurfaceSnapshot,
} from './backend';
export type { SceneSource, ViewFrame } from './scene';
export type { HitCandidate } from './hit';
