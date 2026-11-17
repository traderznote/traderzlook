// Z-band scene registry for one surface: band membership, within-band order,
// per-source display-list caching, and per-layer compositing.
//
// Sources cache their own lists; a clean source must return the identical array, so
// re-emission is detected purely by array identity. Within a band, order is
// (ownerZ, attachSeq); the hovered owner's Series-band sources are lifted on top at
// composite time without mutating registration order.
import { assert } from '../../core';
import type { IFrameCounters } from '../../core';
import { ZBand } from '../../gfx';
import type { DisplayList, LayerId, SceneSource, ViewFrame } from '../../gfx';

export interface SourceMeta {
  /** The owner's dense z-index within the band (series order, primitive z, …). */
  readonly ownerZ: number;
  /** The unit the hovered-on-top reorder lifts; sources of one series share it. */
  readonly ownerId: number;
}

interface Entry {
  readonly source: SceneSource;
  readonly ownerZ: number;
  readonly ownerId: number;
  readonly attachSeq: number;
  cachedLists: readonly DisplayList[] | undefined;
}

const BASE_MAX = ZBand.Labels; // bands 0–5 render to base
const isBaseBand = (z: ZBand): boolean => z <= BASE_MAX;

function bandInLayer(z: ZBand, layer: LayerId): boolean {
  return layer === 'base' ? isBaseBand(z) : !isBaseBand(z);
}

export class PaneScene {
  readonly #entries: Entry[] = [];
  #attachCounter = 0;
  #hoveredOwnerId: number | null = null;
  // Reused frame-to-frame; grows by amortised doubling, never shrinks.
  #out: DisplayList[] = [];

  /** Sources whose `displayLists()` array reference changed in the last composite.
   *  Overlay composites must re-emit 0 base-band sources. */
  sourcesReEmitted = 0;
  /** A source believed clean returned a different array than its cache. */
  identityViolations = 0;
  // Set by the host under __TN_PROFILE__; every ++ strips out without the define.
  #counters: IFrameCounters | undefined;

  setCounters(counters: IFrameCounters): void {
    this.#counters = counters;
  }

  /** Returns a handle (the attach sequence); attach order is the final tie-break. */
  register(source: SceneSource, meta: SourceMeta): number {
    const entry: Entry = {
      source,
      ownerZ: meta.ownerZ,
      ownerId: meta.ownerId,
      attachSeq: this.#attachCounter++,
      cachedLists: undefined,
    };
    this.#entries.push(entry);
    return entry.attachSeq;
  }

  unregister(source: SceneSource): void {
    const i = this.#entries.findIndex((e) => e.source === source);
    if (i >= 0) this.#entries.splice(i, 1);
  }

  size(): number {
    return this.#entries.length;
  }

  setHoveredOwner(ownerId: number | null): void {
    this.#hoveredOwnerId = ownerId;
  }

  hoveredOwner(): number | null {
    return this.#hoveredOwnerId;
  }

  /**
   * Update every source in `layer`, then return their lists in (band, ownerZ,
   * attachSeq) order with the hovered owner lifted. Clean sources' lists are reused
   * by reference. The returned array is a scratch buffer, valid until the next
   * composite of either layer.
   */
  composite(layer: LayerId, frame: ViewFrame): readonly DisplayList[] {
    this.sourcesReEmitted = 0;
    this.#out.length = 0;

    const order = this.#orderedEntries(layer);
    for (let k = 0; k < order.length; k++) {
      const e = order[k]!;
      e.source.update(frame);
      const lists = e.source.displayLists();
      const reEmitted = lists !== e.cachedLists;
      if (reEmitted) {
        this.sourcesReEmitted++;
        e.cachedLists = lists;
      }
      if (__TN_PROFILE__ && this.#counters !== undefined) {
        const c = this.#counters;
        if (reEmitted) c.sourcesReEmitted++;
        else c.sourcesCached++;
        c.displayLists += lists.length;
        for (let j = 0; j < lists.length; j++) c.drawCommands += lists[j]!.commands.length;
      }
      for (let j = 0; j < lists.length; j++) this.#out.push(lists[j]!);
    }
    return this.#out;
  }

  #orderedEntries(layer: LayerId): Entry[] {
    const inLayer: Entry[] = [];
    for (let i = 0; i < this.#entries.length; i++) {
      const e = this.#entries[i]!;
      if (bandInLayer(e.source.zBand, layer)) inLayer.push(e);
    }
    const hovered = this.#hoveredOwnerId;
    inLayer.sort((a, b) => compareEntries(a, b, hovered));
    return inLayer;
  }

  /** Test/inspection hook. `undefined` before the first composite. */
  cachedListsOf(source: SceneSource): readonly DisplayList[] | undefined {
    const e = this.#entries.find((x) => x.source === source);
    return e?.cachedLists;
  }

  /** Asserts a source the caller believes clean still holds the `before` array;
   *  bumps `identityViolations` on a mismatch. */
  assertCleanIdentity(source: SceneSource, before: readonly DisplayList[] | undefined): boolean {
    const now = this.cachedListsOf(source);
    const ok = now === before;
    if (!ok) {
      this.identityViolations++;
      if (__TN_PROFILE__ && this.#counters !== undefined) this.#counters.cachedListIdentityViolations++;
      if (__DEV__) assert(ok, 'clean source returned a non-identical display-list array (perf §4.4.2)');
    }
    return ok;
  }
}

function compareEntries(a: Entry, b: Entry, hoveredOwnerId: number | null): number {
  // Band first: the hovered lift is band-local and must never float a Series source
  // above the AboveSeries/Labels bands.
  if (a.source.zBand !== b.source.zBand) return a.source.zBand - b.source.zBand;
  if (hoveredOwnerId !== null && a.source.zBand === ZBand.Series) {
    const aLift = a.ownerId === hoveredOwnerId;
    const bLift = b.ownerId === hoveredOwnerId;
    if (aLift !== bLift) return aLift ? 1 : -1;
  }
  if (a.ownerZ !== b.ownerZ) return a.ownerZ - b.ownerZ;
  return a.attachSeq - b.attachSeq;
}
