import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { PdfInfo, PdfPageInfo, Rect } from '@/core/types';
import { destroyPdfDocument, loadPdfDocument } from './document.js';

/** One link annotation, in PDF user-space coordinates. */
export interface LinkAnnotation {
  rect: Rect;
  /** Absolute URL for `/Subtype /Link /A << /S /URI >>` annotations. */
  url?: string;
  /** Raw `/Dest` (name, string or explicit destination array) for internal links. */
  dest?: unknown;
}

/** PDF.js's raw (loosely typed) annotation object, narrowed to the fields we read. */
interface RawAnnotation {
  subtype?: string;
  rect?: [number, number, number, number];
  url?: string;
  unsafeUrl?: string;
  dest?: unknown;
}

/**
 * Link annotations (`/Subtype /Link`) on one page, translated from PDF.js's
 * `[x1, y1, x2, y2]` rect into the app's `Rect` (`{x, y, width, height}`,
 * origin bottom-left).
 */
export async function getLinkAnnotations(
  doc: PDFDocumentProxy,
  pageNumber: number,
): Promise<LinkAnnotation[]> {
  const page = await doc.getPage(pageNumber);
  const annotations = (await page.getAnnotations({ intent: 'any' })) as RawAnnotation[];
  return annotations
    .filter((a): a is RawAnnotation & { rect: [number, number, number, number] } => a.subtype === 'Link' && Array.isArray(a.rect))
    .map((a) => {
      const [x1, y1, x2, y2] = a.rect;
      return {
        rect: {
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
        },
        url: a.url ?? a.unsafeUrl,
        dest: a.dest,
      };
    });
}

/**
 * Inspect a PDF: page sizes (pt, rotation already applied — see
 * `page.getViewport({ scale: 1 })`), rotation, and link annotation counts.
 */
export async function inspectPdf(bytes: Uint8Array): Promise<PdfInfo> {
  const doc = await loadPdfDocument(bytes);
  try {
    const pages: PdfPageInfo[] = [];
    let linkCount = 0;
    for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const links = await getLinkAnnotations(doc, pageNumber);
      linkCount += links.length;
      pages.push({
        page: pageNumber,
        width: viewport.width,
        height: viewport.height,
        rotation: page.rotate,
        linkCount: links.length,
      });
    }

    const { info } = await doc.getMetadata();
    const title = (info as { Title?: string } | undefined)?.Title || undefined;

    return {
      pageCount: doc.numPages,
      pages,
      title,
      linkCount,
    };
  } finally {
    await destroyPdfDocument(doc);
  }
}
