// Collects one snapshot tile per visible surface plus a fill tile per pane separator
// (separators are plain divs and would otherwise be holes in the screenshot).
import type { Rect, Size } from '../core';
import type { Snapshot, SnapshotTile } from '../gfx';
import type { SurfaceHost } from './surface-host';

/** `includeCrosshair` is optional so the bare IRenderBackend.composeSnapshot stays assignable. */
export interface SnapshotComposer {
  composeSnapshot(tiles: readonly SnapshotTile[], mediaSize: Size, includeCrosshair?: boolean): Snapshot;
}

/** Surfaces first, then separator fills over the top. With `includeCrosshair` false the
 *  backend composes the base layer only. */
export function captureScreenshot(
  composer: SnapshotComposer,
  surfaces: readonly SurfaceHost[],
  separators: readonly Rect[],
  separatorColor: string,
  mediaSize: Size,
  includeCrosshair = true,
): Snapshot {
  const tiles: SnapshotTile[] = [];
  for (let i = 0; i < surfaces.length; i++) {
    const sh = surfaces[i]!;
    if (sh.visible()) tiles.push({ rect: sh.rect(), snapshot: sh.snapshot() });
  }
  for (let i = 0; i < separators.length; i++) {
    tiles.push({ rect: separators[i]!, fill: separatorColor });
  }
  return composer.composeSnapshot(tiles, mediaSize, includeCrosshair);
}
