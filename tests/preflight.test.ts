import { describe, expect, it } from 'vitest';
import type { MarginTolerance, PreflightConfig } from '@/core/types';
import { PAPER_SIZES_PT } from '@/core/units';
import {
  checkMarginsByRaster,
  checkStampCollision,
  marginsForPage,
  isLegacyReportName,
  reportFileName,
  reportProblemCounts,
  runPreflight,
  serializeReport,
  type ImageDataLike,
} from '@/preflight';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4 = PAPER_SIZES_PT.A4;
const LETTER = PAPER_SIZES_PT.Letter;

function baseConfig(overrides: Partial<PreflightConfig> = {}): PreflightConfig {
  return {
    version: 1,
    id: 'default',
    ...overrides,
  };
}

describe('preflight: page size / orientation / count', () => {
  it('passes an A4 portrait document against an A4 portrait config', async () => {
    const bytes = await buildFixturePdf([{ size: [A4.width, A4.height] }]);
    const report = await runPreflight(
      bytes,
      baseConfig({ page: { size: 'A4', orientation: 'portrait' } }),
      { file: 'papers/a4.pdf', sha256: 'sha256:deadbeef' },
    );

    expect(report.result).toBe('ok');
    expect(report.pages[0].errors).toBeUndefined();
    expect(report.documentWarnings).toHaveLength(0);
  });

  it('flags a Letter document checked against an A4 config as PAGE_SIZE', async () => {
    const bytes = await buildFixturePdf([{ size: [LETTER.width, LETTER.height] }]);
    const report = await runPreflight(bytes, baseConfig({ page: { size: 'A4' } }), {
      file: 'papers/letter.pdf',
      sha256: 'sha256:deadbeef',
    });

    expect(report.result).toBe('error');
    expect(report.pages[0].errors).toContain('PAGE_SIZE');
  });

  it('flags a document with too many pages as PAGE_COUNT_MAX', async () => {
    const pages = Array.from({ length: 7 }, () => ({ size: [A4.width, A4.height] as [number, number] }));
    const bytes = await buildFixturePdf(pages);
    const report = await runPreflight(bytes, baseConfig({ pages: { max: 6 } }), {
      file: 'papers/many.pdf',
      sha256: 'sha256:deadbeef',
    });

    expect(report.pageCount).toBe(7);
    expect(report.result).toBe('error');
    expect(report.documentWarnings).toContain('PAGE_COUNT_MAX');
  });
});

