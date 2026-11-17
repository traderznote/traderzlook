// Image watermark: an image centered behind the series of a pane, scaled to fit inside
// the padded pane box. The image is uploaded to the backend once, when it loads.
import { DisplayListBuilder, ZBand } from '../../gfx';
import type { DisplayList, ImageHandle, SceneSource, ViewFrame } from '../../gfx';
import type { DeepPartial } from '../../core';
import { createPrimitiveAdapter } from '../shared';
import type { PrimitiveAdapter, PrimitiveTarget } from '../shared';
import type { IPrimitive, PrimitiveContext } from '../../api';

/** `padding` insets each side; `maxWidth`/`maxHeight` cap the fit box (0 = no cap). */
export interface ImageWatermarkOptions {
  visible: boolean;
  imageUrl: string;
  padding: number;
  maxWidth: number;
  maxHeight: number;
  alpha: number;
}

export const imageWatermarkDefaults: ImageWatermarkOptions = {
  visible: true,
  imageUrl: '',
  padding: 0,
  maxWidth: 0,
  maxHeight: 0,
  alpha: 1,
};

export type ImageWatermarkHandle = PrimitiveAdapter<ImageWatermarkOptions>;

interface PaneLike {
  size(): { width: number; height: number };
}

interface LoadedImage {
  readonly handle: ImageHandle;
}

const EMPTY: readonly DisplayList[] = [];

function createWatermarkSource(
  getOptions: () => ImageWatermarkOptions,
  getPane: () => PaneLike | null,
  getImage: () => LoadedImage | null,
  getRev: () => number,
): SceneSource {
  const builder = new DisplayListBuilder();
  let cached: readonly DisplayList[] = EMPTY;
  let sig: string | null = null;

  function build(): readonly DisplayList[] {
    const opts = getOptions();
    const img = getImage();
    const pane = getPane();
    if (!opts.visible || img === null || pane === null) return EMPTY;
    const { width: paneW, height: paneH } = pane.size();
    const naturalW = img.handle.size.width;
    const naturalH = img.handle.size.height;
    // Guards the scale math below against zero/non-finite results.
    if (paneW <= 0 || paneH <= 0 || naturalW <= 0 || naturalH <= 0) return EMPTY;

    let availW = paneW - 2 * opts.padding;
    let availH = paneH - 2 * opts.padding;
    if (opts.maxWidth > 0) availW = Math.min(availW, opts.maxWidth);
    if (opts.maxHeight > 0) availH = Math.min(availH, opts.maxHeight);
    if (availW <= 0 || availH <= 0) return EMPTY;

    // Deliberately not clamped to 1: a small image is scaled up to fill the box.
    const scale = Math.min(availW / naturalW, availH / naturalH);
    const drawW = naturalW * scale;
    const drawH = naturalH * scale;
    const x = Math.round(paneW / 2) - drawW / 2;
    const y = Math.round(paneH / 2) - drawH / 2;

    builder.reset();
    builder.beginList('media');
    builder.image(
      img.handle,
      { x: 0, y: 0, width: naturalW, height: naturalH },
      { x, y, width: drawW, height: drawH },
      opts.alpha,
    );
    return builder.finish();
  }

  return {
    zBand: ZBand.BelowSeries,
    update(_frame: ViewFrame): void {
      const sz = getPane()?.size();
      const img = getImage();
      // `rev` forces a rebuild on option edits and image loads that leave the size unchanged.
      const next = `${getRev()}|${sz?.width}|${sz?.height}|${img !== null}`;
      if (next === sig) return;
      sig = next;
      cached = build();
    },
    displayLists(): readonly DisplayList[] {
      return cached;
    },
  };
}

/** The part of HTMLImageElement the loader uses, so tests can pass a stub. */
interface LoadableSource {
  src: string;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  complete?: boolean;
  naturalWidth?: number;
}

function defaultCreateSource(): LoadableSource {
  // eslint-disable-next-line no-undef
  return new Image() as unknown as LoadableSource;
}

