/**
 * `preflight/` — pure(ish) checks a PDF against a `PreflightConfig`: page
 * size/orientation/count (object-based, via `pdf/reader`) plus optional
 * object- and raster-based margin/collision checks.
 */
export {
  runPreflight,
  marginsForPage,
  marginTolerancePt,
  mergeFindings,
  DEFAULT_MARGIN_TOLERANCE_PT,
  MAX_FINDINGS_PER_CODE,
  type PageTextBox,
  type PreflightContext,
} from './checks.js';
export {
  checkMarginsByRaster,
  findMarginInkByRaster,
  checkStampCollision,
  type ImageDataLike,
  type MarginInkOptions,
  type MarginsPt,
  type RasterCheckOptions,
  type StampCollisionOptions,
  type StampCollisionResult,
} from './raster.js';
export { reportFileName, summarizeReport } from './report.js';
export { annotatePreflightPdf, describePreflightCode } from './annotate.js';