describe('preflight: object-based margin check', () => {
  it('flags text near the top edge as TOP_MARGIN when it enters a 20mm top margin', async () => {
    const bytes = await buildFixturePdf([
      {
        size: [A4.width, A4.height],
        texts: [
          { text: 'Too close to the top', x: 50, y: 830 },
          { text: 'Safely inside the margins', x: 50, y: 400 },
        ],
      },
    ]);

    const report = await runPreflight(
      bytes,
      baseConfig({
        margins: { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm' },
        checks: { marginText: true },
      }),
      { file: 'papers/margins.pdf', sha256: 'sha256:deadbeef' },
    );

    expect(report.result).toBe('warning');
    expect(report.pages[0].warnings).toContain('TOP_MARGIN');
    expect(report.pages[0].warnings).not.toContain('BOTTOM_MARGIN');
  });
});

describe('preflight/raster', () => {
  const pageSize = { width: 200, height: 200 };

  /** All-white `width`x`height` image, RGBA, with an optional black rectangle painted in. */
  function makeImage(
    width: number,
    height: number,
    block?: { x0: number; y0: number; x1: number; y1: number },
  ): ImageDataLike {
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    if (block) {
      for (let y = block.y0; y < block.y1; y++) {
        for (let x = block.x0; x < block.x1; x++) {
          const i = (y * width + x) * 4;
          data[i] = 0;
          data[i + 1] = 0;
          data[i + 2] = 0;
          data[i + 3] = 255;
        }
      }
    }
    return { data, width, height };
  }

  it('checkMarginsByRaster flags a black block sitting in the top margin band', () => {
    // Black block occupies raster rows [0, 10) (top of the page) — inside a 20pt top margin.
    const image = makeImage(200, 200, { x0: 50, y0: 0, x1: 100, y1: 10 });
    const codes = checkMarginsByRaster(image, pageSize, { top: 20, bottom: 20, left: 20, right: 20 });
    expect(codes).toContain('TOP_MARGIN');
    expect(codes).not.toContain('BOTTOM_MARGIN');
    expect(codes).not.toContain('LEFT_MARGIN');
    expect(codes).not.toContain('RIGHT_MARGIN');
  });

  it('checkMarginsByRaster returns no codes for a blank page', () => {
    const image = makeImage(200, 200);
    const codes = checkMarginsByRaster(image, pageSize, { top: 20, bottom: 20, left: 20, right: 20 });
    expect(codes).toHaveLength(0);
  });

  it('checkStampCollision reports no collision over blank space', () => {
    const image = makeImage(200, 200, { x0: 50, y0: 0, x1: 100, y1: 10 });
    // PDF-space rect near the bottom-left corner, far from the black block near the top.
    const result = checkStampCollision(image, pageSize, { x: 10, y: 10, width: 20, height: 20 });
    expect(result.collides).toBe(false);
    expect(result.message).toBe('空白領域なので配置可能');
  });

  it('checkStampCollision reports a collision when the rect overlaps existing content', () => {
    const image = makeImage(200, 200, { x0: 50, y0: 0, x1: 100, y1: 10 });
    // PDF-space rect near the top of the page (y close to pageSize.height), overlapping the block.
    const result = checkStampCollision(image, pageSize, { x: 60, y: 185, width: 20, height: 15 });
    expect(result.collides).toBe(true);
    expect(result.message).toBe('既存コンテンツと重なります');
  });
});

describe('preflight: per-page margin overrides', () => {
  it('marginsForPage falls back to the base margins when nothing matches', () => {
    const base = { top: 20, bottom: 20, left: 18, right: 18, unit: 'mm' as const };
    expect(marginsForPage(base, undefined, 1, 3)).toEqual(base);
    expect(marginsForPage(base, [{ pages: { kind: 'last' }, margins: { top: 40 } }], 1, 3)).toEqual(base);
  });

  it('marginsForPage applies a matching override on top of the base margins', () => {
    const base = { top: 20, bottom: 20, left: 18, right: 18, unit: 'mm' as const };
    const overrides = [{ pages: { kind: 'first' as const }, margins: { top: 35 } }];
    expect(marginsForPage(base, overrides, 1, 3)).toEqual({ ...base, top: 35 });
    expect(marginsForPage(base, overrides, 2, 3)).toEqual(base); // untouched on other pages
  });

  it('later overrides win when several match the same page', () => {
    const base = { top: 20, bottom: 20, left: 18, right: 18, unit: 'mm' as const };
    const overrides = [
      { pages: { kind: 'first' as const }, margins: { top: 30 } },
      { pages: { kind: 'all' as const }, margins: { top: 35 } },
    ];
    expect(marginsForPage(base, overrides, 1, 3).top).toBe(35);
  });

  it('runPreflight honours a first-page-only top margin override', async () => {
    // y=755 (+ ~13pt glyph height) sits between the 20mm (~785pt) and 35mm
    // (~743pt) top-margin thresholds on an A4 page: inside the normal 20mm
    // margin, but inside the wider 35mm one used for the first page only.
    const bytes = await buildFixturePdf([
      { size: [A4.width, A4.height], texts: [{ text: 'Header', x: 50, y: 755 }] },
      { size: [A4.width, A4.height], texts: [{ text: 'Header', x: 50, y: 755 }] },
    ]);

    const report = await runPreflight(
      bytes,
      baseConfig({
        margins: { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm' },
        // First page gets a much larger top margin (title block); this text
        // sits well inside a 20mm margin but not inside a 35mm one.
        marginOverrides: [{ pages: { kind: 'first' }, margins: { top: 35 } }],
        checks: { marginText: true },
      }),
      { file: 'papers/override.pdf', sha256: 'sha256:deadbeef' },
    );

    expect(report.pages[0].warnings).toContain('TOP_MARGIN');
    expect(report.pages[1].warnings).not.toContain('TOP_MARGIN');
  });
});

describe('preflight/report: reportFileName', () => {
  it('builds one fixed <basename>.json per PDF from a workspace-relative path', () => {
    expect(reportFileName('papers/paper001.pdf')).toBe('paper001.json');
  });

  it("recognises only that PDF's reports in the old <basename>.<timestamp>.json format", () => {
    expect(isLegacyReportName('papers/paper.pdf', 'paper.20260914T103012.json')).toBe(true);
    expect(isLegacyReportName('papers/paper.pdf', 'paper.json')).toBe(false);
    expect(isLegacyReportName('papers/paper.pdf', 'paper.v2.json')).toBe(false);
    expect(isLegacyReportName('papers/paper.pdf', 'paper.v2.20260914T103012.json')).toBe(false);
    expect(isLegacyReportName('papers/a+b.pdf', 'a+b.20260914T103012.json')).toBe(true);
    expect(isLegacyReportName('papers/a+b.pdf', 'aab.20260914T103012.json')).toBe(false);
  });

  it('cuts long finding texts to 80 characters when saved, and counts problems for the log', () => {
    const report = {
      file: 'papers/p.pdf', sha256: 'sha256:0', configId: 'default', ranAt: '2026-09-14T01:30:12.000Z', result: 'error' as const,
      pageCount: 1, documentWarnings: ['PAGE_COUNT_MAX'],
      pages: [{ page: 1, warnings: ['TOP_MARGIN', 'TEXT_OVERLAP'], findings: [{ code: 'TOP_MARGIN', source: 'text' as const, text: 'x'.repeat(200) }, { code: 'TEXT_OVERLAP', source: 'text' as const, text: 'short' }] }],
    };
    const saved = JSON.parse(serializeReport(report));
    expect(saved.pages[0].findings[0].text).toBe(`${'x'.repeat(80)}…`);
    expect(saved.pages[0].findings[1].text).toBe('short');
    expect(report.pages[0].findings[0].text).toHaveLength(200); // the in-memory report is untouched
    expect(reportProblemCounts(report)).toEqual({ errors: 1, warnings: 2 });
  });
});

describe('preflight: margin tolerance and merged findings', () => {
  const RIGHT = 20; // mm
  const rightLinePt = A4.width - (RIGHT * 72) / 25.4;

  async function check(x: number, tolerance?: number) {
    const bytes = await buildFixturePdf([{ size: [A4.width, A4.height], texts: [{ text: 'Justified line', x, y: 500 }] }]);
    return runPreflight(
      bytes,
      baseConfig({ margins: { top: 20, bottom: 20, left: 20, right: RIGHT, unit: 'mm', tolerance }, checks: { marginText: true } }),
      { file: 'papers/t.pdf', sha256: 'sha256:x' },
    );
  }

  it('ignores text touching the margin line within the tolerance (default 2 pt)', async () => {
    // pdf.js measures the run itself: learn its width from a run that clearly
    // crosses the line, then place its right edge exactly 1 pt past the line.
    const probe = (await check(rightLinePt - 10, 0)).pages[0].findings?.[0];
    expect(probe?.code).toBe('RIGHT_MARGIN');
    const width = probe!.rect!.width;
    const x = rightLinePt - width + 1;
    expect((await check(x)).pages[0].warnings).toEqual([]);
    expect((await check(x, 0)).pages[0].warnings).toEqual(['RIGHT_MARGIN']);
    expect((await check(x + 3)).pages[0].warnings).toEqual(['RIGHT_MARGIN']);
  });

  it('merges consecutive lines into one box and caps findings per code', async () => {
    const { mergeFindings, MAX_FINDINGS_PER_CODE } = await import('@/preflight');
    const lines = Array.from({ length: 30 }, (_, i) => ({
      code: 'RIGHT_MARGIN' as const,
      source: 'text' as const,
      rect: { x: 300, y: 600 - i * 12, width: 240, height: 10 },
      text: `line ${i}`,
    }));
    const merged = mergeFindings([...lines, { code: 'LEFT_MARGIN', source: 'text', rect: { x: 10, y: 400, width: 50, height: 10 }, text: 'left' }]);
    expect(merged).toHaveLength(2);
    const right = merged.find((f) => f.code === 'RIGHT_MARGIN')!;
    expect(right.text).toBe('line 0 … (+29 lines)');
    expect(right.rect).toEqual({ x: 300, y: 600 - 29 * 12, width: 240, height: 29 * 12 + 10 });

    // Far-apart hits stay separate, but one code never crowds out another.
    const scattered = Array.from({ length: 40 }, (_, i) => ({
      code: 'RIGHT_MARGIN' as const,
      source: 'text' as const,
      rect: { x: 300, y: 800 - i * 60, width: 240, height: 10 },
    }));
    const capped = mergeFindings([...scattered, { code: 'LEFT_MARGIN', source: 'raster', rect: { x: 0, y: 0, width: 5, height: 5 } }]);
    expect(capped.filter((f) => f.code === 'RIGHT_MARGIN')).toHaveLength(MAX_FINDINGS_PER_CODE);
    expect(capped.some((f) => f.code === 'LEFT_MARGIN')).toBe(true);
  });
});

describe('preflight: raster margin ink with tolerance and ignored areas', () => {
  it('skips ink within the tolerance and inside ignored rects', async () => {
    const { findMarginInkByRaster } = await import('@/preflight');
    // 100×100 pt page at 1 px/pt, white, with a dark block reaching 2 pt past the bottom margin line (margin 10 pt).
    const w = 100;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 89; y < 92; y++) for (let x = 40; x < 43; x++) data.set([0, 0, 0, 255], (y * w + x) * 4);
    const image = { data, width: w, height: w };
    const page = { width: 100, height: 100 };
    const margins = { top: 10, bottom: 10, left: 10, right: 10 };
    // Rows 89..91 = pdf y 9..11: rows 90–91 lie up to 2 pt below the bottom line (y = 10).
    expect(findMarginInkByRaster(image, page, margins).map((f) => f.code)).toEqual(['BOTTOM_MARGIN']);
    expect(findMarginInkByRaster(image, page, margins, { tolerance: 2 })).toEqual([]);
    expect(findMarginInkByRaster(image, page, margins, { ignore: [{ x: 39, y: 7, width: 5, height: 5 }] })).toEqual([]);
  });
});

describe('preflight: per-side margin tolerance', () => {
  it('resolves a number, a per-side object and defaults', async () => {
    const { marginTolerancesPt } = await import('@/preflight');
    const m = { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm' as const };
    expect(marginTolerancesPt(m)).toEqual({ top: 2, bottom: 2, left: 2, right: 2 });
    expect(marginTolerancesPt({ ...m, tolerance: 1 })).toEqual({ top: 1, bottom: 1, left: 1, right: 1 });
    expect(marginTolerancesPt({ ...m, tolerance: { right: 0, top: 5 } })).toEqual({ top: 5, bottom: 2, left: 2, right: 0 });
    expect(marginTolerancesPt({ ...m, tolerance: { left: -1 } }).left).toBe(2);
  });

  it('applies each side its own tolerance in the text and raster checks', async () => {
    const lineX = A4.width - (20 * 72) / 25.4;
    const run = (tolerance: number | MarginTolerance, x: number) =>
      buildFixturePdf([{ size: [A4.width, A4.height], texts: [{ text: 'Line', x, y: 500 }] }]).then((bytes) =>
        runPreflight(bytes, baseConfig({ margins: { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm', tolerance }, checks: { marginText: true } }), {
          file: 'p.pdf',
          sha256: 'x',
        }),
      );
    const probe = (await run(0, lineX - 5)).pages[0].findings![0].rect!;
    const x = lineX - probe.width + 1; // right edge 1 pt past the line
    expect((await run({ right: 2 }, x)).pages[0].warnings).toEqual([]);
    expect((await run({ right: 0.5, left: 5 }, x)).pages[0].warnings).toEqual(['RIGHT_MARGIN']);

    const { findMarginInkByRaster } = await import('@/preflight');
    const w = 100;
    const data = new Uint8ClampedArray(w * w * 4).fill(255);
    for (let y = 50; y < 52; y++) for (let x2 = 91; x2 < 92; x2++) data.set([0, 0, 0, 255], (y * w + x2) * 4); // 1 pt into a 10 pt right margin
    const image = { data, width: w, height: w };
    const margins = { top: 10, bottom: 10, left: 10, right: 10 };
    expect(findMarginInkByRaster(image, { width: 100, height: 100 }, margins, { tolerance: { top: 0, bottom: 0, left: 0, right: 2 } })).toEqual([]);
    expect(findMarginInkByRaster(image, { width: 100, height: 100 }, margins, { tolerance: { top: 2, bottom: 2, left: 2, right: 0 } }).map((f) => f.code)).toEqual(['RIGHT_MARGIN']);
  });
});
