// Horizontal-scale option groups, declared in `data` so behaviors can type
// augmentDefaults without importing `model`.

/** Tick-mark category; a const object + union instead of an enum (erasableSyntaxOnly). */
export const TickMarkType = {
  Year: 0,
  Month: 1,
  DayOfMonth: 2,
  Time: 3,
  TimeWithSeconds: 4,
} as const;
export type TickMarkType = (typeof TickMarkType)[keyof typeof TickMarkType];

/** Returning `null` falls back to the default formatter. `H` is the user time form. */
export type TickMarkFormatter<H> = (time: H, type: TickMarkType, locale: string) => string | null;

export interface TimeScaleOptions<H = unknown> {
  rightOffset: number;
  rightOffsetPixels: number | undefined;
  barSpacing: number;
  minBarSpacing: number;
  maxBarSpacing: number; // 0 = no max
  fixLeftEdge: boolean;
  fixRightEdge: boolean;
  resizeAnchor: 'right-offset' | 'visible-range';
  rightBarStaysOnScroll: boolean;
  borderVisible: boolean;
  borderColor: string;
  visible: boolean;
  timeVisible: boolean;
  secondsVisible: boolean;
  shiftVisibleRangeOnNewBar: boolean;
  allowShiftVisibleRangeOnWhitespaceReplacement: boolean;
  ticksVisible: boolean;
  uniformDistribution: boolean;
  tickMarkMaxCharacterLength: number | undefined; // undefined → 8
  minimumHeight: number;
  allowBoldLabels: boolean;
  tickMarkFormatter: TickMarkFormatter<H> | undefined;
}

export interface LocalizationOptions<H = unknown> {
  locale: string;
  dateFormat: string;
  priceFormatter: ((price: number) => string) | undefined;
  percentageFormatter: ((pct: number) => string) | undefined;
  timeFormatter: ((time: H) => string) | undefined; // crosshair label
}

/**
 * The only two option groups a behavior may augment; mutated in place on a
 * cloned defaults object.
 */
export interface HorzScaleOptionGroups<H = unknown> {
  timeScale: TimeScaleOptions<H>;
  localization: LocalizationOptions<H>;
}

export type TimeScaleFormatOptions<H = unknown> = Pick<
  TimeScaleOptions<H>,
  'timeVisible' | 'secondsVisible' | 'tickMarkFormatter'
>;
