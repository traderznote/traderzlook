// DOM Pointer-Events + wheel adapter: feeds a surface's GestureMachine in surface-local
// media px and routes wheel through normalizeWheel. No gesture logic here.
import type { Unsubscribe } from '../../core';
import type { GestureMachine, GesturePointer } from './gestures';
import { normalizeWheel } from './wheel';
import type { PointerKind } from './types';

/** Read through a getter on every event so the translation tracks scroll/resize without re-attaching. */
export interface ContentOrigin {
  readonly left: number;
  readonly top: number;
}

/** Already surface-local; the host turns it into a 'wheel' GestureEvent. */
export interface WheelIntent {
  readonly scroll: number;
  readonly zoom: number;
  readonly x: number; // surface-local media x the zoom anchors on
  readonly y: number;
  readonly ctrlKey: boolean;
}

export interface DomInputTarget {
  addEventListener(type: string, listener: (e: never) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (e: never) => void, options?: unknown): void;
  setPointerCapture?(pointerId: number): void;
  releasePointerCapture?(pointerId: number): void;
}

interface PointerEventLike {
  pointerId: number;
  clientX: number;
  clientY: number;
  buttons: number;
  pointerType: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

interface WheelEventLike {
  deltaMode: number;
  deltaX: number;
  deltaY: number;
  clientX: number;
  clientY: number;
  ctrlKey: boolean;
  preventDefault(): void;
}

function pointerKindOf(t: string): PointerKind {
  return t === 'touch' ? 'touch' : t === 'pen' ? 'pen' : 'mouse';
}

export interface DomInputConfig {
  readonly wheelSpeed?: number;
  readonly windowsChromium?: boolean;
  readonly getDpr?: () => number;
  /** pointerleave: the host clears the crosshair so it does not stick at the last position. */
  readonly onLeave?: () => void;
}

/** Returns an Unsubscribe that removes every listener. This is the one place client
 *  coords are shifted to surface-local media px. */
export function attachDomInput(
  target: DomInputTarget,
  machine: GestureMachine,
  wheelSink: (intent: WheelIntent) => void,
  getContentOrigin: () => ContentOrigin,
  config: DomInputConfig = {},
): Unsubscribe {
  const speed = config.wheelSpeed ?? 1;
  const winChromium = config.windowsChromium ?? false;
  const getDpr = config.getDpr ?? (() => 1);

  const toPointer = (e: PointerEventLike): GesturePointer => {
    const origin = getContentOrigin();
    return {
      pointerId: e.pointerId,
      clientX: e.clientX - origin.left,
      clientY: e.clientY - origin.top,
      buttons: e.buttons,
      pointerType: pointerKindOf(e.pointerType),
      ctrlKey: e.ctrlKey,
      altKey: e.altKey,
      shiftKey: e.shiftKey,
      metaKey: e.metaKey,
    };
  };

  const onPointerDown = (e: PointerEventLike): void => {
    // Capture so a drag keeps delivering moves after the pointer leaves the surface.
    try {
      target.setPointerCapture?.(e.pointerId);
    } catch {
      /* setPointerCapture can throw for a stale id; the gesture still proceeds */
    }
    machine.pointerDown(toPointer(e));
  };
  const onPointerMove = (e: PointerEventLike): void => {
    machine.pointerMove(toPointer(e));
  };
  const onPointerUp = (e: PointerEventLike): void => {
    machine.pointerUp(toPointer(e));
    try {
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      /* releasing a non-captured id throws; nothing to do */
    }
  };
  const onPointerCancel = (e: PointerEventLike): void => {
    machine.pointerCancel(toPointer(e));
    try {
      target.releasePointerCapture?.(e.pointerId);
    } catch {
      /* as above */
    }
  };
  // Capture keeps moves flowing during a drag, so this fires on a genuine hover-exit;
  // clearHover is idempotent, so a stray fire mid-drag is harmless.
  const onLeave = (): void => {
    config.onLeave?.();
  };
  const onWheel = (e: WheelEventLike): void => {
    // Keep the page from scrolling / pinch-zooming under the chart.
    e.preventDefault();
    const n = normalizeWheel(e, speed, winChromium, getDpr());
    const origin = getContentOrigin();
    wheelSink({
      scroll: n.scroll,
      zoom: n.zoom,
      x: e.clientX - origin.left,
      y: e.clientY - origin.top,
      ctrlKey: n.ctrlKey,
    });
  };

  // `passive:false` on wheel is what makes preventDefault honored (it is preventable).
  const wheelOpts = { passive: false };
  target.addEventListener('pointerdown', onPointerDown as (e: never) => void);
  target.addEventListener('pointermove', onPointerMove as (e: never) => void);
  target.addEventListener('pointerup', onPointerUp as (e: never) => void);
  target.addEventListener('pointercancel', onPointerCancel as (e: never) => void);
  target.addEventListener('pointerleave', onLeave as (e: never) => void);
  target.addEventListener('wheel', onWheel as (e: never) => void, wheelOpts);

  return () => {
    target.removeEventListener('pointerdown', onPointerDown as (e: never) => void);
    target.removeEventListener('pointermove', onPointerMove as (e: never) => void);
    target.removeEventListener('pointerup', onPointerUp as (e: never) => void);
    target.removeEventListener('pointercancel', onPointerCancel as (e: never) => void);
    target.removeEventListener('pointerleave', onLeave as (e: never) => void);
    target.removeEventListener('wheel', onWheel as (e: never) => void, wheelOpts);
  };
}
