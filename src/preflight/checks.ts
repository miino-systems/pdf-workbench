import type { PDFDocumentProxy } from 'pdfjs-dist';
import type {
  PageSize,
  PreflightConfig,
  PreflightFinding,
  PreflightMargins,
  PreflightMarginOverride,
  PreflightPageResult,
  PreflightReport,
  PreflightSeverity,
  PreflightWarningCode,
} from '@/core/types';
import { PAPER_SIZES_PT, toPt } from '@/core/units';
import { destroyPdfDocument, loadPdfDocument } from '@/pdf/reader/document';
import { getPageTextItems } from '@/pdf/reader/text';
import { resolvePages } from '@/stamps/pages';
import { normalizeAngle, toVisiblePoint } from '@/pdf/stamper/rotation';

/** At most this many located findings are kept per page (the codes still count every hit). */
export const MAX_FINDINGS_PER_PAGE = 40;

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

/**
 * Resolve the effective margins for one page: `base` with any matching
 * `PreflightMarginOverride.margins` side applied on top (later entries in
 * `overrides` win when several match the same page).
 */
export function marginsForPage(
  base: PreflightMargins,
  overrides: PreflightMarginOverride[] | undefined,
  pageNumber: number,
  pageCount: number,
): PreflightMargins {
  if (!overrides || overrides.length === 0) return base;
  let effective = base;
  for (const override of overrides) {
    if (!resolvePages(override.pages, pageCount).includes(pageNumber)) continue;
    effective = { ...effective, ...override.margins };
  }
  return effective;
}

type Orientation = 'portrait' | 'landscape' | 'square';

function actualOrientation(size: PageSize): Orientation {
  if (size.width > size.height) return 'landscape';
  if (size.width < size.height) return 'portrait';
  return 'square';
}

/**
 * Which margin bands (top/bottom/left/right) do non-blank text items enter?
 * Items are in the page's visible frame. Returns the codes and one located
 * finding per offending item and band.
 */
function marginFindingsForItems(
  items: { str: string; x: number; y: number; width: number; height: number }[],
  pageSize: PageSize,
  margins: PreflightMargins,
): { codes: PreflightWarningCode[]; findings: PreflightFinding[] } {
  const topPt = toPt(margins.top, margins.unit);
  const bottomPt = toPt(margins.bottom, margins.unit);
  const leftPt = toPt(margins.left, margins.unit);
  const rightPt = toPt(margins.right, margins.unit);

  const codes = new Set<PreflightWarningCode>();
  const findings: PreflightFinding[] = [];
  for (const item of items) {
    if (item.str.trim() === '') continue; // ignore empty/whitespace-only runs
    const top = item.y + item.height;
    const bottom = item.y;
    const left = item.x;
    const right = item.x + item.width;

    const hits: PreflightWarningCode[] = [];
    if (top > pageSize.height - topPt) hits.push('TOP_MARGIN');
    if (bottom < bottomPt) hits.push('BOTTOM_MARGIN');
    if (left < leftPt) hits.push('LEFT_MARGIN');
    if (right > pageSize.width - rightPt) hits.push('RIGHT_MARGIN');
    for (const code of hits) {
      codes.add(code);
      findings.push({ code, source: 'text', rect: { x: left, y: bottom, width: item.width, height: item.height }, text: item.str });
    }
  }
  return { codes: [...codes], findings };
}

/** A text run's box moved from the page's content space into its visible (rotated) frame. */
function toVisibleRect(
  item: { str: string; x: number; y: number; width: number; height: number },
  angle: ReturnType<typeof normalizeAngle>,
  raw: PageSize,
): { str: string; x: number; y: number; width: number; height: number } {
  if (angle === 0) return item;
  const a = toVisiblePoint({ x: item.x, y: item.y }, angle, raw);
  const b = toVisiblePoint({ x: item.x + item.width, y: item.y + item.height }, angle, raw);
  return { str: item.str, x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
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
      const findings: PreflightFinding[] = errors.map((code) => ({ code, source: 'page' as const }));
      if (marginTextEnabled && config.margins) {
        const angle = normalizeAngle(page.rotate);
        const raw = page.getViewport({ scale: 1, rotation: 0 });
        const items = (await getPageTextItems(doc, pageNumber)).map((it) => toVisibleRect(it, angle, { width: raw.width, height: raw.height }));
        const margins = marginsForPage(config.margins, config.marginOverrides, pageNumber, pageCount);
        const found = marginFindingsForItems(items, size, margins);
        warnings = found.codes;
        findings.push(...found.findings);
      }

      pages.push({
        page: pageNumber,
        warnings,
        errors: errors.length > 0 ? errors : undefined,
        details: { width: size.width, height: size.height, rotation: page.rotate },
        findings: findings.length ? findings.slice(0, MAX_FINDINGS_PER_PAGE) : undefined,
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
