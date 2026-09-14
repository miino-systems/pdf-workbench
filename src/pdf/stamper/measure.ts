/**
 * Bounding-box measurement for stamp definitions.
 *
 * Two flavours are provided:
 *  - {@link measureStamp} / {@link measureLayers}: accurate measurement given
 *    real font metrics (as produced by an embedded pdf-lib `PDFFont`) and
 *    image sizes — used by `applyStamps` and by any caller with access to a
 *    loaded document.
 *  - {@link estimateStampBox}: a cheap heuristic (`0.55 * size * chars`) that
 *    needs no pdf-lib document at all, for live position previews in the UI.
 */
import type { FontRef, StampDefinition, StampLayer } from '@/core/types';
import { renderPageNumber } from '@/stamps';
import { layoutTextBlock } from './sanitize';

/** Minimal shape of a pdf-lib `PDFFont` needed to measure text. */
export interface FontMetrics {
  widthOfTextAtSize(text: string, size: number): number;
  heightAtSize(size: number, options?: { descender?: boolean }): number;
}

export interface ImageSize {
  width: number;
  height: number;
}

export interface MeasureContext {
  /** 1-based page number substituted into `{page}`. Default 1. */
  page?: number;
  /** Total page count substituted into `{pages}`. Default 1. */
  pages?: number;
  /** Source file name/path substituted into `{file}`. */
  file?: string;
  /** Real font metrics, keyed the same way as `FontResolver`'s cache keys. */
  fonts?: Map<string, FontMetrics>;
  /** Natural (pre-scale) image sizes, keyed by `ImageLayer.src`. */
  images?: Map<string, ImageSize>;
}

export interface Box {
  width: number;
  height: number;
}

/** A single layer's box, positioned relative to the stamp's nominal origin. */
export interface LayerBox extends Box {
  dx: number;
  dy: number;
}

/** Crude text-width heuristic (no font metrics needed): ~0.55em per character. */
export function estimateTextWidth(text: string, size: number): number {
  const longestLine = text.split('\n').reduce((max, line) => Math.max(max, line.length), 0);
  return 0.55 * size * longestLine;
}

/** Cache key matching `FontResolver`'s, so callers can share one metrics map. */
export function fontMetricsKey(ref: FontRef): string {
  switch (ref.kind) {
    case 'standard':
      return `standard:${ref.name}`;
    case 'local':
      return `local:${ref.postscriptName}`;
    case 'workspace':
      return `workspace:${ref.path}`;
    case 'file':
      return `file:${ref.name}`;
  }
}

/**
 * Compute one layer's box (position + size), or `undefined` for a layer
 * type this module doesn't implement (line/rectangle/qrcode/dynamicText).
 * Uses real metrics from `ctx` when available, otherwise falls back to the
 * cheap text-width heuristic / a defaulted image size.
 */
export function computeLayerBox(layer: StampLayer, ctx: MeasureContext = {}): LayerBox | undefined {
  const dx = layer.dx ?? 0;
  const dy = layer.dy ?? 0;

  if (layer.type === 'text' || layer.type === 'pageNumber') {
    const text =
      layer.type === 'pageNumber'
        ? renderPageNumber(layer.template, {
            page: ctx.page ?? 1,
            pages: ctx.pages ?? 1,
            file: ctx.file,
          })
        : layer.text;

    const metrics = ctx.fonts?.get(fontMetricsKey(layer.font));
    const { lines, height: estimatedHeight } = layoutTextBlock(text, layer.size);
    const width = metrics
      ? lines.reduce((max, line) => Math.max(max, metrics.widthOfTextAtSize(line, layer.size)), 0)
      : estimateTextWidth(text, layer.size);
    // Single line: prefer the font's real ascent+descent span when known.
    // Multi-line: fall back to the lineHeight*lines heuristic either way.
    const height = metrics && lines.length === 1 ? metrics.heightAtSize(layer.size) : estimatedHeight;
    return { dx, dy, width, height };
  }

  if (layer.type === 'image') {
    const natural = ctx.images?.get(layer.src);
    const { width, height } = resolveImageBoxSize(layer.width, layer.height, natural);
    return { dx, dy, width, height };
  }

  // Unimplemented layer type (line/rectangle/qrcode/dynamicText): no box.
  return undefined;
}

function resolveImageBoxSize(
  width: number | undefined,
  height: number | undefined,
  natural: ImageSize | undefined,
): Box {
  if (width !== undefined && height !== undefined) return { width, height };
  if (width !== undefined) {
    const ratio = natural ? natural.height / natural.width : 1;
    return { width, height: width * ratio };
  }
  if (height !== undefined) {
    const ratio = natural ? natural.width / natural.height : 1;
    return { width: height * ratio, height };
  }
  return natural ?? { width: 100, height: 100 };
}

/** Bounding box (with its own origin) of a set of positioned layer boxes. */
export interface UnionBox extends Box {
  /** Offset of the union's bottom-left corner from the nominal (dx=0,dy=0) point. */
  x: number;
  y: number;
}

/** Union bounding box of already-positioned layer boxes. */
export function unionLayerBoxes(boxes: LayerBox[]): UnionBox {
  if (boxes.length === 0) return { x: 0, y: 0, width: 0, height: 0 };
  const minX = Math.min(...boxes.map((b) => b.dx));
  const minY = Math.min(...boxes.map((b) => b.dy));
  const maxX = Math.max(...boxes.map((b) => b.dx + b.width));
  const maxY = Math.max(...boxes.map((b) => b.dy + b.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/** Measure a definition's overall bounding box using real font/image metrics. */
export function measureLayers(layers: StampLayer[], ctx: MeasureContext = {}): Box {
  const boxes = layers
    .map((layer) => computeLayerBox(layer, ctx))
    .filter((b): b is LayerBox => b !== undefined);
  const { width, height } = unionLayerBoxes(boxes);
  return { width, height };
}

/** Async wrapper matching the `pdf/stamper` module contract's signature. */
export async function measureStamp(def: StampDefinition, ctx: MeasureContext = {}): Promise<Box> {
  return measureLayers(def.layers, ctx);
}

/**
 * Cheap, pdf-lib-free bounding box estimate for live UI previews (no real
 * font metrics or image sizes available).
 */
export function estimateStampBox(
  def: StampDefinition,
  ctx: { page?: number; pages?: number; file?: string } = {},
): Box {
  return measureLayers(def.layers, ctx);
}
