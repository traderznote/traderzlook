// Pane registry. Invariant: ids ('p0','p1',…) are minted in creation order, never reused,
// and survive remove/move/swap, so saved layouts and drawing anchors can re-bind by id.
import { Pane } from './pane';
import { formatPaneId, type PaneId } from './shared';

export class PaneManager {
  /** Top → bottom; `index()` reads this order. */
  readonly #panes: Pane[] = [];
  /** Only ever incremented, so ids are never reused. */
  #nextOrdinal = 0;

  panes(): readonly Pane[] {
    return this.#panes.slice();
  }

  count(): number {
    return this.#panes.length;
  }

  indexOf(pane: Pane): number {
    return this.#panes.indexOf(pane);
  }

  paneById(id: PaneId): Pane | null {
    return this.#panes.find((p) => p.id() === id) ?? null;
  }

  addPane(): Pane {
    const pane = new Pane(formatPaneId(this.#nextOrdinal));
    this.#nextOrdinal++;
    this.#panes.push(pane);
    return pane;
  }

  /** Insert an externally-minted pane (ChartModel's default pane). */
  addExisting(pane: Pane): void {
    this.#panes.push(pane);
  }

  removePane(pane: Pane): void {
    const i = this.#panes.indexOf(pane);
    if (i >= 0) this.#panes.splice(i, 1);
  }

  /** Throws RangeError when out of bounds. */
  moveTo(pane: Pane, targetIndex: number): void {
    const from = this.#panes.indexOf(pane);
    if (from < 0) throw new RangeError('pane is not in this manager');
    if (targetIndex < 0 || targetIndex >= this.#panes.length) {
      throw new RangeError(`pane index ${targetIndex} out of bounds`);
    }
    this.#panes.splice(from, 1);
    this.#panes.splice(targetIndex, 0, pane);
  }

  swapPanes(i: number, j: number): void {
    const n = this.#panes.length;
    if (i < 0 || i >= n || j < 0 || j >= n) {
      throw new RangeError('swapPanes index out of bounds');
    }
    const tmp = this.#panes[i];
    this.#panes[i] = this.#panes[j];
    this.#panes[j] = tmp;
  }
}
