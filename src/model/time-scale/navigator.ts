// Time-axis state transitions and math: the command reducer, spacing/offset clamps,
// new-bar offset compensation, and kinetic fling. Gesture recognition lives in host/input.
import type { LogicalRange } from './geometry';

// At least this many bars (or all, if fewer) stay visible at either scroll extreme.
// The 0.5·W max-spacing coefficient is tied to it (1/2 ≥ 0.5).
const MIN_VISIBLE_BARS = 2;
const MAX_SPACING_COEFF = 0.5;

/** Immutable; the scheduler samples `positionAt(now)` until `finished(now)`. */
export interface HorzAnimation {
  finished(now: number): boolean;
  positionAt(now: number): number;
}

export interface KineticTuning {
  /** Damping coefficient D per ms. */
  readonly damping: number;
  /** Stop threshold in bars (= epsilonPx / barSpacing). */
  readonly epsilon: number;
}

/** Pixel-denominated; the velocity tracker divides the speeds by barSpacing at fling start. */
export const KINETIC = {
  /** px/ms — below this no fling. */
  minSpeed: 0.2,
  /** px/ms. */
  maxSpeed: 7,
  damping: 0.997,
  /** Jitter filter: samples moving < this many px are dropped. */
  minMove: 15,
  /** A fling launches only if released within this many ms of the last sample. */
  maxStartDelay: 50,
  epsilonPx: 1,
} as const;

/**
 * ε is divided by barSpacing so the stop threshold is one pixel of residual travel,
 * not one bar; otherwise flings cut off early at large spacings.
 */
export function kineticTuningForBarSpacing(barSpacing: number): KineticTuning {
  return { damping: KINETIC.damping, epsilon: KINETIC.epsilonPx / barSpacing };
}

/**
 * Closed-form damped glide. `velocity` is in bars/ms.
 *   position(Δt) = p0 + v·(D^Δt − 1) / ln D
 *   duration     = ln( ε·(−ln D) / |v| ) / ln D
 */
export function createKineticAnimation(
  position: number,
  velocity: number,
  now: number,
  tuning: KineticTuning,
): HorzAnimation {
  const lnD = Math.log(tuning.damping);
  const speed = Math.abs(velocity);
  // When total travel |v|/(−ln D) < ε, duration comes out negative → finished immediately.
  const duration = speed > 0 ? Math.log((tuning.epsilon * -lnD) / speed) / lnD : 0;

  const positionAt = (t: number): number => {
    const dt = Math.min(Math.max(t - now, 0), Math.max(duration, 0));
    return position + (velocity * (Math.pow(tuning.damping, dt) - 1)) / lnD;
  };

  const finished = (t: number): boolean => {
    if (!(duration > 0)) return true;
    return Math.min(t - now, duration) === duration;
  };

  return { finished, positionAt };
}

export type HorzScaleCommand =
  | { kind: 'fitContent' }
  | { kind: 'applyRange'; range: LogicalRange }
  | { kind: 'setBarSpacing'; value: number }
  | { kind: 'setRightOffset'; value: number }
  | { kind: 'reset' }
  | { kind: 'animate'; animation: HorzAnimation }
  | { kind: 'stopAnimation' };

function withoutPendingAnimate(queue: readonly HorzScaleCommand[]): HorzScaleCommand[] {
  return queue.filter((c) => c.kind !== 'animate');
}

/**
 * Returns a new queue:
 *   • fitContent / applyRange / reset replace the whole queue;
 *   • everything else cancels any pending animate, then appends. A stopAnimation
 *     stays queued so a later mask-merge also cancels the destination's animation.
 */
export function reduceHorzCommands(
  queue: readonly HorzScaleCommand[],
  next: HorzScaleCommand,
): readonly HorzScaleCommand[] {
  switch (next.kind) {
    case 'fitContent':
    case 'applyRange':
    case 'reset':
      return [next];
    case 'setBarSpacing':
    case 'setRightOffset':
    case 'animate':
    case 'stopAnimation':
      return [...withoutPendingAnimate(queue), next];
    default: {
      const _exhaustive: never = next;
      return _exhaustive;
    }
  }
}

export interface BarSpacingClampParams {
  /** W, media px. */
  readonly width: number;
  readonly minBarSpacing: number;
  /** 0 = disabled (→ half the width). */
  readonly maxBarSpacing: number;
  readonly barCount: number;
  readonly fixLeftEdge?: boolean;
  readonly fixRightEdge?: boolean;
}

