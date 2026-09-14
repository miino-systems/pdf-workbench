import { describe, expect, it } from 'vitest';
import { PAPER_SIZES_PT } from '@/core/units';
import { destroyPdfDocument, getLinkAnnotations, getPageTextItems, inspectPdf, loadPdfDocument } from '@/pdf/reader';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4 = PAPER_SIZES_PT.A4;

async function twoPageFixture(): Promise<Uint8Array> {
  return buildFixturePdf([
    {
      size: [A4.width, A4.height],
      texts: [
        { text: 'Hello World top', x: 50, y: 830 },
        { text: 'Body text', x: 50, y: 400 },
      ],
      link: { rect: [50, 700, 200, 720], uri: 'https://example.org' },
    },
    {
      // A4 landscape
      size: [A4.height, A4.width],
      texts: [{ text: 'Landscape page', x: 50, y: 500 }],
    },
  ]);
}

describe('pdf/reader: inspectPdf', () => {
  it('reports page count, sizes, rotation and link counts', async () => {
    const bytes = await twoPageFixture();
    const info = await inspectPdf(bytes);

    expect(info.pageCount).toBe(2);
    expect(info.pages).toHaveLength(2);

    expect(info.pages[0].page).toBe(1);
    expect(info.pages[0].width).toBeCloseTo(A4.width, 1);
    expect(info.pages[0].height).toBeCloseTo(A4.height, 1);
    expect(info.pages[0].rotation).toBe(0);
    expect(info.pages[0].linkCount).toBe(1);

    expect(info.pages[1].width).toBeCloseTo(A4.height, 1);
    expect(info.pages[1].height).toBeCloseTo(A4.width, 1);
    expect(info.pages[1].linkCount).toBe(0);

    expect(info.linkCount).toBe(1);
  });
});

describe('pdf/reader: getLinkAnnotations', () => {
  it('returns the URL and rect of a URI link annotation', async () => {
    const bytes = await twoPageFixture();
    const doc = await loadPdfDocument(bytes);
    try {
      const links = await getLinkAnnotations(doc, 1);
      expect(links).toHaveLength(1);
      expect(links[0].url).toContain('https://example.org');
      expect(links[0].rect).toEqual({ x: 50, y: 700, width: 150, height: 20 });

      const page2Links = await getLinkAnnotations(doc, 2);
      expect(page2Links).toHaveLength(0);
    } finally {
      await destroyPdfDocument(doc);
    }
  });
});

describe('pdf/reader: getPageTextItems', () => {
  it('extracts text runs in PDF user-space coordinates', async () => {
    const bytes = await twoPageFixture();
    const doc = await loadPdfDocument(bytes);
    try {
      const items = await getPageTextItems(doc, 1);
      const top = items.find((i) => i.str === 'Hello World top');
      expect(top).toBeDefined();
      expect(top?.x).toBeCloseTo(50, 1);
      expect(top?.y).toBeCloseTo(830, 1);
      expect(top?.width).toBeGreaterThan(0);
      expect(top?.height).toBeGreaterThan(0);

      const body = items.find((i) => i.str === 'Body text');
      expect(body).toBeDefined();
      expect(body?.y).toBeCloseTo(400, 1);
    } finally {
      await destroyPdfDocument(doc);
    }
  });
});
