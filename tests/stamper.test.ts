import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFString, decodePDFRawStream, degrees } from 'pdf-lib';
import { applyStamps } from '@/pdf/stamper';
import { FontResolver } from '@/fonts';
import { sha256 } from '@/fonts/hash';
import type { StampDefinition, StampInstance } from '@/core/types';

const A4: [number, number] = [595.28, 841.89];

const IPAG_FIXTURE = path.resolve(__dirname, 'fixtures/ipag-subset.ttf');
const JPEG_FIXTURE = path.resolve(__dirname, 'fixtures/tiny.jpg');

// Minimal valid 1x1 transparent PNG.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function tinyPngBytes(): Uint8Array {
  return new Uint8Array(Buffer.from(TINY_PNG_BASE64, 'base64'));
}

function tinyJpegBytes(): Uint8Array {
  return new Uint8Array(readFileSync(JPEG_FIXTURE));
}

/**
 * Build a 3-page A4 PDF with:
 *  - page 1: a URI link annotation.
 *  - page 2: an internal GoTo link annotation targeting page 3.
 */
async function buildSourcePdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage(A4);
  const page2 = doc.addPage(A4);
  const page3 = doc.addPage(A4);

  const linkRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 700, 200, 720],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'URI', URI: PDFString.of('https://example.org') },
    }),
  );
  page1.node.set(PDFName.of('Annots'), doc.context.obj([linkRef]));

  const gotoRef = doc.context.register(
    doc.context.obj({
      Type: 'Annot',
      Subtype: 'Link',
      Rect: [50, 600, 200, 620],
      Border: [0, 0, 0],
      A: { Type: 'Action', S: 'GoTo', D: [page3.ref, 'Fit'] },
    }),
  );
  page2.node.set(PDFName.of('Annots'), doc.context.obj([gotoRef]));

  return doc.save();
}

function draftDefinition(): StampDefinition {
  return {
    id: 'draft',
    name: 'DRAFT',
    layers: [
      {
        id: 'text',
        type: 'text',
        text: 'DRAFT',
        font: { kind: 'standard', name: 'Helvetica-Bold' },
        size: 40,
        color: '#c00000',
        opacity: 0.3,
      },
    ],
    defaultPosition: { anchor: 'top-center', offsetX: 0, offsetY: 36 },
  };
}

function pageNumberDefinition(): StampDefinition {
  return {
    id: 'page-number',
    name: 'Page Number',
    layers: [
      {
        id: 'pn',
        type: 'pageNumber',
        template: '{page} / {pages}',
        font: { kind: 'standard', name: 'Helvetica' },
        size: 10,
        color: '#000000',
      },
    ],
    defaultPosition: { anchor: 'bottom-center', offsetX: 0, offsetY: 24 },
  };
}

function imageDefinition(src: string): StampDefinition {
  return {
    id: `image-${src}`,
    name: 'Image',
    layers: [{ id: 'img', type: 'image', src, width: 40 }],
    defaultPosition: { anchor: 'bottom-right', offsetX: 36, offsetY: 36 },
  };
}

