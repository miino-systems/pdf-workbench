import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
  PageSize,
  PreflightConfig,
  PreflightMargins,
  PreflightPageResult,
  PreflightReport,
  PreflightSeverity,
  PreflightWarningCode,
} from '@/core/types';
import { PAPER_SIZES_PT, toPt } from '@/core/units';
import { destroyPdfDocument, loadPdfDocument } from '@/pdf/reader/document';
import { getPageTextItems } from '@/pdf/reader/text';

export interface PreflightContext {
  /** Workspace-relative source path, stored verbatim into the report. */
  file: string;
  /** `sha256:<hex>` of `bytes`, stored verbatim into the report. */
  sha256: string;
  /** Clock used for `ranAt`; defaults to `new Date()`. Overridable for deterministic tests. */
  now?: Date;
  /** Document loader; defaults to `pdf/reader`'s `loadPdfDocument`. Overridable for tests/mocking. */
  loadDocument?: (bytes: Uint8Array) => Promise<PDFDocumentProxy>;
}

const DEFAULT_TOLERANCE_PT = 2;

/**
 * Does `size` match `target` (both in pt), within `tolerance`, ignoring
 * which one is portrait/landscape (so an A4 target matches both A4
 * portrait and A4 landscape pages)?
 */
function matchesPaperSize(
  size: PageSize,
  target: { width: number; height: number },
  tolerance: number,
): boolean {
  const straight =
    Math.abs(size.width - target.width) <= tolerance && Math.abs(size.height - target.height) <= tolerance;
  const rotated =
    Math.abs(size.width - target.height) <= tolerance && Math.abs(size.height - target.width) <= tolerance;
  return straight || rotated;
}

type Orientation = 'portrait' | 'landscape' | 'square';

function actualOrientation(size: PageSize): Orientation {
  if (size.width > size.height) return 'landscape';
  if (size.width < size.height) return 'portrait';
  return 'square';
}

/** Which margin bands (top/bottom/left/right) does any non-blank text item enter? */
function marginCodesForItems(
  items: { str: string; x: number; y: number; width: number; height: number }[],
  pageSize: PageSize,
  margins: PreflightMargins,
): PreflightWarningCode[] {
  const topPt = toPt(margins.top, margins.unit);
  const bottomPt = toPt(margins.bottom, margins.unit);
  const leftPt = toPt(margins.left, margins.unit);
  const rightPt = toPt(margins.right, margins.unit);

  const codes = new Set<PreflightWarningCode>();
  for (const item of items) {
    if (item.str.trim() === '') continue; // ignore empty/whitespace-only runs
    const top = item.y + item.height;
    const bottom = item.y;
    const left = item.x;
    const right = item.x + item.width;

    if (top > pageSize.height - topPt) codes.add('TOP_MARGIN');
    if (bottom < bottomPt) codes.add('BOTTOM_MARGIN');
    if (left < leftPt) codes.add('LEFT_MARGIN');
    if (right > pageSize.width - rightPt) codes.add('RIGHT_MARGIN');
  }
  return [...codes];
}

/**
 * Run the basic (Phase 2) preflight checks against a PDF: page size,
 * orientation and page count (vs `config.page`/`config.pages`), plus the
 * object-based margin check (`getPageTextItems`) when
 * `config.checks?.marginText` is true.
 *
 * Page size/orientation problems are per-page (`pages[i].errors`, since
 * pages can differ in size within one document) and make the overall
 * `result` `'error'`. Page count is document-level (`documentWarnings`,
 * the only array `PreflightReport` has at that level) but is still an
 * `'error'` condition. Margin text hits are per-page warnings
 * (`pages[i].warnings`).
 */
export async function runPreflight(
  bytes: Uint8Array,
  config: PreflightConfig,
  ctx: PreflightContext,
): Promise<PreflightReport> {
  const loadDocument = ctx.loadDocument ?? loadPdfDocument;
  const doc = await loadDocument(bytes);

  try {
    const pageCount = doc.numPages;
    const documentWarnings: PreflightWarningCode[] = [];

    if (config.pages?.min !== undefined && pageCount < config.pages.min) {
      documentWarnings.push('PAGE_COUNT_MIN');
    }
    if (config.pages?.max !== undefined && pageCount > config.pages.max) {
      documentWarnings.push('PAGE_COUNT_MAX');
    }

    const target = config.page?.size ? PAPER_SIZES_PT[config.page.size] : undefined;
    const tolerance = config.page?.tolerance ?? DEFAULT_TOLERANCE_PT;
    const marginTextEnabled = config.checks?.marginText === true && config.margins !== undefined;

    const pages: PreflightPageResult[] = [];
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      const page = await doc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      const size: PageSize = { width: viewport.width, height: viewport.height };

      const errors: PreflightWarningCode[] = [];
      if (target && !matchesPaperSize(size, target, tolerance)) {
        errors.push('PAGE_SIZE');
      }
      if (config.page?.orientation) {
        const actual = actualOrientation(size);
        if (actual !== 'square' && actual !== config.page.orientation) {
          errors.push('PAGE_ORIENTATION');
        }
      }

      let warnings: PreflightWarningCode[] = [];
      if (marginTextEnabled && config.margins) {
        const items = await getPageTextItems(doc, pageNumber);
        warnings = marginCodesForItems(items, size, config.margins);
      }

      pages.push({
        page: pageNumber,
        warnings,
        errors: errors.length > 0 ? errors : undefined,
        details: { width: size.width, height: size.height, rotation: page.rotate },
      });
    }

    const hasDocumentError = documentWarnings.some((c) => c === 'PAGE_COUNT_MIN' || c === 'PAGE_COUNT_MAX');
    const hasPageError = pages.some((p) => (p.errors?.length ?? 0) > 0);
    const hasPageWarning = pages.some((p) => p.warnings.length > 0);
    const result: PreflightSeverity =
      hasDocumentError || hasPageError ? 'error' : hasPageWarning ? 'warning' : 'ok';

    return {
      file: ctx.file,
      sha256: ctx.sha256,
      configId: config.id,
      ranAt: (ctx.now ?? new Date()).toISOString(),
      result,
      pageCount,
      documentWarnings,
      pages,
    };
  } finally {
    await destroyPdfDocument(doc);
  }
}
