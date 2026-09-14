import {
  getDocument,
  RenderingCancelledException,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';
import type { PageSize } from '@/core/types';
import { configurePdfjsWorker } from '@/pdf/reader/worker';

/** Browser-only: canvas rendering, unlike `pdf/reader`, is not exercised in Node tests. */

export interface RenderPageOptions {
  /** Render scale, pt → canvas px (`dpi / 72`). Overrides `dpi` when both are given. */
  scale?: number;
  /** Convenience for `scale`: dots-per-inch (`scale = dpi / 72`). Default 96. */
  dpi?: number;
  /**
   * Physical-pixel density multiplier applied on top of `scale`/`dpi`, so
   * the canvas is crisp on high-DPI screens. Defaults to
   * `window.devicePixelRatio || 1`.
   */
  devicePixelRatio?: number;
}

export interface RenderPageResult {
  /** CSS-pixel width of the rendered page (`viewport.width` at `scale`, i.e. without `devicePixelRatio`). */
  width: number;
  /** CSS-pixel height of the rendered page. */
  height: number;
  /** The effective `scale` (pt → CSS px) used — the same value `pdf/renderer/coords.ts` expects. */
  scale: number;
}

function resolveScale(opts: RenderPageOptions): number {
  return opts.scale ?? (opts.dpi ?? 96) / 72;
}

function resolveDevicePixelRatio(opts: RenderPageOptions): number {
  if (opts.devicePixelRatio !== undefined) return opts.devicePixelRatio;
  return typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
}

/**
 * PDF.js → `<canvas>` renderer for one document, with page-size caching and
 * per-page render cancellation (starting a new render for a page cancels
 * any render already in flight for that same page).
 */
export class PdfRenderer {
  private readonly bytes: Uint8Array;
  private loadingTask: PDFDocumentLoadingTask | undefined;
  private doc: PDFDocumentProxy | undefined;
  private pageSizes: PageSize[] = [];
  private readonly renderTasks = new Map<number, RenderTask>();

  constructor(bytes: Uint8Array) {
    // PDF.js takes ownership of (detaches) the array passed to getDocument,
    // so keep our own copy for `load()` to hand off.
    this.bytes = bytes.slice();
  }

  async load(): Promise<void> {
    if (this.doc) return;
    await configurePdfjsWorker();
    this.loadingTask = getDocument({ data: this.bytes.slice(), disableAutoFetch: true });
    this.doc = await this.loadingTask.promise;

    const sizes: PageSize[] = [];
    for (let pageNumber = 1; pageNumber <= this.doc.numPages; pageNumber++) {
      const page = await this.doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      sizes.push({ width: viewport.width, height: viewport.height });
    }
    this.pageSizes = sizes;
  }

  get pageCount(): number {
    return this.pageSizes.length;
  }

  /** Page size in pt, with the page's own rotation already applied. Requires `load()` to have resolved. */
  getPageSize(pageNumber: number): PageSize {
    const size = this.pageSizes[pageNumber - 1];
    if (!size) {
      throw new Error(`PdfRenderer.getPageSize: page ${pageNumber} out of range (call load() first)`);
    }
    return size;
  }

  private async getPage(pageNumber: number): Promise<PDFPageProxy> {
    if (!this.doc) {
      throw new Error('PdfRenderer: load() must resolve before rendering');
    }
    return this.doc.getPage(pageNumber);
  }

  /**
   * Render one page into `canvas`. If a render for the same page number is
   * already in flight, it is cancelled first (its promise rejects with
   * `RenderingCancelledException`, which is swallowed here).
   *
   * The canvas is sized to physical pixels (`viewport × devicePixelRatio`)
   * for a crisp result, while `canvas.style.width/height` are set to the
   * CSS-pixel size so it lays out at the intended on-screen size; the
   * returned `{ width, height, scale }` describe that CSS-pixel size, which
   * is what `pdf/renderer/coords.ts` expects for overlay math.
   */
  async renderPage(
    pageNumber: number,
    canvas: HTMLCanvasElement,
    opts: RenderPageOptions = {},
  ): Promise<RenderPageResult> {
    const page = await this.getPage(pageNumber);
    const scale = resolveScale(opts);
    const dpr = resolveDevicePixelRatio(opts);

    const cssViewport = page.getViewport({ scale });
    const physicalViewport = page.getViewport({ scale: scale * dpr });

    canvas.width = Math.ceil(physicalViewport.width);
    canvas.height = Math.ceil(physicalViewport.height);
    canvas.style.width = `${cssViewport.width}px`;
    canvas.style.height = `${cssViewport.height}px`;

    const previous = this.renderTasks.get(pageNumber);
    if (previous) {
      previous.cancel();
    }

    const ctx = canvas.getContext('2d');
    if (!ctx) {
      throw new Error('PdfRenderer.renderPage: 2D canvas context unavailable');
    }

    const task = page.render({ canvasContext: ctx, canvas, viewport: physicalViewport });
    this.renderTasks.set(pageNumber, task);

    try {
      await task.promise;
    } catch (err) {
      if (!(err instanceof RenderingCancelledException)) {
        throw err;
      }
      // Superseded by a newer render of the same page — not an error.
    } finally {
      if (this.renderTasks.get(pageNumber) === task) {
        this.renderTasks.delete(pageNumber);
      }
    }

    return { width: cssViewport.width, height: cssViewport.height, scale };
  }

  async destroy(): Promise<void> {
    for (const task of this.renderTasks.values()) {
      task.cancel();
    }
    this.renderTasks.clear();
    await this.loadingTask?.destroy();
    this.loadingTask = undefined;
    this.doc = undefined;
    this.pageSizes = [];
  }
}

/**
 * Create a canvas without needing a `PdfRenderer` instance — used by
 * `pdf/converter` to rasterise pages in the background. Prefers
 * `OffscreenCanvas` when available (no DOM canvas element needed), falling
 * back to a real `<canvas>` element.
 */
function createCanvas(width: number, height: number): HTMLCanvasElement | OffscreenCanvas {
  if (typeof OffscreenCanvas !== 'undefined') {
    return new OffscreenCanvas(width, height);
  }
  if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  }
  throw new Error('renderPageToCanvas: no canvas implementation available in this environment');
}

export interface RenderPageToCanvasResult {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  width: number;
  height: number;
  scale: number;
}

/**
 * Standalone render helper (no `PdfRenderer` bookkeeping/cancellation) for
 * one-shot rasterisation of a single page — what `pdf/converter` uses.
 */
export async function renderPageToCanvas(
  doc: PDFDocumentProxy,
  pageNumber: number,
  opts: RenderPageOptions = {},
): Promise<RenderPageToCanvasResult> {
  const page = await doc.getPage(pageNumber);
  const scale = resolveScale(opts);
  const viewport = page.getViewport({ scale });

  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const canvas = createCanvas(width, height);
  // pdf.js's RenderParameters types `canvas` as `HTMLCanvasElement | null`,
  // but at runtime it only needs a 2D-context-capable canvas — OffscreenCanvas
  // works identically. Cast to satisfy the (slightly too narrow) type.
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const task = page.render({
    canvasContext: ctx,
    canvas: canvas as unknown as HTMLCanvasElement,
    viewport,
  });
  await task.promise;

  return { canvas, width, height, scale };
}