describe('applyStamps', () => {
  it('stamps text/pageNumber/image layers while preserving link annotations', async () => {
    const sourceBytes = await buildSourcePdf();
    const sourceHashBefore = await sha256(sourceBytes);

    const definitions = [draftDefinition(), pageNumberDefinition(), imageDefinition('assets/logo.png')];
    const instances: StampInstance[] = [
      { id: 'inst-draft', stampId: 'draft', enabled: true, pages: { kind: 'all' } },
      { id: 'inst-pn', stampId: 'page-number', enabled: true, pages: { kind: 'all' } },
      { id: 'inst-img', stampId: 'image-assets/logo.png', enabled: true, pages: { kind: 'first' } },
    ];

    const images = new Map<string, Uint8Array>([['assets/logo.png', tinyPngBytes()]]);

    const result = await applyStamps({
      sourceBytes,
      definitions,
      instances,
      fileName: 'papers/paper001.pdf',
      resolveFont: async (ref) => {
        if (ref.kind !== 'standard') throw new Error('unexpected font ref in this test');
        return { ref, hashMismatch: false };
      },
      resolveImage: async (src) => {
        const bytes = images.get(src);
        if (!bytes) throw new Error(`no fixture image for ${src}`);
        return bytes;
      },
    });

    // Source is untouched.
    expect(await sha256(sourceBytes)).toBe(sourceHashBefore);
    // Output differs from input.
    expect(Buffer.compare(Buffer.from(result.bytes), Buffer.from(sourceBytes))).not.toBe(0);
    expect(result.pageCount).toBe(3);
    expect(result.warnings).toEqual([]);

    // applied pages per instance.
    expect(result.applied).toEqual(
      expect.arrayContaining([
        { instanceId: 'inst-draft', pages: [1, 2, 3] },
        { instanceId: 'inst-pn', pages: [1, 2, 3] },
        { instanceId: 'inst-img', pages: [1] },
      ]),
    );

    // fonts list: 2 distinct standard fonts embedded (Helvetica-Bold, Helvetica).
    expect(result.fonts.length).toBe(2);
    expect(result.fonts.every((f) => f.ref.kind === 'standard')).toBe(true);

    // Output loads fine with pdf-lib.
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(3);

    // Page 1: still exactly one Link annotation with the same URI.
    const page1 = output.getPage(0);
    const annots1 = page1.node.Annots();
    expect(annots1).toBeDefined();
    expect(annots1!.size()).toBe(1);
    const annot1 = annots1!.lookup(0, PDFDict);
    expect(annot1.lookup(PDFName.of('Subtype'), PDFName).asString()).toBe(PDFName.of('Link').asString());
    const action1 = annot1.lookup(PDFName.of('A'), PDFDict);
    expect(action1.lookup(PDFName.of('URI'), PDFString).asString()).toBe('https://example.org');

    // Page 2: the internal GoTo link is still present.
    const page2 = output.getPage(1);
    const annots2 = page2.node.Annots();
    expect(annots2).toBeDefined();
    expect(annots2!.size()).toBe(1);
    const annot2 = annots2!.lookup(0, PDFDict);
    const action2 = annot2.lookup(PDFName.of('A'), PDFDict);
    expect(action2.lookup(PDFName.of('S'), PDFName).asString()).toBe(PDFName.of('GoTo').asString());

    // Page 3 (no annotations originally) still has none. Drawing on a page
    // makes pdf-lib "normalize" it, which materializes an empty /Annots
    // array where there was none before — either absent or empty is fine.
    const page3 = output.getPage(2);
    expect(page3.node.Annots()?.size() ?? 0).toBe(0);

    // Font resources were embedded on the stamped pages.
    for (const page of [page1, page2, page3]) {
      const resources = page.node.Resources();
      expect(resources).toBeDefined();
      const fontDict = resources!.lookupMaybe(PDFName.of('Font'), PDFDict);
      expect(fontDict).toBeDefined();
      expect(fontDict!.keys().length).toBeGreaterThanOrEqual(1);
    }
  });

  it('embeds a JPEG image layer', async () => {
    const sourceBytes = await buildSourcePdf();
    const definitions = [imageDefinition('assets/photo.jpg')];
    const instances: StampInstance[] = [
      { id: 'inst-jpg', stampId: 'image-assets/photo.jpg', enabled: true, pages: { kind: 'last' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions,
      instances,
      resolveFont: async (ref) => ({ ref, hashMismatch: false }),
      resolveImage: async () => tinyJpegBytes(),
    });

    expect(result.warnings).toEqual([]);
    expect(result.applied).toEqual([{ instanceId: 'inst-jpg', pages: [3] }]);
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(3);
  });

  it('embeds a workspace Japanese font and draws Japanese text without throwing', async () => {
    const sourceBytes = await buildSourcePdf();
    const fontBytes = new Uint8Array(readFileSync(IPAG_FIXTURE));
    const resolver = new FontResolver({ readWorkspaceFile: async () => fontBytes });

    const definitions: StampDefinition[] = [
      {
        id: 'jp',
        name: 'Japanese',
        layers: [
          {
            id: 'text',
            type: 'text',
            text: '日本語フォントテスト',
            font: { kind: 'workspace', path: 'fonts/ipag-subset.ttf' },
            size: 14,
            color: '#000000',
          },
        ],
        defaultPosition: { anchor: 'top-left', offsetX: 36, offsetY: 36 },
      },
    ];
    const instances: StampInstance[] = [
      { id: 'inst-jp', stampId: 'jp', enabled: true, pages: { kind: 'first' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions,
      instances,
      resolveFont: (ref) => resolver.resolve(ref),
      resolveImage: async () => {
        throw new Error('no images expected');
      },
    });

    expect(result.warnings).toEqual([]);
    expect(result.fonts).toHaveLength(1);
    expect(result.fonts[0].ref.kind).toBe('workspace');
    expect(result.fonts[0].sha256).toBe(await sha256(fontBytes));

    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(3);
    const page1 = output.getPage(0);
    const fontDict = page1.node.Resources()!.lookupMaybe(PDFName.of('Font'), PDFDict);
    expect(fontDict).toBeDefined();
    expect(fontDict!.keys().length).toBeGreaterThanOrEqual(1);
  });

  it('warns (but does not throw) when Japanese text is drawn with a standard font', async () => {
    const sourceBytes = await buildSourcePdf();
    const definitions: StampDefinition[] = [
      {
        id: 'jp-standard',
        name: 'Japanese on standard font',
        layers: [
          {
            id: 'text',
            type: 'text',
            text: '日本語',
            font: { kind: 'standard', name: 'Helvetica' },
            size: 14,
            color: '#000000',
          },
        ],
      },
    ];
    const instances: StampInstance[] = [
      { id: 'inst', stampId: 'jp-standard', enabled: true, pages: { kind: 'first' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions,
      instances,
      resolveFont: async (ref) => ({ ref, hashMismatch: false }),
      resolveImage: async () => {
        throw new Error('no images expected');
      },
    });

    expect(result.warnings.length).toBeGreaterThanOrEqual(1);
    expect(result.warnings[0]).toMatch(/not supported by standard font/);
    // Job still completes and produces a loadable PDF.
    const output = await PDFDocument.load(result.bytes);
    expect(output.getPageCount()).toBe(3);
  });

  it('rejects with a clear error for unsupported image bytes', async () => {
    const sourceBytes = await buildSourcePdf();
    const definitions = [imageDefinition('assets/not-an-image.txt')];
    const instances: StampInstance[] = [
      { id: 'inst-bad-img', stampId: 'image-assets/not-an-image.txt', enabled: true, pages: { kind: 'first' } },
    ];

    await expect(
      applyStamps({
        sourceBytes,
        definitions,
        instances,
        resolveFont: async (ref) => ({ ref, hashMismatch: false }),
        resolveImage: async () => new TextEncoder().encode('not an image, just text'),
      }),
    ).rejects.toThrow(/unsupported image format/);
  });

  it('warns about instances referencing an unknown stampId instead of throwing', async () => {
    const sourceBytes = await buildSourcePdf();
    const instances: StampInstance[] = [
      { id: 'inst-orphan', stampId: 'does-not-exist', enabled: true, pages: { kind: 'all' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions: [],
      instances,
      resolveFont: async (ref) => ({ ref, hashMismatch: false }),
      resolveImage: async () => {
        throw new Error('no images expected');
      },
    });

    expect(result.applied).toEqual([]);
    expect(result.warnings.some((w) => w.includes('unknown stampId'))).toBe(true);
  });

  it('places a stamp correctly (in the *visible* frame) on a page with /Rotate 90, without crashing', async () => {
    // Regression: the content<->visible coordinate remapping for rotated
    // pages had its 90°/270° branches swapped, silently mis-placing every
    // stamp on a rotated page (though never crashing).
    const rawWidth = 200;
    const rawHeight = 100;
    const doc = await PDFDocument.create();
    const page = doc.addPage([rawWidth, rawHeight]);
    page.setRotation(degrees(90));
    const sourceBytes = await doc.save();

    const boxWidth = 20;
    const boxHeight = 8;
    const offsetX = 10;
    const offsetY = 5;
    const definitions: StampDefinition[] = [
      {
        id: 'img',
        name: 'img',
        layers: [{ id: 'l', type: 'image', src: 'assets/logo.png', width: boxWidth, height: boxHeight }],
        defaultPosition: { anchor: 'bottom-right', offsetX, offsetY },
      },
    ];
    const instances: StampInstance[] = [
      { id: 'inst', stampId: 'img', enabled: true, pages: { kind: 'all' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions,
      instances,
      resolveFont: async (ref) => ({ ref, hashMismatch: false }),
      resolveImage: async () => tinyPngBytes(),
    });
    expect(result.warnings).toEqual([]);

    const output = await PDFDocument.load(result.bytes);
    const outPage = output.getPage(0);
    // The page's own /Rotate is untouched by stamping.
    expect(outPage.getRotation().angle).toBe(90);

    // pdf-lib's `drawImage` emits separate `cm` operators for translate,
    // rotate and scale (in that order); the *translate* one — recognisable
    // by its identity linear part `1 0 0 1 tx ty cm` — is where pdf-lib
    // placed the image's origin in *content* space.
    const contentsArr = outPage.node.Contents();
    if (!(contentsArr instanceof PDFArray)) throw new Error('expected page Contents to be an array of streams');
    let text = '';
    for (let i = 0; i < contentsArr.size(); i++) {
      const stream = contentsArr.lookup(i, PDFRawStream);
      text += new TextDecoder().decode(decodePDFRawStream(stream).decode());
    }
    const m = text.match(/1 0 0 1 (-?[\d.]+) (-?[\d.]+) cm/);
    expect(m).toBeTruthy();
    const contentX = parseFloat(m![1]);
    const contentY = parseFloat(m![2]);

    // Map content space -> visible (as-displayed) space using the known-correct
    // forward transform for angle=90 (independently re-derived here, not
    // imported from the module under test): visible.x = content.y,
    // visible.y = raw.width - content.x.
    const visibleX = contentY;
    const visibleY = rawWidth - contentX;

    // Expected bottom-left of the stamp box in the *visible* frame for a
    // bottom-right anchor on the rotated (100 x 200) visible page.
    const visiblePageWidth = rawHeight; // page displays landscape-swapped
    expect(visibleX).toBeCloseTo(visiblePageWidth - offsetX - boxWidth, 5);
    expect(visibleY).toBeCloseTo(offsetY, 5);
  });

  it('skips disabled instances entirely', async () => {
    const sourceBytes = await buildSourcePdf();
    const instances: StampInstance[] = [
      { id: 'inst-off', stampId: 'draft', enabled: false, pages: { kind: 'all' } },
    ];

    const result = await applyStamps({
      sourceBytes,
      definitions: [draftDefinition()],
      instances,
      resolveFont: async (ref) => ({ ref, hashMismatch: false }),
      resolveImage: async () => {
        throw new Error('no images expected');
      },
    });

    expect(result.applied).toEqual([]);
    expect(result.fonts).toEqual([]);
  });
});
