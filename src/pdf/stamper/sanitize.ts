/**
 * Text layout helpers shared by measurement and drawing: pdf-lib measures
 * and draws multi-line text as literal `\n`-separated lines itself, but we
 * need per-line widths and the overall block height up front to compute a
 * stamp's bounding box before drawing anything.
 */

/** Multiplier applied to font size to get the line height, matching pdf-lib's own default. */
export const DEFAULT_LINE_HEIGHT_FACTOR = 1.2;

export interface TextBlockLayout {
  lines: string[];
  lineHeight: number;
  /** Total block height = lineHeight * lines.length. */
  height: number;
}

/** Split `text` into lines on `\n` and compute the block's line height/height. */
export function layoutTextBlock(text: string, size: number): TextBlockLayout {
  const lines = text.split('\n');
  const lineHeight = size * DEFAULT_LINE_HEIGHT_FACTOR;
  return { lines, lineHeight, height: lineHeight * lines.length };
}
