/**
 * UI preferences. This is the ONLY thing stored in localStorage (spec §5):
 * theme, last tab, panel open/closed state, default DPI, display unit.
 * Workspace configuration never lives here.
 */
export type Theme = 'system' | 'light' | 'dark';
export type TabId = 'workspace' | 'pdf' | 'stamps' | 'sequence' | 'preflight' | 'history' | 'settings';
export type DisplayUnit = 'mm' | 'pt';

export interface UiPrefs {
  theme: Theme;
  lastTab: TabId;
  panels: Record<string, boolean>;
  defaultDpi: number;
  unit: DisplayUnit;
  previewZoom: number;
}

const KEY = 'pdf-workbench.prefs.v1';

export const DEFAULT_PREFS: UiPrefs = {
  theme: 'system',
  lastTab: 'workspace',
  panels: {},
  defaultDpi: 300,
  unit: 'mm',
  previewZoom: 1,
};

function storage(): Storage | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    return undefined;
  }
}

export function loadPrefs(): UiPrefs {
  const s = storage();
  if (!s) return { ...DEFAULT_PREFS };
  try {
    const raw = s.getItem(KEY);
    if (!raw) return { ...DEFAULT_PREFS };
    const parsed = JSON.parse(raw) as Partial<UiPrefs>;
    return { ...DEFAULT_PREFS, ...parsed, panels: { ...parsed.panels } };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export function savePrefs(prefs: UiPrefs): void {
  const s = storage();
  if (!s) return;
  try {
    s.setItem(KEY, JSON.stringify(prefs));
  } catch {
    /* quota / private mode: preferences are non-essential */
  }
}
