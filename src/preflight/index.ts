/**
 * `preflight/` — pure(ish) checks a PDF against a `PreflightConfig`: page
 * size/orientation/count (object-based, via `pdf/reader`) plus optional
 * object- and raster-based margin/collision checks, and whether a stamp's
 * content is already in the paper.
 */
export {
  runPreflight,
  marginsForPage,
  marginTolerancesPt,
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
export {
  findStampDuplicates,
  findTextDuplicates,
  imageSignature,
  normalizeForMatch,
  sameImage,
  type DuplicateProbe,
  type ImageSignature,
} from './duplicate.js';
export {
  TEXT_FORBIDDEN,
  TEXT_REQUIRED,
  TEXT_RULE_INVALID,
  compileTextRules,
  findForbiddenText,
  pageMatchesRequired,
  pageTextForRules,
  parseTextRuleCode,
  textRuleCode,
  type CompiledTextRule,
} from './textRules.js';
export { reportFileName, summarizeReport } from './report.js';
export { annotatePreflightPdf, describePreflightCode } from './annotate.js';
