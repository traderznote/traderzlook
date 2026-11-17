// Ranked hit-test service: queries a pane's hit sources and ranks candidates by
// priority tier, then distance, then paint order (visually higher wins ties).
import type { Coordinate } from '../core';
import type { HitCandidate, SceneSource, ViewFrame } from '../gfx';
import { HitPriority } from '../gfx';
import type { HoverTarget } from '../model';

/** One pane hit source. Array order is paint order: a later entry is drawn on top
 *  and wins exact (tier, distance) ties. */
export interface HitSource {
  readonly source: SceneSource;
  readonly sourceId: string;
  readonly seriesId?: string;
}

export interface RankedHit {
  readonly candidate: HitCandidate;
  readonly sourceId: string;
  readonly seriesId?: string;
}

/** Candidates best-first, plus the `HoverTarget` for index 0 (null when nothing was hit). */
export interface HitResult {
  readonly ranked: readonly RankedHit[];
  readonly target: HoverTarget | null;
}

/** Point beats Line/Range; Line and Range tie here and fall through to distance. */
function tier(p: HitPriority): number {
  return p === HitPriority.Point ? 1 : 0;
}

/** < 0 when `a` is the better hit. Paint order is only the final tie-break, after
 *  tier and distance. */
function compare(aPaint: number, a: HitCandidate, bPaint: number, b: HitCandidate): number {
  const ta = tier(a.priority);
  const tb = tier(b.priority);
  if (ta !== tb) return tb - ta;
  if (a.distance !== b.distance) return a.distance - b.distance;
  return bPaint - aPaint;
}

/**
 * Rank every source's hit candidate for the pointer at media `(x, y)`. Allocation is
 * proportional to the number of hits, so a miss-heavy pane allocates nothing.
 */
export function hitTestPane(
  sources: readonly HitSource[],
  x: Coordinate,
  y: Coordinate,
  frame: ViewFrame,
): HitResult {
  const hits: { paint: number; src: HitSource; cand: HitCandidate }[] = [];
  for (let i = 0; i < sources.length; i++) {
    const hs = sources[i]!;
    const cand = hs.source.hitTest?.(x, y, frame) ?? null;
    if (cand !== null) hits.push({ paint: i, src: hs, cand });
  }
  if (hits.length === 0) return EMPTY;

  hits.sort((a, b) => compare(a.paint, a.cand, b.paint, b.cand));

  const ranked: RankedHit[] = hits.map((h) => ({
    candidate: h.cand,
    sourceId: h.src.sourceId,
    seriesId: h.src.seriesId,
  }));
  return { ranked, target: toHoverTarget(ranked[0]!) };
}

/** Optional fields are omitted (not set to `undefined`) so equality stays clean. */
export function toHoverTarget(hit: RankedHit): HoverTarget {
  const c = hit.candidate;
  const t: { -readonly [K in keyof HoverTarget]: HoverTarget[K] } = { sourceId: hit.sourceId };
  if (hit.seriesId !== undefined) t.seriesId = hit.seriesId;
  if (c.externalId !== undefined) t.externalId = c.externalId;
  if (c.cursor !== undefined) t.cursor = c.cursor;
  if (c.data !== undefined) t.data = c.data;
  return t;
}

const EMPTY: HitResult = { ranked: [], target: null };
