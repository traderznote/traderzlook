// Built-in pan / zoom / reset / axis-drag behaviors as ordinary priority-0 router
// registrations, so a tool registered at a higher priority makes them yield.
import type { Unsubscribe } from '../../core';
import type { GestureEvent, GestureResponse, IInteractionRouter } from './types';

/** One intent per gesture; the host implements these against the model navigators. */
export interface DefaultBehaviorPorts {
  pan(deltaXpx: number): void;
  /** A drag on the pane body pans price too; the first move pins autoscale off. */
  priceScroll(paneIndex: number, deltaYpx: number): void;
  zoom(step: number, atX: number): void;
  resetPane(paneIndex: number): void;
  priceAxisDrag(paneIndex: number, deltaYpx: number, axis: 'left' | 'right'): void;
  clearHover(): void;
  /** Kinetic-scroll bookkeeping. */
  panStart?(): void;
  panEnd?(pointerType: GestureEvent['pointerType']): void;
}

/** Absent ⇒ enabled. */
export interface BehaviorGates {
  readonly handleScroll?: boolean;
  readonly handleScale?: boolean;
}

/** Returns one Unsubscribe that removes every registration. */
export function registerDefaultBehaviors(
  router: IInteractionRouter,
  ports: DefaultBehaviorPorts,
  gates: BehaviorGates = {},
): Unsubscribe {
  const subs: Unsubscribe[] = [];
  const scroll = gates.handleScroll !== false;
  const scale = gates.handleScale !== false;

  if (scroll) {
    subs.push(router.register({ kinds: ['drag'], surfaces: ['pane'], priority: 0, handler: (e) => panHandler(e, ports) }));
  }

  // Vertical (incl. ctrl+vertical) wheel zooms; horizontal pans.
  if (scale || scroll) {
    subs.push(router.register({ kinds: ['wheel'], surfaces: ['pane'], priority: 0, handler: (e) => wheelHandler(e, ports, scale, scroll) }));
  }

  subs.push(router.register({ kinds: ['double-tap'], surfaces: ['pane'], priority: 0, handler: (e) => resetHandler(e, ports) }));

  if (scale) {
    subs.push(router.register({ kinds: ['drag'], surfaces: ['price-axis', 'time-axis'], priority: 0, handler: (e) => axisDragHandler(e, ports) }));
  }

  return () => {
    for (const u of subs) u();
  };
}

function panHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  if (e.phase === 'start') {
    ports.clearHover();
    ports.panStart?.();
  } else if (e.phase === 'end') ports.panEnd?.(e.pointerType);
  else if (e.phase === 'move') {
    ports.pan(e.deltaX);
    ports.priceScroll(e.paneIndex, e.deltaY);
  }
  return 'claim'; // hold the exclusive stream through end/cancel
}

function wheelHandler(e: GestureEvent, ports: DefaultBehaviorPorts, scale: boolean, scroll: boolean): GestureResponse {
  const zoom = e.wheelDeltaY ?? 0; // ±1-clamped zoom step (ctrl folded in by the host)
  const dx = e.wheelDeltaX ?? 0; // normalized horizontal scroll px
  // Apply BOTH legs of a diagonal wheel (trackpad): zoom AND scroll, not either/or.
  let acted = false;
  if (scale && zoom !== 0) {
    ports.zoom(zoom, e.x);
    acted = true;
  }
  if (scroll && dx !== 0) {
    ports.pan(dx);
    acted = true;
  }
  return acted ? 'claim' : 'pass';
}

function resetHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  ports.resetPane(e.paneIndex);
  return 'claim';
}

function axisDragHandler(e: GestureEvent, ports: DefaultBehaviorPorts): GestureResponse {
  if (e.phase === 'start') return 'claim';
  if (e.phase !== 'move') return 'claim';
  if (e.surface === 'time-axis') ports.zoom(-e.deltaX * 0.01, e.x);
  else ports.priceAxisDrag(e.paneIndex, e.deltaY, e.axis ?? 'right');
  return 'claim';
}
