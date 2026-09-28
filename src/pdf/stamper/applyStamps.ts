/**
 * Applies stamp definitions/instances to a PDF using pdf-lib, drawing
 * directly onto existing pages (never `embedPage`/`drawPage`) so that link
 * annotations and everything else already on the page is left untouched.
 *
 * Pure: no filesystem or DOM access. Callers supply `resolveFont` /
 * `resolveImage` (see {@link StampJobInput}).
 */
import fontkitModule from '@pdf-lib/fontkit';
import { PDFDocument, PDFFont, PDFImage, PDFPage, degrees, rgb } from 'pdf-lib';
import type { FontRef, ImageLayer, ResolvedFont, StampLayer } from '@/core/types';
import { effectivePosition, renderPageNumber, resolvePages, resolveStampOrigin } from '@/stamps';
import { parseHexColor } from '@/stamps/color';
import { toPdfLibStandardFont } from '@/fonts/standard';
import { arrangeLayerBoxes, fontMetricsKey, unionLayerBoxes, type LayerBox } from './measure';
import { normalizeAngle, toContentPoint, visiblePageSize } from './rotation';
import { layoutTextBlock } from './sanitize';
import type { StampJobInput, StampJobResult } from './types';

/** `Fontkit` isn't part of pdf-lib's public API surface; recover its shape structurally. */
type RegisterFontkitArg = Parameters<PDFDocument['registerFontkit']>[0];

/**
 * pdf-lib's JPEG embedder reads `bytes.buffer` directly via `DataView`,
 * ignoring `byteOffset`/`byteLength` — a `Uint8Array` view onto a larger
 * pooled buffer (common for Node `Buffer`s, e.g. from `fs.readFileSync`)
 * then misreads the SOI marker. Copy defensively whenever the view isn't
 * already a tight wrapper around its own buffer.
 */
function normalizeBytes(bytes: Uint8Array): Uint8Array {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes : bytes.slice();
}

/** PNG signature: 89 50 4E 47. JPEG signature: FF D8. */
function detectImageKind(bytes: Uint8Array): 'png' | 'jpeg' | undefined {
  if (bytes.length >= 4 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xd8) return 'jpeg';
  return undefined;
}

function describeFontRef(ref: FontRef): string {
  switch (ref.kind) {
    case 'standard':
      return ref.name;
    case 'local':
      return ref.family;
    case 'workspace':
      return ref.family ?? ref.path;
    case 'file':
      return ref.family ?? ref.name;
  }
}

interface DrawableLayer {
  box: LayerBox;
  draw: (contentOrigin: { x: number; y: number }, rotateDegrees: number) => void;
}

