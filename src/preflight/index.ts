/**
 * `preflight/` — pure(ish) checks a PDF against a `PreflightConfig`: page
 * size/orientation/count (object-based, via `pdf/reader`) plus optional
 * object- and raster-based margin/collision checks.
 */
export { runPreflight, marginsForPage, MAX_FINDINGS_PER_PAGE, type PreflightContext } from './checks.js';
export {
  checkMarginsByRaster,
  findMarginInkByRaster,
  checkStampCollision,
  type ImageDataLike,
  type MarginsPt,
  type RasterCheckOptions,
  type StampCollisionOptions,
  type StampCollisionResult,
} from './raster.js';
export { reportFileName, summarizeReport } from './report.js';
export { PREFLIGHT_PRESETS, applyPreflightPreset, type PreflightPreset } from './presets.js';
export { annotatePreflightPdf, describePreflightCode } from './annotate.js';
