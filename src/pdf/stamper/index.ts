/**
 * Public API of the `pdf/stamper` module (see docs/ARCHITECTURE.md §3).
 * Pure: no filesystem or DOM access anywhere in this module.
 */
export { applyStamps } from './applyStamps';
export type { StampJobInput, StampJobResult } from './types';
export {
  measureStamp,
  measureLayers,
  estimateStampBox,
  computeLayerBox,
  unionLayerBoxes,
  estimateTextWidth,
  fontMetricsKey,
  type Box,
  type LayerBox,
  type UnionBox,
  type FontMetrics,
  type ImageSize,
  type MeasureContext,
} from './measure';
export { layoutTextBlock, DEFAULT_LINE_HEIGHT_FACTOR, type TextBlockLayout } from './sanitize';