export async function applyStamps(input: StampJobInput): Promise<StampJobResult> {
  const { sourceBytes, definitions, instances, fileName, pageNumberStart, resolveFont, resolveImage } = input;
  const warnings: string[] = [];

  const pdfDoc = await PDFDocument.load(sourceBytes, {
    updateMetadata: false,
    ignoreEncryption: true,
  });
  pdfDoc.registerFontkit(fontkitModule as unknown as RegisterFontkitArg);

  const pageCount = pdfDoc.getPageCount();
  const defsById = new Map(definitions.map((d) => [d.id, d]));

  const fontCache = new Map<string, Promise<{ font: PDFFont; resolved: ResolvedFont } | undefined>>();
  const imageCache = new Map<string, Promise<PDFImage>>();
  const embeddedFonts: { ref: FontRef; sha256?: string }[] = [];

  async function getFont(ref: FontRef): Promise<{ font: PDFFont; resolved: ResolvedFont } | undefined> {
    const key = fontMetricsKey(ref);
    let pending = fontCache.get(key);
    if (!pending) {
      pending = (async () => {
        let resolved: ResolvedFont;
        try {
          resolved = await resolveFont(ref);
        } catch (err) {
          warnings.push(`failed to resolve font "${describeFontRef(ref)}": ${errorMessage(err)}`);
          return undefined;
        }
        try {
          const font =
            resolved.ref.kind === 'standard'
              ? pdfDoc.embedStandardFont(toPdfLibStandardFont(resolved.ref.name))
              : await pdfDoc.embedFont(requireBytes(resolved), { subset: true });
          embeddedFonts.push({ ref: resolved.ref, sha256: resolved.sha256 });
          return { font, resolved };
        } catch (err) {
          warnings.push(`failed to embed font "${describeFontRef(ref)}": ${errorMessage(err)}`);
          return undefined;
        }
      })();
      fontCache.set(key, pending);
    }
    return pending;
  }

  async function getImage(src: string): Promise<PDFImage> {
    let pending = imageCache.get(src);
    if (!pending) {
      pending = (async () => {
        const bytes = normalizeBytes(await resolveImage(src));
        const kind = detectImageKind(bytes);
        if (kind === 'png') return pdfDoc.embedPng(bytes);
        if (kind === 'jpeg') return pdfDoc.embedJpg(bytes);
        throw new Error(
          `unsupported image format for "${src}": expected a PNG (89 50 4E 47…) or JPEG (FF D8…) file`,
        );
      })();
      imageCache.set(src, pending);
    }
    return pending;
  }

  const applied: { instanceId: string; pages: number[] }[] = [];

  for (const inst of instances) {
    if (!inst.enabled) continue;

    const def = defsById.get(inst.stampId);
    if (!def) {
      warnings.push(`instance "${inst.id}" references unknown stampId "${inst.stampId}"`);
      continue;
    }

    const pages = resolvePages(inst.pages, pageCount);
    applied.push({ instanceId: inst.id, pages });
    const position = effectivePosition(def, inst);

    for (const pageNum of pages) {
      const page = pdfDoc.getPage(pageNum - 1);
      const raw = page.getSize();
      const angle = normalizeAngle(page.getRotation().angle);
      const visible = visiblePageSize(raw, angle);

      const drawables: DrawableLayer[] = [];
      for (const layer of def.layers) {
        const drawable = await buildDrawableLayer(layer, {
          pdfDoc,
          page,
          pageNum,
          pages,
          pageCount,
          fileName,
          pageNumberStart,
          getFont,
          getImage,
          warnings,
        });
        if (drawable) drawables.push(drawable);
      }
      if (drawables.length === 0) continue;

      const boxes = arrangeLayerBoxes(drawables.map((d) => d.box), def.layout);
      const union = unionLayerBoxes(boxes);
      const origin = resolveStampOrigin(position, visible, union);

      for (const [i, { draw }] of drawables.entries()) {
        const box = boxes[i];
        const visibleOrigin = {
          x: origin.x + (box.dx - union.x),
          y: origin.y + (box.dy - union.y),
        };
        const contentOrigin = toContentPoint(visibleOrigin, angle, raw);
        draw(contentOrigin, angle);
      }
    }
  }

  const bytes = await pdfDoc.save({ useObjectStreams: false, updateFieldAppearances: false });

  return { bytes, pageCount, applied, fonts: dedupeFonts(embeddedFonts), warnings };
}

interface BuildLayerContext {
  pdfDoc: PDFDocument;
  page: PDFPage;
  pageNum: number;
  pages: number[];
  pageCount: number;
  fileName?: string;
  pageNumberStart?: number;
  getFont: (ref: FontRef) => Promise<{ font: PDFFont; resolved: ResolvedFont } | undefined>;
  getImage: (src: string) => Promise<PDFImage>;
  warnings: string[];
}

