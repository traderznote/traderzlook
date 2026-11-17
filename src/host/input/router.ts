// Priority-ordered gesture dispatch (ties most-recent-first). The first 'claim' wins, and
// a claimed stream gets exclusive move/end/cancel.
import { assert } from '../../core';
import type { Unsubscribe } from '../../core';
import type {
  GestureEvent,
  GestureKind,
  GestureRegistration,
  IInteractionRouter,
  SurfaceKind,
} from './types';

// Claiming a streamed kind opens an exclusive stream; discrete kinds are a single 'fire'.
const STREAMED: ReadonlySet<GestureKind> = new Set<GestureKind>(['drag', 'long-press', 'pinch']);

const DEFAULT_SURFACES: readonly SurfaceKind[] = ['pane'];

interface Entry {
  reg: GestureRegistration;
  surfaces: readonly SurfaceKind[];
  seq: number; // monotonic; higher = more recent
  live: boolean; // flipped false on unregister (tombstone until the walk re-sorts)
}

/** Only one streamed gesture is in flight at a time, so a single `#active` claimant slot suffices. */
export class InteractionRouter implements IInteractionRouter {
  readonly #entries: Entry[] = [];
  #seq = 0;
  #active: Entry | null = null; // the claimant of the in-flight streamed gesture
  #activeEvent: GestureEvent | null = null; // latest event of that stream, for a synthetic cancel
  #disposed = false;

  register(registration: GestureRegistration): Unsubscribe {
    if (__DEV__) {
      assert(!this.#disposed, 'InteractionRouter.register after dispose (public-api §13.5)');
      assert(registration.kinds.length > 0, 'GestureRegistration.kinds must be non-empty');
    }
    const entry: Entry = {
      reg: registration,
      surfaces: registration.surfaces ?? DEFAULT_SURFACES,
      seq: this.#seq++,
      live: true,
    };
    this.#entries.push(entry);
    return () => this.#unregister(entry);
  }

  dispatch(e: GestureEvent): void {
    if (this.#disposed) return;
    const opening = e.phase === 'fire' || e.phase === 'start';
    if (!opening) {
      this.#dispatchTail(e);
      return;
    }
    for (const entry of this.#ordered()) {
      if (!entry.live) continue; // a prior synchronous handler may have unregistered it mid-walk
      if (!this.#matches(entry, e)) continue;
      if (entry.reg.handler(e) === 'claim') {
        if (e.phase === 'start' && STREAMED.has(e.kind)) {
          this.#active = entry;
          this.#activeEvent = e;
        }
        return;
      }
    }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    const active = this.#active;
    const open = this.#activeEvent;
    this.#active = null;
    this.#activeEvent = null;
    if (active !== null && active.live && open !== null) active.reg.handler(cancelOf(open));
    this.#entries.length = 0;
  }

  // Tail events go only to the active claimant; if nothing claimed the 'start', they are dropped.
  #dispatchTail(e: GestureEvent): void {
    const active = this.#active;
    if (active === null) return;
    this.#activeEvent = e; // so a synthetic cancel carries the latest position
    if (active.live) active.reg.handler(e);
    if (e.phase === 'end' || e.phase === 'cancel') {
      this.#active = null;
      this.#activeEvent = null;
    }
  }

  // Re-sorted per opening event; registrations are few, so this stays cheap.
  #ordered(): Entry[] {
    const live = this.#entries.filter((x) => x.live);
    live.sort((a, b) => b.reg.priority - a.reg.priority || b.seq - a.seq);
    return live;
  }

  #matches(entry: Entry, e: GestureEvent): boolean {
    return entry.reg.kinds.includes(e.kind) && entry.surfaces.includes(e.surface);
  }

  // Unregistering a claimant mid-stream delivers it a final 'cancel'.
  #unregister(entry: Entry): void {
    if (!entry.live) return;
    entry.live = false;
    const i = this.#entries.indexOf(entry);
    if (i >= 0) this.#entries.splice(i, 1);
    if (this.#active === entry) {
      const open = this.#activeEvent;
      this.#active = null;
      this.#activeEvent = null;
      if (!this.#disposed && open !== null) entry.reg.handler(cancelOf(open));
    }
  }
}

// Carries the latest stream context so the claimant releases state against the right
// target; a cancel reports no further motion.
function cancelOf(latest: GestureEvent): GestureEvent {
  return { ...latest, phase: 'cancel', deltaX: 0, deltaY: 0 };
}
