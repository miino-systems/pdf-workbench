import { destroyPdfDocument, loadPdfDocument } from '@/pdf/reader/document';
import { renderPageToCanvas } from '@/pdf/renderer/renderer';

export type ImageFormat = 'png' | 'jpeg';

/** DPI presets offered by the UI (Phase 3). */
export const DPI_PRESETS: readonly number[] = [150, 300, 600];

export interface ConvertPdfToImagesOptions {
  format: ImageFormat;
  dpi: number;
  /** 1-based page numbers to convert. Defaults to every page. */
  pages?: number[];
  /** JPEG quality, 0..1 (ignored for PNG). */
  quality?: number;
  /** File name stem, e.g. the source file without extension. Default `'paper'`. */
  baseName?: string;
}

export interface ConvertedImage {
  page: number;
  blob: Blob;
  fileName: string;
}

/**
 * File name for one converted page: `<base>_<page padded to `pad` digits>.<ext>`,
 * e.g. `imageFileName('paper', 1, 'png')` → `paper_001.png`.
 */
export function imageFileName(base: string, page: number, format: ImageFormat, pad = 3): string {
  const ext = format === 'jpeg' ? 'jpg' : 'png';
  return `${base}_${String(page).padStart(pad, '0')}.${ext}`;
}

function mimeType(format: ImageFormat): string {
  return format === 'jpeg' ? 'image/jpeg' : 'image/png';
}

/** `HTMLCanvasElement.toBlob`, promisified; `OffscreenCanvas.convertToBlob` is already promise-based. */
async function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality: number | undefined,
): Promise<Blob> {
  if ('convertToBlob' in canvas) {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) resolve(blob);
        else reject(new Error('canvas.toBlob() returned null'));
      },
      type,
      quality,
    );
  });
}

/**
 * Rasterise a PDF to PNG/JPEG images, one per selected page, at the given
 * DPI. Browser-only (needs `OffscreenCanvas` or a document `<canvas>` — see
 * `pdf/renderer`'s `renderPageToCanvas`); importing this module in Node is
 * safe (nothing browser-only runs at module load time), but iterating the
 * generator there throws once rendering is actually attempted.
 */
export async function* convertPdfToImages(
  bytes: Uint8Array,
  opts: ConvertPdfToImagesOptions,
): AsyncGenerator<ConvertedImage> {
  const doc = await loadPdfDocument(bytes);
  try {
    const pages =
      opts.pages && opts.pages.length > 0
        ? opts.pages
        : Array.from({ length: doc.numPages }, (_, i) => i + 1);
    const type = mimeType(opts.format);
    const base = opts.baseName ?? 'paper';

    for (const page of pages) {
      const { canvas } = await renderPageToCanvas(doc, page, { dpi: opts.dpi });
      const blob = await canvasToBlob(canvas, type, opts.quality);
      yield { page, blob, fileName: imageFileName(base, page, opts.format) };
    }
  } finally {
    await destroyPdfDocument(doc);
  }
}
