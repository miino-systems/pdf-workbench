import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';

/** A text run's bounding box in PDF user space (origin bottom-left), plus its string. */
export interface PageTextItem {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

// `TextItem`/`TextMarkedContent` aren't among pdfjs-dist's public named
// exports (only referenced from `getTextContent`'s return type), so derive
// the item union structurally from `PDFPageProxy.getTextContent` instead of
// trying to import them directly.
type TextContentItem = Awaited<ReturnType<PDFPageProxy['getTextContent']>>['items'][number];
type RawTextItem = Extract<TextContentItem, { str: string }>;

function isTextItem(item: TextContentItem): item is RawTextItem {
  return 'str' in item;
}

/**
 * Text runs on a page, in PDF user-space coordinates — used by the
 * object-based margin preflight check.
 *
 * PDF.js's `TextItem.transform` is `[a, b, c, d, e, f]`; for the (common)
 * case of unrotated/unskewed text this is a plain scale+translate, so:
 *  - `x = e`, `y = f` is the bottom-left of the run's bounding box.
 *  - `width` comes straight from `item.width`.
 *  - `height` prefers `item.height` (PDF.js already computes it from the
 *    font metrics); `sqrt(b² + d²)` is used as a fallback for the rare case
 *    `item.height` is missing or zero (it is the magnitude of the
 *    transform's vertical basis vector).
 */
export async function getPageTextItems(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<PageTextItem[]> {
  const page = await doc.getPage(pageNumber);
  const content = await page.getTextContent();

  const items: PageTextItem[] = [];
  for (const item of content.items) {
    if (!isTextItem(item)) continue;
    const [, b, , d, e, f] = item.transform;
    const height = item.height > 0 ? item.height : Math.hypot(b, d);
    items.push({
      str: item.str,
      x: e,
      y: f,
      width: item.width,
      height,
    });
  }
  return items;
}
