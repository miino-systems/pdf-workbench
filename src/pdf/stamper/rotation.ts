/**
 * Pure geometry helpers for mapping between a PDF page's *visible*
 * (as-displayed, `/Rotate`-applied) coordinate frame — the frame stamp
 * positions/anchors are expressed in — and its *content* coordinate frame
 * (the page's own, unrotated user space that pdf-lib's `drawText`/
 * `drawImage` actually place things in).
 *
 * Kept separate from `applyStamps.ts` (and exported) so the rotation math
 * can be unit-tested directly for all four `/Rotate` angles, in particular
 * that `toContentPoint` and `toVisiblePoint` are exact inverses of one
 * another — verified against pdf.js's own `PageViewport` transform.
 */
import type { PageSize } from '@/core/types';

export type PageAngle = 0 | 90 | 180 | 270;

/** Normalise any rotation angle (incl. negative) to one of 0/90/180/270. */
export function normalizeAngle(angle: number): PageAngle {
  const n = ((Math.round(angle / 90) * 90) % 360) + 360;
  const m = n % 360;
  return (m === 90 || m === 180 || m === 270 ? m : 0) as PageAngle;
}

/** The page size as it appears to a viewer once `/Rotate` is applied. */
export function visiblePageSize(raw: PageSize, angle: PageAngle): PageSize {
  return angle === 90 || angle === 270 ? { width: raw.height, height: raw.width } : raw;
}

/**
 * Map a point given in the page's *visible* (as-displayed) coordinate frame
 * into the page's own content coordinate space (unaffected by `/Rotate`),
 * so pdf-lib's `drawText`/`drawImage` (which operate in content space) draw
 * it where it visibly belongs. Exact for every angle: this is a pure
 * coordinate rotation, invertible by {@link toVisiblePoint}.
 */
export function toContentPoint(
  visible: { x: number; y: number },
  angle: PageAngle,
  raw: PageSize,
): { x: number; y: number } {
  switch (angle) {
    case 0:
      return visible;
    case 90:
      return { x: raw.width - visible.y, y: visible.x };
    case 180:
      return { x: raw.width - visible.x, y: raw.height - visible.y };
    case 270:
      return { x: visible.y, y: raw.height - visible.x };
  }
}

/** Inverse of {@link toContentPoint}: content space back to the visible frame. */
export function toVisiblePoint(
  content: { x: number; y: number },
  angle: PageAngle,
  raw: PageSize,
): { x: number; y: number } {
  switch (angle) {
    case 0:
      return content;
    case 90:
      return { x: content.y, y: raw.width - content.x };
    case 180:
      return { x: raw.width - content.x, y: raw.height - content.y };
    case 270:
      return { x: raw.height - content.y, y: content.x };
  }
}
