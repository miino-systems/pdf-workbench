import type { PageSize } from '@/core/types';

/** A 2D point (unit depends on context: PDF pt, or canvas CSS px). */
export interface Point {
  x: number;
  y: number;
}

/**
 * Convert a PDF user-space point (origin bottom-left, y up) to canvas
 * pixel space (origin top-left, y down), at the given render `scale`
 * (pt → canvas px). Used to place the stamp-position overlay on top of a
 * rendered `<canvas>`.
 */
export function pdfToCanvas(pt: Point, pageSize: PageSize, scale: number): Point {
  return {
    x: pt.x * scale,
    y: (pageSize.height - pt.y) * scale,
  };
}

/** Inverse of {@link pdfToCanvas}: canvas pixel space back to PDF user space. */
export function canvasToPdf(px: Point, pageSize: PageSize, scale: number): Point {
  return {
    x: px.x / scale,
    y: pageSize.height - px.y / scale,
  };
}
