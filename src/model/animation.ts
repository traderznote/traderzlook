// Pure animation values: the eased time-scale scroll and the last-price pulse.
// The kinetic fling lives in time-scale/navigator.ts.
import type { HorzAnimation } from './time-scale/navigator';

export const SCROLL_ANIMATION_DURATION_MS = 350;

/** `1 − (1 − p)³`; input clamped to [0,1] so a late `now` never overshoots or rewinds. */
export function easeOutCubic(progress: number): number {
  const p = progress < 0 ? 0 : progress > 1 ? 1 : progress;
  const inv = 1 - p;
  return 1 - inv * inv * inv;
}

/** Eases the right offset from `from` to `to`; hits both endpoints exactly. */
export function createScrollAnimation(
  from: number,
  to: number,
  now: number,
  duration: number = SCROLL_ANIMATION_DURATION_MS,
): HorzAnimation {
  const span = to - from;

  const positionAt = (t: number): number => {
    if (!(duration > 0)) return to;
    return from + span * easeOutCubic((t - now) / duration);
  };

  const finished = (t: number): boolean => {
    if (!(duration > 0)) return true;
    return t - now >= duration;
  };

  return { finished, positionAt };
}

export const PULSE_PERIOD_MS = 2600;

/** Color and the center-dot radius are applied in views, keeping the model free of gfx types. */
export interface PulseFrame {
  /** Outer circle radius, media px. */
  readonly radius: number;
  readonly fillAlpha: number;
  readonly strokeAlpha: number;
}

/**
 * Keyframes by normalized phase, linearly interpolated between rows:
 *   t∈[0, 0.25]     radius 4→10,  fill 0.25→0, stroke 0.4→0.8
 *   t∈[0.25, 0.525] radius 10→14, fill 0,      stroke 0.8→0
 *   t∈[0.525, 1]    rest
 */
export const PULSE_KEYFRAMES: readonly (PulseFrame & { readonly t: number })[] = [
  { t: 0, radius: 4, fillAlpha: 0.25, strokeAlpha: 0.4 },
  { t: 0.25, radius: 10, fillAlpha: 0, strokeAlpha: 0.8 },
  { t: 0.525, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
  { t: 1, radius: 14, fillAlpha: 0, strokeAlpha: 0 },
];

function lerp(a: number, b: number, u: number): number {
  return a + (b - a) * u;
}

/** `t` is clamped to [0,1]. */
export function pulseFrameAtPhase(t: number): PulseFrame {
  const phase = t < 0 ? 0 : t > 1 ? 1 : t;
  for (let i = 1; i < PULSE_KEYFRAMES.length; i++) {
    const k = PULSE_KEYFRAMES[i] as PulseFrame & { t: number };
    if (phase <= k.t) {
      const prev = PULSE_KEYFRAMES[i - 1] as PulseFrame & { t: number };
      const denom = k.t - prev.t;
      const u = denom > 0 ? (phase - prev.t) / denom : 0;
      return {
        radius: lerp(prev.radius, k.radius, u),
        fillAlpha: lerp(prev.fillAlpha, k.fillAlpha, u),
        strokeAlpha: lerp(prev.strokeAlpha, k.strokeAlpha, u),
      };
    }
  }
  const last = PULSE_KEYFRAMES[PULSE_KEYFRAMES.length - 1] as PulseFrame;
  return { radius: last.radius, fillAlpha: last.fillAlpha, strokeAlpha: last.strokeAlpha };
}

export interface PulseAnimation {
  /** Re-arm at Overlay only: promoting to Render would re-run autoscale every frame. */
  readonly level: 'overlay';
  done(now: number): boolean;
  frameAt(now: number): PulseFrame;
}

export type LastPriceAnimationMode = 'disabled' | 'continuous' | 'on-data-update';

/** `endTime` is Infinity for 'continuous'. */
export function createPulseAnimation(startTime: number, endTime: number): PulseAnimation {
  const frameAt = (now: number): PulseFrame => {
    const elapsed = now - startTime;
    const e = elapsed > 0 ? elapsed % PULSE_PERIOD_MS : 0;
    return pulseFrameAtPhase(e / PULSE_PERIOD_MS);
  };

  const done = (now: number): boolean => now >= endTime;

  return { level: 'overlay', done, frameAt };
}

/**
 * 'on-data-update' anti-stutter rule: restart on a new bar, unless less than a
 * quarter-period remains, in which case extend the end by one period and keep the phase.
 */
export function extendPulseEnd(
  currentStart: number,
  currentEnd: number,
  now: number,
): { startTime: number; endTime: number } {
  const remaining = currentEnd - now;
  if (remaining > 0 && remaining < PULSE_PERIOD_MS / 4) {
    return { startTime: currentStart, endTime: currentEnd + PULSE_PERIOD_MS };
  }
  return { startTime: now, endTime: now + PULSE_PERIOD_MS };
}
