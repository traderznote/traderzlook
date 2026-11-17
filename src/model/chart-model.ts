// Chart-model registry: panes, chart options and UpdateMask assembly. The model hands
// masks to one injected callback; the host's scheduler coalesces and schedules frames.
import { assert, changedPaths, mergeOptions, type DeepPartial } from '../core';
import type { IHorzScaleBehavior } from '../data';
import { PaneManager } from './pane-manager';
import { reduceHorzCommands, type HorzScaleCommand } from './time-scale/navigator';
import {
  DEFAULT_CHART_OPTIONS,
  type ChartOptions,
  type PaneId,
} from './shared';

//   Overlay: repaint overlay layers only (crosshair, hover, cursor primitives)
//   Render:  recompute autoscale + repaint base layers; no DOM/layout work
//   Layout:  re-sync widget tree, re-measure axes, resize surfaces, then Render
export const UpdateLevel = {
  None: 0,
  Overlay: 1,
  Render: 2,
  Layout: 3,
} as const;
export type UpdateLevel = (typeof UpdateLevel)[keyof typeof UpdateLevel];

export interface UpdateMask {
  readonly level: UpdateLevel;
  /** Panes needing a one-shot momentary autoscale. */
  readonly autoscalePanes: ReadonlySet<PaneId>;
  readonly horzCommands: readonly HorzScaleCommand[];
}

export interface MaskInit {
  level: UpdateLevel;
  autoscalePanes?: ReadonlySet<PaneId>;
  horzCommands?: readonly HorzScaleCommand[];
}

const EMPTY_PANES: ReadonlySet<PaneId> = new Set();
const NO_COMMANDS: readonly HorzScaleCommand[] = [];

/** Dev-asserts: autoscale panes or horz commands require level ≥ Render. */
export function createMask(init: MaskInit): UpdateMask {
  const autoscalePanes = init.autoscalePanes ?? EMPTY_PANES;
  const horzCommands = init.horzCommands ?? NO_COMMANDS;
  const hasWork = autoscalePanes.size > 0 || horzCommands.length > 0;

  assert(
    !(init.level === UpdateLevel.None && hasWork),
    'UpdateMask: level=None must carry no autoscale panes or horz commands (architecture §4.4)',
  );
  assert(
    !(init.level < UpdateLevel.Render && hasWork),
    'UpdateMask: queuing an autoscale pane or horz command requires level ≥ Render (architecture §4.4)',
  );

  return {
    level: init.level,
    autoscalePanes,
    horzCommands,
  };
}

export function emptyMask(): UpdateMask {
  return createMask({ level: UpdateLevel.None });
}

/**
 * Monotone merge: max level, union of panes, and b's commands replayed into a's through
 * `reduceHorzCommands` so the replace/append/cancel rules hold across a merge.
 */
export function mergeMasks(a: UpdateMask, b: UpdateMask): UpdateMask {
  const level = Math.max(a.level, b.level) as UpdateLevel;

  let autoscalePanes: ReadonlySet<PaneId>;
  if (b.autoscalePanes.size === 0) {
    autoscalePanes = a.autoscalePanes;
  } else if (a.autoscalePanes.size === 0) {
    autoscalePanes = b.autoscalePanes;
  } else {
    const union = new Set<PaneId>(a.autoscalePanes);
    for (const p of b.autoscalePanes) union.add(p);
    autoscalePanes = union;
  }

  let horzCommands = a.horzCommands;
  for (const cmd of b.horzCommands) horzCommands = reduceHorzCommands(horzCommands, cmd);

  return createMask({ level, autoscalePanes, horzCommands });
}

interface PathRule {
  readonly prefix: string;
  readonly level: UpdateLevel;
}