function maxSpacing(p: BarSpacingClampParams): number {
  return p.maxBarSpacing > 0 ? p.maxBarSpacing : p.width * MAX_SPACING_COEFF;
}

function minSpacing(p: BarSpacingClampParams): number {
  // both edges fixed: cannot zoom out past "all data fills W".
  if (p.fixLeftEdge && p.fixRightEdge && p.barCount > 0) return p.width / p.barCount;
  return p.minBarSpacing;
}

export function clampBarSpacing(spacing: number, p: BarSpacingClampParams): number {
  return Math.min(Math.max(spacing, minSpacing(p)), maxSpacing(p));
}

export interface RightOffsetClampParams {
  /** W, media px. */
  readonly width: number;
  /** S, media px. */
  readonly barSpacing: number;
  readonly firstIndex: number;
  /** null when no series has data (skips the min bound). */
  readonly baseIndex: number | null;
  readonly barCount: number;
  readonly fixLeftEdge?: boolean;
  readonly fixRightEdge?: boolean;
}

/**
 *   minR = firstIndex − B − 1 + (fixLeftEdge ? W/S : min(2,N))   (skipped if B null)
 *   maxR = fixRightEdge ? 0 : W/S − min(2,N)
 */
export function clampRightOffset(offset: number, p: RightOffsetClampParams): number {
  const barsPerScreen = p.width / p.barSpacing;
  const minVisible = Math.min(MIN_VISIBLE_BARS, p.barCount);
  const maxR = p.fixRightEdge ? 0 : barsPerScreen - minVisible;

  let r = Math.min(offset, maxR);
  if (p.baseIndex !== null) {
    const leftTerm = p.fixLeftEdge ? barsPerScreen : minVisible;
    const minR = p.firstIndex - p.baseIndex - 1 + leftTerm;
    r = Math.max(r, minR);
  }
  return r;
}

export interface CompensationInput {
  readonly rightOffset: number;
  readonly oldBaseIndex: number;
  /** null when no series has data. */
  readonly newBaseIndex: number | null;
  /** Whether the old base index is inside the current strict visible range. */
  readonly lastBarVisible: boolean;
  /** Whether history was prepended. */
  readonly leftShifted: boolean;
  /** Whether this update only filled an existing whitespace slot. */
  readonly replacedWhitespace: boolean;
  readonly shiftVisibleRangeOnNewBar: boolean;
  readonly allowShiftVisibleRangeOnWhitespaceReplacement: boolean;
}

/**
 * New-bar follow/stay. R is right-anchored, so doing nothing follows the newest bar;
 * compensation subtracts the appended-bar count to keep the viewport on the same bars.
 *   addedToRight = newBase > oldBase AND not leftShifted
 *   wantShift    = lastBarVisible AND (not replacedWhitespace OR allowOnWhitespace)
 *                  AND shiftVisibleRangeOnNewBar
 *   if addedToRight and not wantShift: R −= (newBase − oldBase)
 */
export function compensateRightOffset(i: CompensationInput): number {
  const pointsAdded = i.newBaseIndex !== null && i.newBaseIndex > i.oldBaseIndex;
  const addedToRight = pointsAdded && !i.leftShifted;
  const wantShift =
    i.lastBarVisible &&
    (!i.replacedWhitespace || i.allowShiftVisibleRangeOnWhitespaceReplacement) &&
    i.shiftVisibleRangeOnNewBar;

  if (addedToRight && !wantShift) {
    return i.rightOffset - ((i.newBaseIndex as number) - i.oldBaseIndex);
  }
  return i.rightOffset;
}

export function rightOffsetFromPixels(px: number, barSpacing: number): number {
  return px / barSpacing;
}

/** On zoom S → S′, offset · S / S′ keeps the pixel gap constant. S′ is already clamped > 0. */
export function rightOffsetForPixels(offset: number, oldSpacing: number, newSpacing: number): number {
  if (!(oldSpacing > 0)) return offset;
  return (offset * oldSpacing) / newSpacing;
}

/** S = (W − px) / N, then offset = px / S. */
export function fitContentWithPixels(
  width: number,
  px: number,
  barCount: number,
): { barSpacing: number; rightOffset: number } {
  const barSpacing = (width - px) / barCount;
  return { barSpacing, rightOffset: px / barSpacing };
}
