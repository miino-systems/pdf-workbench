import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFDocument } from 'pdf-lib';
import type { Rect } from '@/core/types';
import { destroyPdfDocument, loadPdfDocument } from './document.js';
import { getPdfjs } from './pdfjs.js';

/** Decoded pixels, RGBA, row 0 at the top (same shape as `ImageData`). */
export interface RgbaImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

/** An image drawn on a page: where (content space, pt) and its pixels. */
export interface PageImage {
  rect: Rect;
  image: RgbaImage;
}

type Matrix = [number, number, number, number, number, number];

function multiply(m: Matrix, n: Matrix): Matrix {
  // n applied first, then m (PDF: `cm` pre-multiplies the CTM).
  return [
    n[0] * m[0] + n[1] * m[2],
    n[0] * m[1] + n[1] * m[3],
    n[2] * m[0] + n[3] * m[2],
    n[2] * m[1] + n[3] * m[3],
    n[4] * m[0] + n[5] * m[2] + m[4],
    n[4] * m[1] + n[5] * m[3] + m[5],
  ];
}

/** Bounding box of the unit square under `m` (an image is drawn into the unit square). */
function unitSquareBox(m: Matrix): Rect {
  const xs = [m[4], m[0] + m[4], m[2] + m[4], m[0] + m[2] + m[4]];
  const ys = [m[5], m[1] + m[5], m[3] + m[5], m[1] + m[3] + m[5]];
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

/** pdf.js `ImageKind`: 1 = 1 bit gray (set bit = white), 2 = RGB, 3 = RGBA. */
interface PdfjsImage {
  width: number;
  height: number;
  kind?: number;
  data?: Uint8Array | Uint8ClampedArray;
  bitmap?: CanvasImageSource & { width: number; height: number };
}

function toRgba(img: PdfjsImage): RgbaImage | undefined {
  const { width, height } = img;
  if (!(width > 0 && height > 0)) return undefined;
  if (img.data) {
    const src = img.data;
    const out = new Uint8ClampedArray(width * height * 4);
    if (img.kind === 3 && src.length >= width * height * 4) {
      out.set(src.subarray(0, out.length));
    } else if (img.kind === 2 && src.length >= width * height * 3) {
      for (let p = 0, q = 0; p < width * height; p++, q += 3) {
        out[p * 4] = src[q];
        out[p * 4 + 1] = src[q + 1];
        out[p * 4 + 2] = src[q + 2];
        out[p * 4 + 3] = 255;
      }
    } else if (img.kind === 1) {
      const rowBytes = (width + 7) >> 3;
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const bit = (src[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1;
          const i = (y * width + x) * 4;
          out[i] = out[i + 1] = out[i + 2] = bit ? 255 : 0;
          out[i + 3] = 255;
        }
      }
    } else {
      return undefined;
    }
    return { data: out, width, height };
  }
  if (img.bitmap && typeof OffscreenCanvas !== 'undefined') {
    const canvas = new OffscreenCanvas(width, height);
    const g = canvas.getContext('2d');
    if (!g) return undefined;
    g.drawImage(img.bitmap, 0, 0);
    const d = g.getImageData(0, 0, width, height);
    return { data: d.data, width, height };
  }
  return undefined;
}

function resolveObject(page: PDFPageProxy, id: string): Promise<PdfjsImage | undefined> {
  const store = id.startsWith('g_') ? page.commonObjs : page.objs;
  return new Promise((resolve) => {
    try {
      store.get(id, (obj: unknown) => resolve((obj as PdfjsImage | null) ?? undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Raster images drawn on a page (XObject and inline images; image masks
 * and repeated tiles are left out), with the box each covers in PDF user
 * space (content space, before `/Rotate`), including images inside form
 * XObjects. Load the document with `imagesAsData` so pixels come back as
 * data rather than browser bitmaps.
 */
export async function getPageImages(doc: PDFDocumentProxy, pageNumber: number): Promise<PageImage[]> {
  const pdfjs = await getPdfjs();
  const OPS = pdfjs.OPS;
  const page = await doc.getPage(pageNumber);
  const list = await page.getOperatorList();

  const found: { rect: Rect; image: Promise<PdfjsImage | undefined> }[] = [];
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  for (let i = 0; i < list.fnArray.length; i++) {
    const fn = list.fnArray[i];
    const args = list.argsArray[i] as unknown[];
    if (fn === OPS.save) {
      stack.push(ctm);
    } else if (fn === OPS.restore) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.transform) {
      ctm = multiply(ctm, args as Matrix);
    } else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      const matrix = args[0] as Matrix | null | undefined;
      if (matrix && matrix.length === 6) ctm = multiply(ctm, [...matrix] as Matrix);
    } else if (fn === OPS.paintFormXObjectEnd) {
      ctm = stack.pop() ?? ctm;
    } else if (fn === OPS.paintImageXObject) {
      found.push({ rect: unitSquareBox(ctm), image: resolveObject(page, String(args[0])) });
    } else if (fn === OPS.paintInlineImageXObject) {
      found.push({ rect: unitSquareBox(ctm), image: Promise.resolve(args[0] as PdfjsImage) });
    }
  }

  const out: PageImage[] = [];
  for (const f of found) {
    const raw = await f.image;
    const image = raw && toRgba(raw);
    if (image) out.push({ rect: f.rect, image });
  }
  return out;
}

/**
 * Decode a PNG/JPEG file (e.g. a stamp's image layer) to RGBA the same way
 * images in a PDF are decoded: embed it into a one-page PDF and read it
 * back through pdf.js, so works without a DOM too.
 */
export async function decodeImageFile(bytes: Uint8Array): Promise<RgbaImage | undefined> {
  const tmp = await PDFDocument.create();
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47;
  const img = isPng ? await tmp.embedPng(bytes) : await tmp.embedJpg(bytes);
  tmp.addPage([img.width, img.height]).drawImage(img, { x: 0, y: 0, width: img.width, height: img.height });
  const doc = await loadPdfDocument(await tmp.save(), { imagesAsData: true });
  try {
    return (await getPageImages(doc, 1))[0]?.image;
  } finally {
    await destroyPdfDocument(doc);
  }
}
