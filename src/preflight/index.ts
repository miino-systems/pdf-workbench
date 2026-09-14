/**
 * `preflight/` — pure(ish) checks a PDF against a `PreflightConfig`: page
 * size/orientation/count (object-based, via `pdf/reader`) plus optional
 * object- and raster-based margin/collision checks.
 */
export { runPreflight, type PreflightContext } from './checks.js';
export {
  checkMarginsByRaster,
  checkStampCollision,
  type ImageDataLike,
  type MarginsPt,
  type RasterCheckOptions,
  type StampCollisionOptions,
  type StampCollisionResult,
} from './raster.js';
export { reportFileName, summarizeReport } from './report.js';
