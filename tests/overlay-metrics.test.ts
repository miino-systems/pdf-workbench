/**
 * The preview overlay must measure stamps exactly like `applyStamps` draws
 * them: real font widths (not the 0.55em/char estimate) and real image sizes.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import type { StampDefinition } from '@/core/types';
import { StampMetrics, estimateStampBox, imageNaturalSize, measureLayers } from '@/pdf/stamper';

const IPAG = new Uint8Array(readFileSync(path.resolve(__dirname, 'fixtures/ipag-subset.ttf')));
const JPEG = new Uint8Array(readFileSync(path.resolve(__dirname, 'fixtures/tiny.jpg')));
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

const header: StampDefinition = {
  id: 'h',
  name: 'Header',
  layers: [
    {
      id: 't',
      type: 'text',
      text: '2026 International Symposium on Nonlinear Theory and Its Applications',
      font: { kind: 'standard', name: 'Times-Roman' },
      size: 10,
      color: '#000000',
    },
  ],
};

describe('StampMetrics', () => {
  it('measures text with the real font width instead of the estimate', async () => {
    const m = new StampMetrics({ resolveFont: () => Promise.reject(new Error('unused')), readImage: () => Promise.reject(new Error('unused')) });
    expect(await m.prepare([header])).toBe(true);
    expect(await m.prepare([header])).toBe(false); // cached

    const doc = await PDFDocument.create();
    const font = doc.embedStandardFont(StandardFonts.TimesRoman);
    const layer = header.layers[0] as { text: string };
    const box = measureLayers(header.layers, { fonts: m.fonts, images: m.images });
    expect(box.width).toBeCloseTo(font.widthOfTextAtSize(layer.text, 10), 6);
    expect(box.height).toBeCloseTo(font.heightAtSize(10), 6);
    // The heuristic overshoots proportional text by a wide margin.
    expect(estimateStampBox(header).width).toBeGreaterThan(box.width * 1.1);
  });

  it('loads workspace fonts and image sizes through the given sources', async () => {
    const def: StampDefinition = {
      id: 'x',
      name: 'x',
      layers: [
        { id: 'a', type: 'text', text: '学会', font: { kind: 'workspace', path: 'fonts/ipag.ttf' }, size: 12, color: '#000000' },
        { id: 'b', type: 'image', src: 'assets/logo.jpg', width: 40, dy: 20 },
      ],
    };
    const m = new StampMetrics({
      resolveFont: async (ref) => ({ ref, bytes: IPAG, hashMismatch: false }),
      readImage: async () => JPEG,
    });
    expect(await m.prepare([def])).toBe(true);
    expect(m.fonts.size).toBe(1);
    const natural = m.images.get('assets/logo.jpg');
    expect(natural).toBeDefined();
    const box = measureLayers([def.layers[1]], { images: m.images });
    expect(box.height).toBeCloseTo((40 * natural!.height) / natural!.width, 6);
  });

  it('keeps the estimate when a font cannot be read', async () => {
    const m = new StampMetrics({ resolveFont: () => Promise.reject(new Error('gone')), readImage: () => Promise.reject(new Error('gone')) });
    const def: StampDefinition = {
      id: 'y',
      name: 'y',
      layers: [{ id: 'a', type: 'text', text: 'abc', font: { kind: 'workspace', path: 'fonts/missing.ttf' }, size: 12, color: '#000000' }],
    };
    expect(await m.prepare([def])).toBe(false);
    expect(measureLayers(def.layers, { fonts: m.fonts }).width).toBe(estimateStampBox(def).width);
  });
});

describe('imageNaturalSize', () => {
  it('reads PNG and JPEG headers like pdf-lib does', async () => {
    expect(imageNaturalSize(PNG_1x1)).toEqual({ width: 1, height: 1 });
    const doc = await PDFDocument.create();
    const jpg = await doc.embedJpg(JPEG);
    expect(imageNaturalSize(JPEG)).toEqual({ width: jpg.width, height: jpg.height });
    expect(imageNaturalSize(new Uint8Array([1, 2, 3]))).toBeUndefined();
  });
});
