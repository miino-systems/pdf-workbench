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
import { fontMetricsKey, unionLayerBoxes, type LayerBox } from './measure';
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
  const { sourceBytes, definitions, instances, fileName, resolveFont, resolveImage } = input;
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
          getFont,
          getImage,
          warnings,
        });
        if (drawable) drawables.push(drawable);
      }
      if (drawables.length === 0) continue;

      const union = unionLayerBoxes(drawables.map((d) => d.box));
      const origin = resolveStampOrigin(position, visible, union);

      for (const { box, draw } of drawables) {
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
            page: ctx.pages.indexOf(ctx.pageNum) + (layer.startAt ?? 1),
            pages: layer.totalPagesOverride ?? ctx.pageCount,
            file: ctx.fileName,
          })
        : layer.text;

    const { font } = fontEntry;
    const { lines, lineHeight } = layoutTextBlock(text, layer.size);

    let width: number;
    try {
      width = lines.reduce((max, line) => Math.max(max, font.widthOfTextAtSize(line, layer.size)), 0);
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
        ctx.page.drawText(text, {
          x: contentOrigin.x,
          y: baselineY,
          font,
          size: layer.size,
          color: rgb(color.r, color.g, color.b),
          opacity: layer.opacity,
          lineHeight,
          // `pageAngle` is how far the *page* rotates the content clockwise
          // when displayed; the glyph must be rotated the opposite amount
          // further (i.e. `+ pageAngle` in content space) so that, once the
          // page's own rotation is applied, it appears rotated by exactly
          // `layer.rotate` (CCW) to the viewer.
          rotate: degrees((layer.rotate ?? 0) + pageAngle),
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