/**
 * Attach an image watermark to `pane`. `options` may be just the image URL. Detaching
 * disposes the uploaded image. `createSource` replaces `new Image()`, for tests.
 */
export function createImageWatermark(
  pane: PrimitiveTarget & PaneLike,
  options?: string | DeepPartial<ImageWatermarkOptions>,
  createSource: () => LoadableSource = defaultCreateSource,
): ImageWatermarkHandle {
  let opts: ImageWatermarkOptions = resolve(options);
  let rev = 0;

  let ctx: PrimitiveContext | null = null;
  let loaded: LoadedImage | null = null;
  let el: LoadableSource | null = null;
  let elUrl: string | null = null; // the url `el` is loading

  const source = createWatermarkSource(
    () => opts,
    () => (ctx?.pane as unknown as PaneLike | undefined) ?? pane,
    () => loaded,
    () => rev,
  );

  function disposeHandle(): void {
    loaded?.handle.dispose();
    loaded = null;
  }

  /** Start loading `opts.imageUrl`; a no-op if that url is already loading or loaded. */
  function startLoad(): void {
    const url = opts.imageUrl;
    if (url === elUrl) return;
    elUrl = url;
    disposeHandle();
    if (el !== null) {
      el.onload = null;
      el.onerror = null;
      el = null;
    }
    // Before attach there is no ctx.images to upload to; attached() calls this again.
    if (url === '' || ctx === null) return;
    const element = createSource();
    el = element;
    element.onload = (): void => {
      if (element !== el || ctx === null) return; // superseded or detached
      loaded = { handle: ctx.images.create(element) };
      rev++;
      ctx.requestUpdate('render');
    };
    element.onerror = (): void => {
      if (element !== el) return;
      el = null;
    };
    element.src = url;
    // A cached image may already be complete and never fire onload.
    if (element.complete === true && (element.naturalWidth ?? 0) > 0) element.onload?.();
  }

  const primitive: IPrimitive = {
    attached(c): void {
      ctx = c as unknown as PrimitiveContext;
      startLoad();
    },
    detached(): void {
      if (el !== null) {
        el.onload = null;
        el.onerror = null;
      }
      el = null;
      elUrl = null;
      disposeHandle();
      ctx = null;
    },
    sources(): readonly { target: 'pane'; source: SceneSource }[] {
      return [{ target: 'pane', source }];
    },
  };

  return createPrimitiveAdapter<ImageWatermarkOptions>({
    target: pane,
    primitive,
    options: opts,
    defaults: imageWatermarkDefaults,
    onChange(next): void {
      const urlChanged = next.imageUrl !== opts.imageUrl;
      opts = next;
      rev++;
      if (urlChanged) startLoad();
      ctx?.requestUpdate('render');
    },
    methods: {},
    onDetach(): void {
      // Also reap here, in case the host never calls detached() on an explicit detach.
      if (el !== null) {
        el.onload = null;
        el.onerror = null;
      }
      el = null;
      elUrl = null;
      disposeHandle();
    },
  });
}

/** Shallow resolve over the defaults; a bare string is shorthand for `{ imageUrl }`. */
function resolve(options?: string | DeepPartial<ImageWatermarkOptions>): ImageWatermarkOptions {
  if (options === undefined) return { ...imageWatermarkDefaults };
  const patch: DeepPartial<ImageWatermarkOptions> =
    typeof options === 'string' ? { imageUrl: options } : options;
  return {
    visible: patch.visible ?? imageWatermarkDefaults.visible,
    imageUrl: patch.imageUrl ?? imageWatermarkDefaults.imageUrl,
    padding: patch.padding ?? imageWatermarkDefaults.padding,
    maxWidth: patch.maxWidth ?? imageWatermarkDefaults.maxWidth,
    maxHeight: patch.maxHeight ?? imageWatermarkDefaults.maxHeight,
    alpha: patch.alpha ?? imageWatermarkDefaults.alpha,
  };
}
