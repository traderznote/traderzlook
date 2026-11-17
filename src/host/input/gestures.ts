// Pointer gesture FSM (Idle → PendingPress → Drag | LongPress | Pinch) plus a kinetic tracker.
// No DOM listeners or timers: the host feeds pointer events and pumps tick().

import { assert, type Coordinate } from '../../core';
import type { GestureEvent, GesturePhase, GestureKind, PointerKind, SurfaceKind } from './types';

export const GESTURE_THRESHOLDS = {
  dragSlopPx: 5, // manhattan distance: press → drag
  cancelTapPx: 5, // touch movement cancelling a tap
  doubleClickPx: 5, // max distance between the two clicks of a mouse double-click
  doubleTapPx: 30, // max distance between the two taps of a touch double-tap
  longPressMs: 240,
  doubleTapWindowMs: 500, // double-click/tap window, started at the FIRST down
} as const;

// Pixel space; converting to bars is the navigator's job.
export const KINETIC = {
  minSpeed: 0.2, // px/ms: below this, no fling
  maxSpeed: 7, // px/ms: per-segment speed clamp
  dumping: 0.997, // exponential decay base (per ms)
  minMovePx: 15, // ignore sub-this jitter when sampling
  maxStartDelayMs: 50, // release later than this after the last sample → no fling
  epsilon: 1, // residual distance at which the fling is "finished"
  maxSamples: 4,
} as const;

export type TrackingExitMode = 'OnNextTap' | 'OnTouchEnd';

export interface GesturePointer {
  pointerId: number;
  clientX: number;
  clientY: number;
  buttons: number; // bitmask; 0 == no button down (hover)
  pointerType: PointerKind;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export interface SurfaceTarget {
  surface: SurfaceKind;
  paneIndex: number; // −1 for time-axis
  axis?: 'left' | 'right'; // price-axis only
}

export type GestureSink = (e: GestureEvent) => void;
export type Clock = () => number; // ms epoch — injected so tests drive time

const manhattan = (ax: number, ay: number, bx: number, by: number): number =>
  Math.abs(ax - bx) + Math.abs(ay - by);

// PendingPress holds a down that has not yet resolved to drag / long-press / tap.
const State = {
  Idle: 'idle',
  PendingPress: 'pending',
  Drag: 'drag',
  LongPress: 'longpress', // also the touch-pane tracking state
  Pinch: 'pinch',
} as const;
type State = (typeof State)[keyof typeof State];

interface ActivePointer {
  id: number;
  startX: number;
  startY: number;
  lastX: number; // x of the previous emitted stream event (for deltas)
  lastY: number;
  type: PointerKind;
}

export class GestureMachine {
  readonly #target: SurfaceTarget;
  readonly #now: Clock;
  readonly #sink: GestureSink;

  #state: State = State.Idle;
  #primary: ActivePointer | null = null;
  #pinchAux: { id: number; x: number; y: number } | null = null;
  #pinchStartDist = 0;
  #movedBeforeSecond = false; // a move before the 2nd finger prevents pinch

  #longPressDeadline = 0; // 0 == disarmed
  #trackingExit: TrackingExitMode = 'OnNextTap';
  #tracking = false;
  #exitTrackingOnRelease = false;

  // double-tap window, started at the first down
  #tapCount = 0;
  #tapWindowEnd = 0; // 0 == no window
  #tapX = 0;
  #tapY = 0;
  #pressCancelled = false; // movement past slop / long-press cancels the tap

  constructor(target: SurfaceTarget, clock: Clock, sink: GestureSink) {
    this.#target = target;
    this.#now = clock;
    this.#sink = sink;
  }

  setTrackingExitMode(mode: TrackingExitMode): void {
    this.#trackingExit = mode;
  }

