import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import { getPdfjs } from './pdfjs.js';
import { configurePdfjsWorker } from './worker.js';

export interface LoadPdfDocumentOptions {
  /** For password-protected PDFs. */
  password?: string;
}

/**
 * `PDFDocumentProxy` itself exposes no `destroy()` (only its
 * `PDFDocumentLoadingTask` — the thing `getDocument()` returns — does).
 * `loadPdfDocument`'s contract returns just the proxy, so the loading task
 * for each document loaded this way is kept here for `destroyPdfDocument`
 * to release the worker/resources behind it.
 */
const loadingTasks = new WeakMap<PDFDocumentProxy, PDFDocumentLoadingTask>();

/**
 * Load a PDF from raw bytes into a PDF.js `PDFDocumentProxy`.
 *
 * Notes:
 *  - PDF.js transfers (detaches) any `Uint8Array`/`ArrayBuffer` handed to
 *    `getDocument` to the worker thread, so a *copy* (`bytes.slice()`) is
 *    always passed — the caller's `bytes` stays valid and reusable after
 *    this call, which matters since e.g. `runPreflight` needs the same
 *    bytes for hashing and for the document.
 *  - `isEvalSupported` is intentionally not set: pdfjs-dist 6.x removed
 *    that option (it no longer appears in `DocumentInitParameters`), so
 *    passing it would be a TypeScript excess-property error for no effect.
 *  - `standardFontDataUrl`/`cMapUrl` are only set in the browser, pointing
 *    at `${BASE_URL}pdfjs/standard_fonts/` and `${BASE_URL}pdfjs/cmaps/` —
 *    copies of pdfjs-dist's own data bundled into `public/pdfjs/` at build
 *    time (see `public/pdfjs/README.txt`), fetched same-origin only, never
 *    from a CDN. Without them, pages using non-embedded (e.g. CJK system)
 *    fonts still render — PDF.js falls back to its built-in stand-in glyphs
 *    — just without correct standard/CJK glyph shapes; embedded fonts
 *    (the common case for generated papers) are unaffected either way.
 *    In Node these URLs are left unset (nothing to fetch from); the one
 *    resulting PDF.js warning is harmless for inspection/text-extraction,
 *    which is all Node (tests) ever does.
 */
export async function loadPdfDocument(
  bytes: Uint8Array,
  opts: LoadPdfDocumentOptions = {},
): Promise<PDFDocumentProxy> {
  await configurePdfjsWorker();
  const pdfjs = await getPdfjs();
  const isBrowser = typeof window !== 'undefined';

  const task = pdfjs.getDocument({
    data: bytes.slice(),
    disableAutoFetch: true,
    password: opts.password,
    ...(isBrowser
      ? {
          standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
          cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
          cMapPacked: true,
        }
      : {}),
  });

  const doc = await task.promise;
  loadingTasks.set(doc, task);
  return doc;
}

/**
 * Release the worker/resources behind a document loaded via
 * `loadPdfDocument`. No-op for a document not loaded that way (e.g.
 * already destroyed, or obtained directly from `getDocument()` elsewhere).
 */
export async function destroyPdfDocument(doc: PDFDocumentProxy): Promise<void> {
  const task = loadingTasks.get(doc);
  if (!task) return;
  loadingTasks.delete(doc);
  await task.destroy();
}
