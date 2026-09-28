/**
 * Real font metrics and image sizes for the UI's stamp overlay, so the boxes
 * drawn over the preview match what `applyStamps` will actually draw instead
 * of the `0.55em per character` / `100x100` fallbacks of `estimateStampBox`.
 *
 * Fonts are embedded into a throwaway pdf-lib document (the same code path
 * `applyStamps` uses, so widths agree exactly); images are sized from their
 * PNG/JPEG headers. Everything is cached for the lifetime of the instance —
 * create a new one when the workspace is (re)loaded.
 */
import fontkitModule from '@pdf-lib/fontkit';
import { PDFDocument } from 'pdf-lib';
import type { FontRef, ResolvedFont, StampDefinition } from '@/core/types';
import { toPdfLibStandardFont } from '@/fonts/standard';
import { fontMetricsKey, type FontMetrics, type ImageSize } from './measure';

type RegisterFontkitArg = Parameters<PDFDocument['registerFontkit']>[0];

export interface StampMetricsSources {
  resolveFont: (ref: FontRef) => Promise<ResolvedFont>;
  readImage: (src: string) => Promise<Uint8Array>;
}

export class StampMetrics {
  /** Loaded font metrics, keyed by `fontMetricsKey` (pass as `MeasureContext.fonts`). */
  readonly fonts = new Map<string, FontMetrics>();
  /** Natural image sizes, keyed by `ImageLayer.src` (pass as `MeasureContext.images`). */
  readonly images = new Map<string, ImageSize>();
  /** Keys already requested (loaded, in flight or failed), so each is tried once. */
  private readonly requested = new Set<string>();
  private doc?: Promise<PDFDocument>;

  constructor(private readonly sources: StampMetricsSources) {}

  /**
   * Load the metrics of every font and image used by `defs` that hasn't been
   * requested yet. Resolves to true when anything new became available (the
   * caller should then re-measure); failures leave the heuristic in place.
   */
  async prepare(defs: StampDefinition[]): Promise<boolean> {
    const jobs: Promise<boolean>[] = [];
    for (const def of defs) {
      for (const layer of def.layers) {
        if (layer.type === 'text' || layer.type === 'pageNumber') {
          const key = fontMetricsKey(layer.font);
          if (this.requested.has(`font:${key}`)) continue;
          this.requested.add(`font:${key}`);
          jobs.push(this.loadFont(key, layer.font));
        } else if (layer.type === 'image' && layer.src) {
          if (this.requested.has(`image:${layer.src}`)) continue;
          this.requested.add(`image:${layer.src}`);
          jobs.push(this.loadImage(layer.src));
        }
      }
    }
    const results = await Promise.all(jobs);
    return results.some(Boolean);
  }

  private async loadFont(key: string, ref: FontRef): Promise<boolean> {
    try {
      const doc = await this.scratchDoc();
      if (ref.kind === 'standard') {
        this.fonts.set(key, doc.embedStandardFont(toPdfLibStandardFont(ref.name)));
        return true;
      }
      const resolved = await this.sources.resolveFont(ref);
      if (!resolved.bytes) return false;
      this.fonts.set(key, await doc.embedFont(resolved.bytes, { subset: true }));
      return true;
    } catch (e) {
      console.warn('overlay: font metrics unavailable, using estimate', ref, e);
      return false;
    }
  }

  private async loadImage(src: string): Promise<boolean> {
    try {
      const size = imageNaturalSize(await this.sources.readImage(src));
      if (!size) return false;
      this.images.set(src, size);
      return true;
    } catch (e) {
      console.warn('overlay: image size unavailable, using estimate', src, e);
      return false;
    }
  }

  private scratchDoc(): Promise<PDFDocument> {
    this.doc ??= PDFDocument.create().then((doc) => {
      doc.registerFontkit(fontkitModule as unknown as RegisterFontkitArg);
      return doc;
    });
    return this.doc;
  }
}

/**
 * Pixel size of a PNG or JPEG from its header (what pdf-lib's `PDFImage`
 * reports as `width`/`height`), or undefined for anything else.
 */
export function imageNaturalSize(bytes: Uint8Array): ImageSize | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // PNG: signature, then the IHDR chunk with width/height at offsets 16/20.
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  // JPEG: walk the marker segments up to the first SOFn frame header.
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2;
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) {
        i += 1;
        continue;
      }
      const marker = bytes[i + 1];
      if (marker === 0xff) {
        i += 1;
        continue;
      }
      const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
      if (isSof) return { height: view.getUint16(i + 5), width: view.getUint16(i + 7) };
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        i += 2;
        continue;
      }
      i += 2 + view.getUint16(i + 2);
    }
  }
  return undefined;
}