async function buildDrawableLayer(
  layer: StampLayer,
  ctx: BuildLayerContext,
): Promise<DrawableLayer | undefined> {
  if (layer.type === 'text' || layer.type === 'pageNumber') {
    const fontEntry = await ctx.getFont(layer.font);
    if (!fontEntry) return undefined; // warning already recorded by getFont

    const text =
      layer.type === 'pageNumber'
        ? renderPageNumber(layer.template, {
            page:
              ctx.pageNumberStart !== undefined
                ? ctx.pageNumberStart + (ctx.pageNum - 1)
                : ctx.pages.indexOf(ctx.pageNum) + (layer.startAt ?? 1),
            pages: layer.totalPagesOverride ?? ctx.pageCount,
            file: ctx.fileName,
          })
        : layer.text;

    const { font } = fontEntry;
    const { lines, lineHeight } = layoutTextBlock(text, layer.size, layer.lineHeight);

    let width: number;
    let lineWidths: number[];
    try {
      lineWidths = lines.map((line) => font.widthOfTextAtSize(line, layer.size));
      width = Math.max(0, ...lineWidths);
    } catch (err) {
      ctx.warnings.push(
        `text contains characters not supported by standard font ${describeFontRef(fontEntry.resolved.ref)}; ` +
          `choose an embedded font (${errorMessage(err)})`,
      );
      return undefined;
    }

    const height = lines.length > 1 ? lines.length * lineHeight : font.heightAtSize(layer.size);
    const box: LayerBox = { dx: layer.dx ?? 0, dy: layer.dy ?? 0, width, height };
    const color = parseHexColor(layer.color);

    return {
      box,
      draw: (contentOrigin, pageAngle) => {
        // (x,y) is the baseline of the *first* (topmost) line; approximate
        // the ascent as 0.8em and descent as 0.2em, which is close enough
        // for the general-purpose stamps this module draws.
        const baselineY = contentOrigin.y + box.height - layer.size * 0.8;
        // `pageAngle` is how far the *page* rotates the content clockwise
        // when displayed; the glyph must be rotated the opposite amount
        // further (i.e. `+ pageAngle` in content space) so that, once the
        // page's own rotation is applied, it appears rotated by exactly
        // `layer.rotate` (CCW) to the viewer.
        const angle = (layer.rotate ?? 0) + pageAngle;
        const options = {
          font,
          size: layer.size,
          color: rgb(color.r, color.g, color.b),
          opacity: layer.opacity,
          lineHeight,
          rotate: degrees(angle),
        };
        const align = layer.align ?? 'left';
        if (align === 'left') {
          ctx.page.drawText(text, { ...options, x: contentOrigin.x, y: baselineY });
          return;
        }
        // Centred / right-aligned: draw line by line, each shifted within the
        // block (as wide as its longest line) along the rotated text axes.
        const rad = (angle * Math.PI) / 180;
        const [cos, sin] = [Math.cos(rad), Math.sin(rad)];
        lines.forEach((line, i) => {
          const ox = (width - lineWidths[i]) * (align === 'center' ? 0.5 : 1);
          const oy = -i * lineHeight;
          ctx.page.drawText(line, {
            ...options,
            x: contentOrigin.x + ox * cos - oy * sin,
            y: baselineY + ox * sin + oy * cos,
          });
        });
      },
    };
  }

  if (layer.type === 'image') {
    let image: PDFImage;
    try {
      image = await ctx.getImage(layer.src);
    } catch (err) {
      // Unlike unsupported glyphs, a broken/unreadable image is treated as
      // a hard failure for the whole job (there is no sensible fallback).
      throw err instanceof Error ? err : new Error(String(err));
    }
    const { width, height } = resolveImageBoxSize(layer, image);
    const aspectWarning = imageAspectWarning(layer, image);
    if (aspectWarning && !ctx.warnings.includes(aspectWarning)) ctx.warnings.push(aspectWarning);
    const box: LayerBox = { dx: layer.dx ?? 0, dy: layer.dy ?? 0, width, height };

    return {
      box,
      draw: (contentOrigin, pageAngle) => {
        ctx.page.drawImage(image, {
          x: contentOrigin.x,
          y: contentOrigin.y,
          width: box.width,
          height: box.height,
          opacity: layer.opacity,
          // See the equivalent comment on the text layer's `draw` above.
          rotate: degrees((layer.rotate ?? 0) + pageAngle),
        });
      },
    };
  }

  ctx.warnings.push(`layer type "${layer.type}" is not implemented; skipped`);
  return undefined;
}

function resolveImageBoxSize(layer: ImageLayer, image: PDFImage): { width: number; height: number } {
  if (layer.width !== undefined && layer.height !== undefined) {
    return { width: layer.width, height: layer.height };
  }
  if (layer.width !== undefined) {
    return { width: layer.width, height: layer.width * (image.height / image.width) };
  }
  if (layer.height !== undefined) {
    return { width: layer.height * (image.width / image.height), height: layer.height };
  }
  return { width: image.width, height: image.height };
}

/** Tolerance before a width+height pair counts as distorting the image. */
const ASPECT_TOLERANCE = 0.02;

/**
 * Warning when both width and height are given and they stretch the image
 * (more than 2% off its own aspect ratio); undefined otherwise.
 */
export function imageAspectWarning(layer: ImageLayer, natural: { width: number; height: number }): string | undefined {
  if (layer.width === undefined || layer.height === undefined || natural.width <= 0 || natural.height <= 0) return undefined;
  const wanted = layer.width / layer.height;
  const actual = natural.width / natural.height;
  if (Math.abs(wanted - actual) / actual <= ASPECT_TOLERANCE) return undefined;
  const keepHeight = Math.round((layer.width / actual) * 10) / 10;
  return (
    `画像 ${layer.src} の縦横比が元画像と違います（指定 ${layer.width}×${layer.height} pt，元画像 ${natural.width}×${natural.height} px）．` +
    `幅か高さの片方だけを指定すると縦横比が保たれます（幅 ${layer.width} pt なら高さ ${keepHeight} pt）`
  );
}

function requireBytes(resolved: ResolvedFont): Uint8Array {
  if (!resolved.bytes) {
    throw new Error(`resolved font "${describeFontRef(resolved.ref)}" has no bytes to embed`);
  }
  return resolved.bytes;
}

function dedupeFonts(
  fonts: { ref: FontRef; sha256?: string }[],
): { ref: FontRef; sha256?: string }[] {
  const seen = new Set<string>();
  const result: { ref: FontRef; sha256?: string }[] = [];
  for (const f of fonts) {
    const key = fontMetricsKey(f.ref);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(f);
  }
  return result;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
