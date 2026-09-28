/**
 * Multi-line text with line spacing and alignment, and automatic layer
 * layout (a logo left of a text block) — checked on the generated PDF, and
 * against the measurement the UI overlay uses.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { StampDefinition, StampInstance } from '@/core/types';
import { applyStamps, arrangeLayerBoxes, measureLayers, StampMetrics } from '@/pdf/stamper';
import { destroyPdfDocument, getPageTextItems, loadPdfDocument } from '@/pdf/reader';

const A4: [number, number] = [595.28, 841.89];
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function timesWidth(text: string): Promise<number> {
  return (await PDFDocument.create()).embedStandardFont(StandardFonts.TimesRoman).widthOfTextAtSize(text, 10);
}

async function blankPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage(A4);
  return doc.save();
}

const LINE1 = '2026 International Symposium on Nonlinear Theory';
const LINE2 = 'NOLTA2026, Grenoble';

function header(align: 'left' | 'center' | 'right', extra: Partial<StampDefinition> = {}): StampDefinition {
  return {
    id: 'hdr',
    name: 'Header',
    layers: [
      {
        id: 't',
        type: 'text',
        text: `${LINE1}\n${LINE2}`,
        font: { kind: 'standard', name: 'Times-Roman' },
        size: 10,
        color: '#000000',
        align,
        lineHeight: 1.5,
      },
    ],
    ...extra,
  };
}

const inst: StampInstance = {
  id: 'i',
  stampId: 'hdr',
  enabled: true,
  pages: { kind: 'all' },
  position: { anchor: 'top-right', offsetX: 56.69, offsetY: 30 },
};

async function stamp(def: StampDefinition) {
  const result = await applyStamps({
    sourceBytes: await blankPdf(),
    definitions: [def],
    instances: [inst],
    resolveFont: async (ref) => ({ ref, hashMismatch: false }),
    resolveImage: async () => PNG_1x1,
  });
  const doc = await loadPdfDocument(result.bytes);
  const items = (await getPageTextItems(doc, 1)).filter((t) => t.str.trim());
  await destroyPdfDocument(doc);
  return items;
}

describe('multi-line text', () => {
  it('right-aligns every line to the right margin and spaces lines by lineHeight', async () => {
    const items = await stamp(header('right'));
    const [a, b] = [items.find((t) => t.str === LINE1)!, items.find((t) => t.str === LINE2)!];
    // pdf.js reports approximate widths without its standard font data, so
    // check where each line starts against pdf-lib's exact Times widths.
    const right = A4[0] - 56.69;
    expect(a.x).toBeCloseTo(right - (await timesWidth(LINE1)), 1);
    expect(b.x).toBeCloseTo(right - (await timesWidth(LINE2)), 1);
    expect(a.y - b.y).toBeCloseTo(15, 1); // 1.5 × 10 pt
  });

  it('centres lines within the block', async () => {
    const items = await stamp(header('center'));
    const [a, b] = [items.find((t) => t.str === LINE1)!, items.find((t) => t.str === LINE2)!];
    expect(a.x + (await timesWidth(LINE1)) / 2).toBeCloseTo(b.x + (await timesWidth(LINE2)) / 2, 1);
  });

  it('measures the block like it is drawn', async () => {
    const metrics = new StampMetrics({ resolveFont: () => Promise.reject(new Error('unused')), readImage: () => Promise.reject(new Error('unused')) });
    const def = header('right');
    await metrics.prepare([def]);
    const box = measureLayers(def.layers, { fonts: metrics.fonts }, def.layout);
    const font = (await PDFDocument.create()).embedStandardFont(StandardFonts.TimesRoman);
    expect(box.width).toBeCloseTo(font.widthOfTextAtSize(LINE1, 10), 6);
    expect(box.height).toBeCloseTo(2 * 15, 6);
  });
});

describe('layer layout', () => {
  it('arranges boxes in a row with a gap, vertically centred, keeping nudges', () => {
    const boxes = arrangeLayerBoxes(
      [
        { dx: 0, dy: 0, width: 20, height: 20 },
        { dx: 0, dy: 1, width: 100, height: 10 },
      ],
      { direction: 'row', gap: 5 },
    );
    expect(boxes[0]).toMatchObject({ dx: 0, dy: 0 });
    expect(boxes[1]).toMatchObject({ dx: 25, dy: 6 });
    const top = arrangeLayerBoxes([{ dx: 0, dy: 0, width: 20, height: 20 }, { dx: 0, dy: 0, width: 5, height: 10 }], { direction: 'row', align: 'start' });
    expect(top[1].dy).toBe(10);
    const col = arrangeLayerBoxes([{ dx: 0, dy: 0, width: 20, height: 20 }, { dx: 0, dy: 0, width: 10, height: 10 }], { direction: 'column', gap: 2, align: 'end' });
    expect(col[0]).toMatchObject({ dx: 0, dy: 12 });
    expect(col[1]).toMatchObject({ dx: 10, dy: 0 });
    expect(arrangeLayerBoxes([{ dx: 3, dy: 4, width: 1, height: 1 }])).toEqual([{ dx: 3, dy: 4, width: 1, height: 1 }]);
  });

  it('puts a logo left of the text in the generated PDF', async () => {
    const def = header('right', {
      layout: { direction: 'row', gap: 6 },
      layers: [{ id: 'logo', type: 'image', src: 'assets/logo.png', width: 24, height: 24 }, ...header('right').layers],
    });
    const items = await stamp(def);
    const a = items.find((t) => t.str === LINE1)!;
    // The text block still ends at the right margin; the logo sits 24 + 6 pt left of it.
    expect(a.x).toBeCloseTo(A4[0] - 56.69 - (await timesWidth(LINE1)), 1);
    const box = measureLayers(def.layers, { images: new Map([['assets/logo.png', { width: 1, height: 1 }]]) }, def.layout);
    expect(box.height).toBe(30);
  });
});

describe('image aspect ratio', () => {
  it('warns when width and height stretch the image, not when one side is given', async () => {
    const { imageAspectWarning } = await import('@/pdf/stamper');
    const cc = { id: 'l', type: 'image' as const, src: 'assets/cc.png' };
    expect(imageAspectWarning({ ...cc, width: 235, height: 20 }, { width: 88, height: 31 })).toMatch(/縦横比が元画像と違います.*高さ 82\.8 pt/);
    expect(imageAspectWarning({ ...cc, width: 88, height: 31 }, { width: 88, height: 31 })).toBeUndefined();
    expect(imageAspectWarning({ ...cc, width: 235 }, { width: 88, height: 31 })).toBeUndefined();
  });
});