  pointerDown(p: GesturePointer): void {
    const t = this.#now();
    // Second touch finger while a press is live (and no move yet) → pinch.
    if (
      p.pointerType === 'touch' &&
      this.#primary !== null &&
      this.#pinchAux === null &&
      (this.#state === State.PendingPress || this.#state === State.Pinch) &&
      !this.#movedBeforeSecond
    ) {
      this.#startPinch(p);
      return;
    }
    if (this.#primary !== null) return; // single-primary policy; ignore extra downs

    // A mouse event kills any active touch tracking.
    if (p.pointerType === 'mouse' && this.#tracking) this.#exitTracking(p);

    // Tracking re-anchor: a fresh touch while tracking re-bases and arms exit-on-tap.
    if (this.#tracking) {
      this.#exitTrackingOnRelease = true; // a tap (no move) will exit
      this.#primary = this.#mkPointer(p);
      this.#state = State.LongPress;
      return;
    }

    this.#primary = this.#mkPointer(p);
    this.#movedBeforeSecond = false;
    this.#pressCancelled = false;
    this.#state = State.PendingPress;
    this.#longPressDeadline = t + GESTURE_THRESHOLDS.longPressMs;

    if (this.#tapWindowEnd === 0 || t > this.#tapWindowEnd) {
      this.#tapCount = 0;
      this.#tapWindowEnd = t + GESTURE_THRESHOLDS.doubleTapWindowMs;
      this.#tapX = p.clientX;
      this.#tapY = p.clientY;
    }
  }

  pointerMove(p: GesturePointer): void {
    const t = this.#now();
    if (this.#state === State.Pinch && this.#pinchAux !== null) {
      this.#pinchMove(p);
      return;
    }
    if (this.#primary === null || p.pointerId !== this.#primary.id) {
      // No press: a buttonless move is a hover.
      if (this.#primary === null && p.buttons === 0) this.#emitHover(p);
      return;
    }
    this.#movedBeforeSecond = true;

    if (this.#tracking || this.#state === State.LongPress) {
      this.#emitStream('long-press', 'move', p, t);
      this.#exitTrackingOnRelease = false; // it is a drag, not a tap
      return;
    }

    if (this.#state === State.PendingPress) {
      const d = manhattan(p.clientX, p.clientY, this.#primary.startX, this.#primary.startY);
      if (d < GESTURE_THRESHOLDS.dragSlopPx) return;
      // Slop crossed → become a drag; kill the long-press timer + the pending tap.
      this.#pressCancelled = true;
      this.#longPressDeadline = 0;
      this.#tapWindowEnd = 0;
      this.#state = State.Drag;
      this.#emitStream('drag', 'start', p, t);
      return;
    }
    if (this.#state === State.Drag) this.#emitStream('drag', 'move', p, t);
  }

  pointerUp(p: GesturePointer): void {
    const t = this.#now();
    if (this.#state === State.Pinch) {
      this.#endPinch(p, 'end');
      return;
    }
    if (this.#primary === null || p.pointerId !== this.#primary.id) return;

    if (this.#state === State.Drag) {
      this.#emitStream('drag', 'end', p, t);
      this.#reset();
      return;
    }
    if (this.#tracking || this.#state === State.LongPress) {
      const exit = this.#trackingExit === 'OnTouchEnd' || this.#exitTrackingOnRelease;
      if (exit) this.#exitTracking(p);
      else this.#reset(); // stay tracking; just close this sub-press
      return;
    }
    // PendingPress release with no drag/long-press → a tap (and maybe double-tap).
    this.#resolveTap(p, t);
    this.#reset();
  }

  pointerCancel(p: GesturePointer): void {
    const t = this.#now();
    if (this.#state === State.Pinch) {
      this.#endPinch(p, 'cancel');
      return;
    }
    if (this.#primary === null) return;
    if (this.#state === State.Drag) this.#emitStream('drag', 'cancel', p, t);
    else if (this.#tracking || this.#state === State.LongPress)
      this.#emitStream('long-press', 'cancel', p, t);
    this.#tracking = false;
    this.#reset();
  }

  /** Pumped once per frame so the long-press can fire without a timer. */
  tick(): void {
    const t = this.#now();
    if (
      this.#state === State.PendingPress &&
      this.#longPressDeadline !== 0 &&
      t >= this.#longPressDeadline &&
      this.#primary !== null
    ) {
      this.#fireLongPress();
    }
  }

  #mkPointer(p: GesturePointer): ActivePointer {
    return {
      id: p.pointerId,
      startX: p.clientX,
      startY: p.clientY,
      lastX: p.clientX,
      lastY: p.clientY,
      type: p.pointerType,
    };
  }

  #fireLongPress(): void {
    if (__DEV__) assert(this.#primary !== null, 'long-press without a primary pointer');
    this.#longPressDeadline = 0;
    this.#pressCancelled = true;
    this.#tapWindowEnd = 0;
    this.#state = State.LongPress;
    const prim = this.#primary!;
    if (this.#target.surface === 'pane' && prim.type === 'touch') {
      this.#tracking = true;
      this.#exitTrackingOnRelease = false;
    }
    this.#sink(this.#event('long-press', 'start', prim.startX, prim.startY, prim, 0, 0));
  }

  #resolveTap(p: GesturePointer, t: number): void {
    this.#longPressDeadline = 0;
    if (this.#pressCancelled) {
      this.#tapWindowEnd = 0;
      return;
    }
    const prim = this.#primary!;
    this.#tapCount += 1;
    const proximity =
      prim.type === 'touch' ? GESTURE_THRESHOLDS.doubleTapPx : GESTURE_THRESHOLDS.doubleClickPx;
    const windowOpen = this.#tapWindowEnd !== 0 && t <= this.#tapWindowEnd;
    if (windowOpen && this.#tapCount > 1) {
      // The first up already emitted 'tap', so emit double-tap only when near;
      // a far second up emits nothing.
      const near = manhattan(p.clientX, p.clientY, this.#tapX, this.#tapY) < proximity;
      if (near) this.#sink(this.#event('double-tap', 'fire', p.clientX, p.clientY, prim, 0, 0));
      this.#tapWindowEnd = 0; // reset the window after a (would-be) double
    } else {
      this.#sink(this.#event('tap', 'fire', p.clientX, p.clientY, prim, 0, 0));
    }
  }

  #exitTracking(p: GesturePointer): void {
    const prim = this.#primary;
    const x = prim ? prim.lastX : p.clientX;
    const y = prim ? prim.lastY : p.clientY;
    this.#sink(this.#event('long-press', 'end', x, y, prim ?? this.#mkPointer(p), 0, 0));
    this.#tracking = false;
    this.#exitTrackingOnRelease = false;
    this.#reset();
  }

  #startPinch(p: GesturePointer): void {
    const prim = this.#primary!;
    this.#longPressDeadline = 0;
    this.#tapWindowEnd = 0;
    this.#pressCancelled = true;
    this.#pinchAux = { id: p.pointerId, x: p.clientX, y: p.clientY };
    this.#pinchStartDist = Math.hypot(p.clientX - prim.lastX, p.clientY - prim.lastY) || 1;
    this.#state = State.Pinch;
    const midX = (prim.lastX + p.clientX) / 2;
    const midY = (prim.lastY + p.clientY) / 2;
    const e = this.#event('pinch', 'start', midX, midY, prim, 0, 0);
    e.pinchScale = 1;
    this.#sink(e);
  }

  #pinchMove(p: GesturePointer): void {
    const prim = this.#primary!;
    const aux = this.#pinchAux!;
    if (p.pointerId === aux.id) {
      aux.x = p.clientX;
      aux.y = p.clientY;
    } else if (p.pointerId === prim.id) {
      prim.lastX = p.clientX;
      prim.lastY = p.clientY;
    } else return;
    const dist = Math.hypot(aux.x - prim.lastX, aux.y - prim.lastY);
    const midX = (prim.lastX + aux.x) / 2;
    const midY = (prim.lastY + aux.y) / 2;
    const e = this.#event('pinch', 'move', midX, midY, prim, 0, 0);
    e.pinchScale = dist / this.#pinchStartDist;
    this.#sink(e);
  }

  #endPinch(p: GesturePointer, phase: 'end' | 'cancel'): void {
    const prim = this.#primary;
    const aux = this.#pinchAux;
    const midX = prim && aux ? (prim.lastX + aux.x) / 2 : p.clientX;
    const midY = prim && aux ? (prim.lastY + aux.y) / 2 : p.clientY;
    const e = this.#event('pinch', phase, midX, midY, prim ?? this.#mkPointer(p), 0, 0);
    this.#sink(e);
    this.#pinchAux = null;
    this.#reset();
  }

  #emitStream(kind: GestureKind, phase: GesturePhase, p: GesturePointer, _t: number): void {
    const prim = this.#primary!;
    let dx = 0;
    let dy = 0;
    if (phase === 'move' || phase === 'end' || phase === 'cancel') {
      dx = p.clientX - prim.lastX;
      dy = p.clientY - prim.lastY;
    }
    const e = this.#event(kind, phase, p.clientX, p.clientY, prim, dx, dy);
    prim.lastX = p.clientX;
    prim.lastY = p.clientY;
    this.#sink(e);
  }

  #emitHover(p: GesturePointer): void {
    const e: GestureEvent = {
      kind: 'hover',
      phase: 'fire',
      surface: this.#target.surface,
      paneIndex: this.#target.paneIndex,
      x: p.clientX as Coordinate,
      y: p.clientY as Coordinate,
      startX: p.clientX as Coordinate,
      startY: p.clientY as Coordinate,
      deltaX: 0,
      deltaY: 0,
      pointerType: p.pointerType,
      modifiers: { ctrl: p.ctrlKey, alt: p.altKey, shift: p.shiftKey, meta: p.metaKey },
    };
    if (this.#target.axis !== undefined) e.axis = this.#target.axis;
    this.#sink(e);
  }

  #event(
    kind: GestureKind,
    phase: GesturePhase,
    x: number,
    y: number,
    prim: ActivePointer,
    dx: number,
    dy: number,
  ): GestureEvent {
    const e: GestureEvent = {
      kind,
      phase,
      surface: this.#target.surface,
      paneIndex: this.#target.paneIndex,
      x: x as Coordinate,
      y: y as Coordinate,
      startX: prim.startX as Coordinate,
      startY: prim.startY as Coordinate,
      deltaX: dx,
      deltaY: dy,
      pointerType: prim.type,
      modifiers: { ctrl: false, alt: false, shift: false, meta: false },
    };
    if (this.#target.axis !== undefined) e.axis = this.#target.axis;
    return e;
  }

  #reset(): void {
    this.#primary = null;
    this.#pinchAux = null;
    this.#longPressDeadline = 0;
    this.#state = this.#tracking ? State.LongPress : State.Idle;
  }
}

// Pixel-space momentum: distance-weighted multi-segment velocity and closed-form
// exponential-decay position. Feed (pos, t) samples, then `start(pos, now)` for a fling.

export interface KineticFling {
  velocity: number; // v0, px/ms (signed)
  duration: number; // ms until residual movement < ε
  positionAt(t: number): number; // closed-form decayed position at absolute time t
  finished(t: number): boolean;
}

interface Sample {
  pos: number;
  t: number;
}

export class KineticTracker {
  #samples: Sample[] = []; // newest-first

  /** Same-t overwrites the newest sample; sub-minMove jitter is dropped. */
  addPosition(pos: number, t: number): void {
    const newest = this.#samples[0];
    if (newest !== undefined && newest.t === t) {
      newest.pos = pos;
      return;
    }
    if (newest !== undefined && Math.abs(newest.pos - pos) < KINETIC.minMovePx) return;
    this.#samples.unshift({ pos, t });
    if (this.#samples.length > KINETIC.maxSamples) this.#samples.length = KINETIC.maxSamples;
  }

  /** Null when there are < 2 samples, the release is stale, or |v0| < minSpeed. */
  start(currentPos: number, now: number): KineticFling | null {
    const s = this.#samples;
    if (s.length < 2) return null;
    if (now - s[0]!.t > KINETIC.maxStartDelayMs) return null;

    // Segment speeds + distances, newest-first; truncate at the first sign reversal.
    let sumD = 0;
    let weighted = 0;
    let sign0 = 0;
    for (let i = 0; i < s.length - 1; i++) {
      const dt = s[i]!.t - s[i + 1]!.t;
      if (dt === 0) continue;
      const dist = s[i]!.pos - s[i + 1]!.pos;
      let speed = dist / dt;
      if (speed > KINETIC.maxSpeed) speed = KINETIC.maxSpeed;
      else if (speed < -KINETIC.maxSpeed) speed = -KINETIC.maxSpeed;
      const sg = Math.sign(speed);
      if (i === 0) sign0 = sg;
      else if (sg !== 0 && sg !== sign0) break; // reversal: stop including older segments
      sumD += dist;
      weighted += dist * speed;
    }
    if (sumD === 0) return null;
    const v0 = weighted / sumD;
    if (Math.abs(v0) < KINETIC.minSpeed) return null;

    const lnD = Math.log(KINETIC.dumping);
    const startPos = currentPos;
    const t0 = now;
    // Time until the residual movement drops below ε.
    const duration = Math.log((KINETIC.epsilon * lnD) / -Math.abs(v0)) / lnD;
    return {
      velocity: v0,
      duration,
      positionAt(t: number): number {
        return startPos + (v0 * (Math.pow(KINETIC.dumping, t - t0) - 1)) / lnD;
      },
      finished(t: number): boolean {
        return Math.min(t - t0, duration) === duration;
      },
    };
  }
}
