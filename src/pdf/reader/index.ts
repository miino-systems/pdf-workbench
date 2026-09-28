/**
 * `pdf/reader` — PDF.js-backed inspection: load a document, read its page
 * geometry/link annotations/text content/images/fonts. No canvas rendering here (see
 * `pdf/renderer`) and no mutation (see `pdf/stamper`).
 */
export { configurePdfjsWorker } from './worker.js';
export { loadPdfDocument, destroyPdfDocument, type LoadPdfDocumentOptions } from './document.js';
export { inspectPdf, countPdfPages, getLinkAnnotations, type LinkAnnotation } from './inspect.js';
export { getPageTextItems, type PageTextItem } from './text.js';
export { getPageImages, decodeImageFile, type PageImage, type RgbaImage } from './images.js';
export { getPageFonts, readFontEmbedding, type FontEmbedding, type PageFont } from './fonts.js';
export { getPdfjs, type PdfjsModule } from './pdfjs.js';
