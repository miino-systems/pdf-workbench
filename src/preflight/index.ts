/**
 * `preflight/` — pure(ish) checks a PDF against a `PreflightConfig`: page
 * size/orientation/count (object-based, via `pdf/reader`) plus optional
 * object- and raster-based margin/collision checks, and whether a stamp's
 * content is already in the paper.
 */
export {
  runPreflight,
  marginFindingsForItems,
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
  countInkInRect,
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
export { findTextOverlaps } from './overlap.js';
export {
  REPORT_TEXT_MAX,
  isLegacyReportName,
  listReportNames,
  removeReportFiles,
  reportFileName,
  reportPath,
  reportProblemCounts,
  saveReportFile,
  serializeReport,
  summarizeReport,
  type ReportFS,
} from './report.js';
export {
  DEFAULT_ANNOTATION_MESSAGES,
  PHANTOM_MESSAGE_KEY,
  annotatePreflightPdf,
  annotationMessage,
  describePreflightCode,
} from './annotate.js';
