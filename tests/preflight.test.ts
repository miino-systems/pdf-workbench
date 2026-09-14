import { describe, expect, it } from 'vitest';
import type { PreflightConfig } from '@/core/types';
import { PAPER_SIZES_PT } from '@/core/units';
import { runPreflight, checkMarginsByRaster, checkStampCollision, reportFileName, type ImageDataLike } from '@/preflight';
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
    expect(result.message).toBe('✓ 空白領域なので配置可能');
  });

  it('checkStampCollision reports a collision when the rect overlaps existing content', () => {
    const image = makeImage(200, 200, { x0: 50, y0: 0, x1: 100, y1: 10 });
    // PDF-space rect near the top of the page (y close to pageSize.height), overlapping the block.
    const result = checkStampCollision(image, pageSize, { x: 60, y: 185, width: 20, height: 15 });
    expect(result.collides).toBe(true);
    expect(result.message).toBe('⚠ 既存コンテンツと重なります');
  });
});

describe('preflight/report: reportFileName', () => {
  it('builds <basename>.<YYYYMMDDTHHMMSS>.json from a workspace-relative path', () => {
    const date = new Date(2026, 8, 14, 10, 30, 12); // 2026-09-14 10:30:12 local
    expect(reportFileName('papers/paper001.pdf', date)).toBe('paper001.20260914T103012.json');
  });
});
