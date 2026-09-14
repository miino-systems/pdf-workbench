/**
 * `pdf/renderer` — PDF.js → `<canvas>` rendering, for the page preview and
 * the stamp-position overlay. Browser-only (uses `HTMLCanvasElement`/
 * `OffscreenCanvas`); see `pdf/reader` for parsing/inspection that also
 * works in Node.
 */
export {
  PdfRenderer,
  renderPageToCanvas,
  type RenderPageOptions,
  type RenderPageResult,
  type RenderPageToCanvasResult,
} from './renderer.js';
export { pdfToCanvas, canvasToPdf, type Point } from './coords.js';
