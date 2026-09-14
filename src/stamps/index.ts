/**
 * Public API of the `stamps/` module (see docs/ARCHITECTURE.md §3).
 * The UI and `pdf/stamper` depend only on what is exported here.
 */
export { resolvePages, describePageSelector, parsePageList } from './pages';
export {
  resolveStampOrigin,
  effectivePosition,
  stampRect,
  DEFAULT_STAMP_POSITION,
} from './position';
export { renderPageNumber, type PageNumberContext } from './template';
export { createId, createInstanceFromDefinition, BUILTIN_STAMP_TEMPLATES } from './templates';
export { validateStampsConfig } from './validate';
export { parseHexColor, isValidHexColor, type RgbColor, FALLBACK_COLOR } from './color';