// Option path → invalidation level; first matching prefix wins.
const PATH_RULES: readonly PathRule[] = [
  { prefix: 'width', level: UpdateLevel.Layout },
  { prefix: 'height', level: UpdateLevel.Layout },
  { prefix: 'autoSize', level: UpdateLevel.Layout },
  { prefix: 'layout', level: UpdateLevel.Layout },
  { prefix: 'crosshair', level: UpdateLevel.Overlay },
  { prefix: 'grid', level: UpdateLevel.Render },
  { prefix: 'hoveredSeriesOnTop', level: UpdateLevel.Render },
  { prefix: 'timeScale', level: UpdateLevel.Layout },
  { prefix: 'rightPriceScale', level: UpdateLevel.Layout },
  { prefix: 'leftPriceScale', level: UpdateLevel.Layout },
  { prefix: 'localization', level: UpdateLevel.Layout },
];

function levelForPath(path: string): UpdateLevel {
  for (const rule of PATH_RULES) {
    if (path === rule.prefix || path.startsWith(`${rule.prefix}.`)) return rule.level;
  }
  return UpdateLevel.None;
}

/** Max level over the changed paths; unknown paths map to None. */
export function invalidationLevelForPaths(paths: ReadonlySet<string>): UpdateLevel {
  let level: UpdateLevel = UpdateLevel.None;
  for (const path of paths) {
    const l = levelForPath(path);
    if (l > level) level = l;
  }
  return level;
}

export type InvalidateCallback = (mask: UpdateMask) => void;

export interface ChartModelInit<H = unknown, I = unknown> {
  readonly behavior: IHorzScaleBehavior<H, I>;
  readonly invalidate: InvalidateCallback;
  readonly options?: DeepPartial<ChartOptions>;
}

export class ChartModel<H = unknown, I = unknown> {
  readonly #behavior: IHorzScaleBehavior<H, I>;
  readonly #invalidate: InvalidateCallback;
  readonly #panes = new PaneManager();
  #options: ChartOptions;

  constructor(init: ChartModelInit<H, I>) {
    this.#behavior = init.behavior;
    this.#invalidate = init.invalidate;
    this.#options = mergeOptions(
      DEFAULT_CHART_OPTIONS,
      init.options ?? {},
      DEFAULT_CHART_OPTIONS,
    );
    if (this.#options.addDefaultPane) this.#panes.addPane();
  }

  behavior(): IHorzScaleBehavior<H, I> {
    return this.#behavior;
  }

  panes(): PaneManager {
    return this.#panes;
  }

  /** A snapshot copy, never the live object. */
  options(): ChartOptions {
    return structuredCloneOptions(this.#options);
  }

  /** Fires one mask at the max level of the changed paths; a no-op patch fires nothing. */
  applyOptions(patch: DeepPartial<ChartOptions>): void {
    const before = this.#options;
    const after = mergeOptions(before, patch, DEFAULT_CHART_OPTIONS);
    const paths = changedPaths(before, after);
    this.#options = after;
    const level = invalidationLevelForPaths(paths);
    if (level !== UpdateLevel.None) this.#invalidate(createMask({ level }));
  }

  queueHorzCommand(command: HorzScaleCommand): void {
    this.#invalidate(
      createMask({ level: UpdateLevel.Render, horzCommands: [command] }),
    );
  }

  invalidateAutoscale(paneId: PaneId): void {
    this.#invalidate(
      createMask({ level: UpdateLevel.Render, autoscalePanes: new Set([paneId]) }),
    );
  }

  invalidate(level: UpdateLevel): void {
    if (level !== UpdateLevel.None) this.#invalidate(createMask({ level }));
  }
}

/** Copies nested groups so `options()` never aliases the live object. */
function structuredCloneOptions(o: ChartOptions): ChartOptions {
  return {
    ...o,
    layout: { ...o.layout, background: { ...o.layout.background } },
    grid: {
      vertLines: { ...o.grid.vertLines },
      horzLines: { ...o.grid.horzLines },
    },
    crosshair: { ...o.crosshair },
    ...(o.timeScale !== undefined && { timeScale: { ...o.timeScale } }),
    ...(o.rightPriceScale !== undefined && { rightPriceScale: { ...o.rightPriceScale } }),
    ...(o.leftPriceScale !== undefined && { leftPriceScale: { ...o.leftPriceScale } }),
    ...(o.localization !== undefined && { localization: { ...o.localization } }),
  };
}
