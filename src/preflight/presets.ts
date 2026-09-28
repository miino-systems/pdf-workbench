/**
 * Built-in preflight "ひな形" (templates): a handful of commonly-requested
 * conference/journal page-margin starting points, selectable in the
 * Preflight tab (`ひな形を適用`) instead of typing every field by hand.
 *
 * These are *starting points*, not guarantees: publishers routinely tweak
 * margins between years, and this app has no way to verify a given preset
 * still matches the current call for papers. Each preset that is not simply
 * "generic A4/Letter with round-number margins" carries a `note` that is
 * shown in the UI and says so; the organiser's own Author Guidelines / テン
 * プレート are always authoritative over the numbers here.
 */
import type { PreflightConfig, PreflightMarginOverride } from '@/core/types';

export interface PreflightPreset {
  /** Stable id, stored into `PreflightConfig.preset` once applied. */
  id: string;
  /** Shown in the `<select>`. */
  label: string;
  /**
   * One-line caveat shown under the select when this preset is chosen.
   * Present on every preset that models a real conference/journal's rules
   * (as opposed to a generic round-number preset), since those numbers can
   * change between years/venues.
   */
  note?: string;
  /** Fields applied onto the draft config; see `applyPreflightPreset`. */
  config: Pick<PreflightConfig, 'page' | 'margins' | 'marginOverrides' | 'pages'>;
}

/**
 * Small, deliberately short list of built-in presets. Add new ones here
 * rather than growing bespoke UI — the Preflight tab renders this list as
 * data (`preflight.ts`'s preset `<select>`).
 */
export const PREFLIGHT_PRESETS: readonly PreflightPreset[] = [
  {
    id: 'generic-a4-25mm',
    label: '汎用 A4 (余白 25mm)',
    config: {
      page: { size: 'A4', orientation: 'portrait', tolerance: 2 },
      margins: { top: 25, bottom: 25, left: 25, right: 25, unit: 'mm' },
    },
  },
  {
    id: 'ieice-ronbunshi',
    label: 'IEICE 論文誌 (A4)',
    note: 'IEICE 論文誌テンプレートの目安値です。最新の執筆案内・LaTeX/Word テンプレートで必ず確認してください。',
    config: {
      page: { size: 'A4', orientation: 'portrait', tolerance: 2 },
      margins: { top: 30, bottom: 25, left: 20, right: 20, unit: 'mm' },
    },
  },
  {
    id: 'ieee-conference-letter',
    label: 'IEEE conference (US Letter)',
    note: 'IEEE の一般的な会議テンプレート値（0.75in 全辺、1 ページ目上部 1in）の目安です。学会ごとの Author Kit を優先してください。',
    config: {
      page: { size: 'Letter', orientation: 'portrait', tolerance: 2 },
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75, unit: 'in' },
      // Per-page override example: IEEE's US Letter conference template
      // reserves an extra inch at the top of the first page for the title
      // block, on top of the normal 0.75in margin used everywhere else.
      marginOverrides: [{ pages: { kind: 'first' }, margins: { top: 1 } } satisfies PreflightMarginOverride],
    },
  },
];

/**
 * Apply a preset onto `current`: replaces `page`/`margins`/`marginOverrides`
 * and enables all three checks (this is what a user picking a template
 * wants: a config that actually checks something), while keeping `id`/`name`/
 * `version`/`pages` (min/max page count) as-is. Records `preset.id` on the
 * result so the UI can show which template a config was last applied from.
 */
export function applyPreflightPreset(preset: PreflightPreset, current: PreflightConfig): PreflightConfig {
  return {
    ...current,
    preset: preset.id,
    page: { ...preset.config.page },
    margins: preset.config.margins ? { ...preset.config.margins } : undefined,
    marginOverrides: preset.config.marginOverrides ? preset.config.marginOverrides.map((o) => ({ ...o })) : undefined,
    checks: { marginText: true, marginRaster: true, stampCollision: true },
  };
}
