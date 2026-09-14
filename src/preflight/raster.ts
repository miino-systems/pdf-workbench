import type { PageSize, Rect, PreflightWarningCode } from '@/core/types';

/**
 * Structural stand-in for `ImageData` so these pure functions can be unit
 * tested in Node with a plain object (`{ data, width, height }`) — no DOM
 * required — while still accepting a real `ImageData` from a `<canvas>`.
 */
export interface ImageDataLike {
  data: ArrayLike<number>;
  width: number;
  height: number;
}

/** Margins in pt (already resolved from `PreflightMargins`, which also carries a unit). */
export interface MarginsPt {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface RasterCheckOptions {
  /** Perceptual luminance (0..255) below which a pixel counts as "ink". Default 250. */
  threshold?: number;
  /** Minimum ink pixel count within a band/region to flag it. Default 1. */
  minPixels?: number;
}

const DEFAULT_THRESHOLD = 250;
const DEFAULT_MIN_PIXELS = 1;

/** Rec. 601-ish perceptual luminance of one RGB(A) pixel; alpha is ignored (transparent counts as background/white). */
function luminanceAt(data: ArrayLike<number>, pixelIndex: number): number {
  const i = pixelIndex * 4;
  const r = data[i] ?? 255;
  const g = data[i + 1] ?? 255;
  const b = data[i + 2] ?? 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Count "ink" (non-white) pixels within `[x0, x1) x [y0, y1)` (pixel coords, clamped to the image). */
function countInkPixels(
  image: ImageDataLike,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  threshold: number,
): { ink: number; total: number } {
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  const right = Math.min(image.width, Math.ceil(x1));
  const bottom = Math.min(image.height, Math.ceil(y1));

  let ink = 0;
  let total = 0;
  for (let y = top; y < bottom; y++) {
    const rowStart = y * image.width;
    for (let x = left; x < right; x++) {
      total++;
      if (luminanceAt(image.data, rowStart + x) < threshold) ink++;
    }
  }
  return { ink, total };
}

/**
 * Raster-based margin check: flags a margin band (top/bottom/left/right) of
 * a rendered page as violated when it contains non-white ("ink") pixels.
 * `margins` are in pt; `imageData` is assumed to cover the full page at a
 * uniform scale (`imageData.width / pageSize.width` px/pt horizontally,
 * `imageData.height / pageSize.height` px/pt vertically), with row 0 = top
 * of the page (canvas convention) matching the PDF page's top edge.
 */
export function checkMarginsByRaster(
  imageData: ImageDataLike,
  pageSize: PageSize,
  margins: MarginsPt,
  opts: RasterCheckOptions = {},
): PreflightWarningCode[] {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const minPixels = opts.minPixels ?? DEFAULT_MIN_PIXELS;
  const pxPerPtX = imageData.width / pageSize.width;
  const pxPerPtY = imageData.height / pageSize.height;

  const topPx = margins.top * pxPerPtY;
  const bottomPx = margins.bottom * pxPerPtY;
  const leftPx = margins.left * pxPerPtX;
  const rightPx = margins.right * pxPerPtX;

  const codes: PreflightWarningCode[] = [];

  if (countInkPixels(imageData, 0, 0, imageData.width, topPx, threshold).ink >= minPixels) {
    codes.push('TOP_MARGIN');
  }
  if (
    countInkPixels(imageData, 0, imageData.height - bottomPx, imageData.width, imageData.height, threshold).ink >=
    minPixels
  ) {
    codes.push('BOTTOM_MARGIN');
  }
  if (countInkPixels(imageData, 0, 0, leftPx, imageData.height, threshold).ink >= minPixels) {
    codes.push('LEFT_MARGIN');
  }
  if (
    countInkPixels(imageData, imageData.width - rightPx, 0, imageData.width, imageData.height, threshold).ink >=
    minPixels
  ) {
    codes.push('RIGHT_MARGIN');
  }

  return codes;
}

export interface StampCollisionOptions extends RasterCheckOptions {
  /** Fraction (0..1) of non-white pixels within `rect` above which it counts as a collision. Default 0.01 (1%). */
  collisionRatio?: number;
}

export interface StampCollisionResult {
  collides: boolean;
  /** Fraction (0..1) of non-white pixels within `rect`. */
  nonWhiteRatio: number;
  message: string;
}

const DEFAULT_COLLISION_RATIO = 0.01;

/**
 * Raster-based collision check: does `rect` (PDF user space, origin
 * bottom-left — the stamp's bounding box, e.g. from
 * `pdf/stamper`'s `measureStamp`) land on existing (non-white) page
 * content?
 */
export function checkStampCollision(
  imageData: ImageDataLike,
  pageSize: PageSize,
  rect: Rect,
  opts: StampCollisionOptions = {},
): StampCollisionResult {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const collisionRatio = opts.collisionRatio ?? DEFAULT_COLLISION_RATIO;
  const pxPerPtX = imageData.width / pageSize.width;
  const pxPerPtY = imageData.height / pageSize.height;

  // PDF space is bottom-left origin, y up; raster space is top-left origin, y down.
  const x0 = rect.x * pxPerPtX;
  const x1 = (rect.x + rect.width) * pxPerPtX;
  const y0 = (pageSize.height - (rect.y + rect.height)) * pxPerPtY;
  const y1 = (pageSize.height - rect.y) * pxPerPtY;

  const { ink, total } = countInkPixels(imageData, x0, y0, x1, y1, threshold);
  const nonWhiteRatio = total > 0 ? ink / total : 0;
  const collides = nonWhiteRatio > collisionRatio;

  return {
    collides,
    nonWhiteRatio,
    message: collides ? '⚠ 既存コンテンツと重なります' : '✓ 空白領域なので配置可能',
  };
}
