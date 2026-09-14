/**
 * Stamp placement geometry: turning a `StampAnchor` + offsets into a
 * concrete rectangle in PDF user space (origin bottom-left).
 */
import type { PageSize, Rect, StampDefinition, StampInstance, StampPosition } from '@/core/types';

/** Default position used when neither the instance nor the definition set one. */
export const DEFAULT_STAMP_POSITION: StampPosition = {
  anchor: 'bottom-right',
  offsetX: 36,
  offsetY: 36,
};

/**
 * Compute the bottom-left corner of a stamp's bounding box in PDF user
 * space (origin bottom-left, y increasing upward) for a given anchor.
 *
 * Offsets are always applied *inward* from the anchor edge:
 *  - left anchors: offsetX pushes right; right anchors: offsetX pushes left.
 *  - center anchors (x): offsetX pushes right.
 *  - top anchors: offsetY pushes down; bottom anchors: offsetY pushes up.
 *  - middle anchors (y): offsetY pushes up.
 */
export function resolveStampOrigin(
  position: StampPosition,
  page: PageSize,
  box: { width: number; height: number },
): { x: number; y: number } {
  const { anchor, offsetX, offsetY } = position;
  const [vAnchor, hAnchor] = splitAnchor(anchor);

  let x: number;
  switch (hAnchor) {
    case 'left':
      x = offsetX;
      break;
    case 'right':
      x = page.width - offsetX - box.width;
      break;
    case 'center':
    default:
      x = (page.width - box.width) / 2 + offsetX;
      break;
  }

  let y: number;
  switch (vAnchor) {
    case 'top':
      y = page.height - offsetY - box.height;
      break;
    case 'bottom':
      y = offsetY;
      break;
    case 'middle':
    default:
      y = (page.height - box.height) / 2 + offsetY;
      break;
  }

  return { x, y };
}

type VerticalAnchor = 'top' | 'middle' | 'bottom';
type HorizontalAnchor = 'left' | 'center' | 'right';

function splitAnchor(anchor: StampPosition['anchor']): [VerticalAnchor, HorizontalAnchor] {
  const [v, h] = anchor.split('-') as [VerticalAnchor, HorizontalAnchor];
  return [v, h];
}

/**
 * Resolve the position to use for a stamp instance: an explicit
 * `instance.position` wins, then the definition's `defaultPosition`, then
 * the global {@link DEFAULT_STAMP_POSITION}.
 */
export function effectivePosition(def: StampDefinition, inst: StampInstance): StampPosition {
  return inst.position ?? def.defaultPosition ?? DEFAULT_STAMP_POSITION;
}

/** Full rectangle (bottom-left origin + size) for a stamp's bounding box. */
export function stampRect(
  position: StampPosition,
  page: PageSize,
  box: { width: number; height: number },
): Rect {
  const { x, y } = resolveStampOrigin(position, page, box);
  return { x, y, width: box.width, height: box.height };
}
