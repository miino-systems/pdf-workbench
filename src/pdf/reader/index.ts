/**
 * `pdf/reader` — PDF.js-backed inspection: load a document, read its page
 * geometry/link annotations/text content. No canvas rendering here (see
 * `pdf/renderer`) and no mutation (see `pdf/stamper`).
 */
export { configurePdfjsWorker } from './worker.js';
export { loadPdfDocument, destroyPdfDocument, type LoadPdfDocumentOptions } from './document.js';
export { inspectPdf, getLinkAnnotations, type LinkAnnotation } from './inspect.js';
export { getPageTextItems, type PageTextItem } from './text.js';
export { getPdfjs, type PdfjsModule } from './pdfjs.js';
