// The one surface widget (pane, price axis, time axis or stub): a mount element, an
// injected ISurface and a PaneScene, plus rect application and paint dispatch.
import type { Rect, Size, Unsubscribe } from '../core';
import type { FrameScope, ISurface, LayerId, SurfaceSnapshot, ViewFrame } from '../gfx';
import type { PaneScene } from '../views';
import type { SurfaceKind } from './input/types';
import type { UpdateLevel } from '../model';
import { UpdateLevel as Level } from '../model';
import type { FrameProfiler } from './frame-scheduler';

/** The mount-element members the host touches; `HTMLElement` satisfies it. */
export interface HostElement {
  readonly style: { position: string; left: string; top: string; width: string; height: string; cursor: string };
  appendChild(child: unknown): void;
  removeChild(child: unknown): void;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
}

export interface SurfaceFactory {
  createSurface(mount: HostElement): ISurface;
}

export interface SurfaceConfig {
  readonly kind: SurfaceKind;
  readonly scene: PaneScene;
}

export class SurfaceHost {
  readonly kind: SurfaceKind;
  readonly #mount: HostElement;
  readonly #surface: ISurface;
  readonly #scene: PaneScene;
  readonly #resCancel: Unsubscribe;
  readonly #prof: FrameProfiler | undefined; // __TN_PROFILE__-only replayMs bracket
  #rect: Rect = { x: 0, y: 0, width: 0, height: 0 };
  #visible = false;

  constructor(
    mount: HostElement,
    factory: SurfaceFactory,
    config: SurfaceConfig,
    onResolutionChange: () => void,
    prof?: FrameProfiler,
  ) {
    this.#mount = mount;
    this.#scene = config.scene;
    this.kind = config.kind;
    this.#prof = prof;
    // Lets the scene's composite count view lanes (profiling builds only).
    if (__TN_PROFILE__ && prof !== undefined) this.#scene.setCounters(prof.counters);
    const s = mount.style;
    s.position = 'absolute';
    this.#surface = factory.createSurface(mount);
    // A new suggested bitmap size (DPR / sub-pixel shift) → one coalescing Layout invalidate.
    this.#resCancel = this.#surface.resolutionChanged.subscribe(onResolutionChange);
  }

  scene(): PaneScene {
    return this.#scene;
  }

  /** A 0-area rect marks the surface invisible; it is skipped on paint and screenshot. */
  setRect(rect: Rect): void {
    this.#rect = rect;
    const s = this.#mount.style;
    s.left = `${rect.x}px`;
    s.top = `${rect.y}px`;
    s.width = `${rect.width}px`;
    s.height = `${rect.height}px`;
    this.#visible = rect.width > 0 && rect.height > 0;
    this.#surface.setMediaSize({ width: rect.width, height: rect.height } satisfies Size);
  }

  rect(): Rect {
    return this.#rect;
  }

  visible(): boolean {
    return this.#visible;
  }

  paint(level: UpdateLevel, now: number): void {
    if (!this.#visible || level === Level.None) return;
    const scope: FrameScope = level === Level.Overlay ? 'overlay' : 'full';
    const info = this.#surface.beginFrame(scope);
    const frame: ViewFrame = { frame: info, now };
    if (scope === 'full') this.#render('base', frame);
    this.#render('overlay', frame);
    this.#surface.endFrame();
  }

  #render(layer: LayerId, frame: ViewFrame): void {
    const lists = this.#scene.composite(layer, frame);
    // Bracket the backend replay here, since the host owns the wall clock.
    if (__TN_PROFILE__ && this.#prof !== undefined) {
      const r0 = this.#prof.now();
      this.#surface.renderLayer(layer, lists);
      this.#prof.counters.replayMs += this.#prof.now() - r0;
      return;
    }
    this.#surface.renderLayer(layer, lists);
  }

  snapshot(): SurfaceSnapshot {
    return this.#surface.snapshot();
  }

  dispose(): void {
    this.#resCancel();
    this.#surface.dispose();
  }
}
