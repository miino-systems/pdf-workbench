/**
 * App shell: header (privacy notice, tabs, theme), section mounting, toasts.
 * Each section lives in `src/ui/sections/<id>.ts` and implements `Section`.
 */
import type { AppController, AppState } from '@/state/app';
import type { TabId } from '@/state/prefs';
import { button, h, iconButton, replaceChildren } from './dom';
import { icon, type IconName } from './icons';

export interface Section {
  id: TabId;
  title: string;
  /** Fill the viewport height (the section scrolls its own columns instead of the page). */
  fill?: boolean;
  /** Mount into `root`; return an update callback invoked on every state change. */
  mount(root: HTMLElement, ctrl: AppController): (state: AppState, prev: AppState) => void;
}

export const PRIVACY_NOTICE = 'PDF・画像・フォントはブラウザ内で処理され，外部サーバへ送信されません．';

export function mountApp(rootEl: HTMLElement, ctrl: AppController, sections: Section[]): void {
  const tabs = h('nav', { class: 'tabs', attrs: { role: 'tablist' } });
  const main = h('main', { class: 'app-main' });
  const toasts = h('div', { class: 'toasts' });
  const busy = h('span', { class: 'muted busy-indicator' });
  const wsLabel = h('span', { class: 'muted' });
  const undoBtn = iconButton('undo', '元に戻す', () => void ctrl.undo());
  const redoBtn = iconButton('redo', 'やり直す', () => void ctrl.redo());
  const reloadBtn = button('更新', () => void ctrl.reloadWorkspace(), 'btn btn-sm', 'refresh-cw');

  const header = h(
    'header',
    { class: 'app-header' },
    h('h1', null, 'PDF Workbench'),
    wsLabel,
    tabs,
    h('span', { class: 'spacer' }),
    busy,
    h('span', { class: 'row header-actions' }, undoBtn, redoBtn, reloadBtn),
    h('span', { class: 'privacy-notice', title: PRIVACY_NOTICE }, icon('lock'), PRIVACY_NOTICE),
  );

  const footer = h(
    'footer',
    { class: 'app-footer' },
    'Local-first PDF Workbench · 設定と履歴の正本は Workspace 内の ',
    h('code', null, '.pdf-workbench/'),
    ' · Git remote 操作は行いません（コマンド生成のみ）',
  );

  replaceChildren(rootEl, h('div', { class: 'app' }, header, main, footer, toasts));

  const updaters = new Map<TabId, (s: AppState, p: AppState) => void>();
  const panels = new Map<TabId, HTMLElement>();

  for (const section of sections) {
    const panel = h('section', { class: section.fill ? 'section section-fill' : 'section', attrs: { role: 'tabpanel' }, id: `section-${section.id}` });
    panel.hidden = true;
    main.appendChild(panel);
    panels.set(section.id, panel);
    updaters.set(section.id, section.mount(panel, ctrl));

    const btn = h(
      'button',
      {
        type: 'button',
        attrs: { role: 'tab', 'data-tab': section.id },
        on: { click: () => ctrl.setPrefs({ lastTab: section.id }) },
      },
      section.title,
    );
    tabs.appendChild(btn);
  }

  function applyTheme(state: AppState): void {
    document.documentElement.dataset.theme = state.prefs.theme;
  }

  function showTab(id: TabId): void {
    for (const [tid, panel] of panels) panel.hidden = tid !== id;
    for (const b of tabs.querySelectorAll<HTMLButtonElement>('button[data-tab]')) {
      b.setAttribute('aria-selected', String(b.dataset.tab === id));
    }
  }

  function renderToasts(state: AppState): void {
    replaceChildren(
      toasts,
      state.toasts.map((t) =>
        h(
          'div',
          { class: `toast ${t.kind}`, on: { click: () => ctrl.dismissToast(t.id) }, attrs: { role: 'status' } },
          icon(TOAST_ICON[t.kind]),
          h('span', null, t.text),
        ),
      ),
    );
  }

  function renderActions(state: AppState): void {
    const mod = isMac() ? '⌘' : 'Ctrl+';
    const noWs = !state.workspace || !!state.busy;
    undoBtn.disabled = noWs || !state.undo.undo;
    redoBtn.disabled = noWs || !state.undo.redo;
    undoBtn.title = state.undo.undo ? `元に戻す: ${state.undo.undo} (${mod}Z)` : `元に戻す (${mod}Z)`;
    redoBtn.title = state.undo.redo ? `やり直す: ${state.undo.redo} (${mod}⇧Z)` : `やり直す (${mod}⇧Z)`;
    reloadBtn.disabled = !!state.busy;
    reloadBtn.title = state.workspace
      ? `Workspace をディスクから再読み込み (${mod}R)`
      : `最近使った Workspace を開く (${mod}R)`;
  }

  function render(state: AppState, prev: AppState): void {
    applyTheme(state);
    showTab(state.prefs.lastTab);
    const p = state.progress;
    const busyText = p
      ? `${p.label} ${p.done}/${p.total}（${Math.floor((p.done / Math.max(1, p.total)) * 100)}%）`
      : state.busy
        ? `${state.busy}…`
        : '';
    replaceChildren(busy, busyText ? [icon('loader', { className: 'icon-spin' }), busyText] : []);
    wsLabel.textContent = state.workspace ? `Workspace: ${state.workspace.config.name}/` : '';
    renderActions(state);
    renderToasts(state);
    for (const u of updaters.values()) u(state, prev);
  }

  ctrl.store.subscribe(render);
  render(ctrl.state, ctrl.state);
  document.addEventListener('keydown', (ev) => handleShortcut(ev, ctrl));

  // Pick up .pdf-workbench/*.json edited in another program (an editor, a
  // script, git checkout) before the stale in-memory copy can be saved over
  // it: when the window regains focus, and every few seconds while visible.
  const checkExternal = (): void => {
    if (document.visibilityState === 'visible' && !ctrl.state.busy) void ctrl.checkExternalChanges();
  };
  window.addEventListener('focus', checkExternal);
  document.addEventListener('visibilitychange', checkExternal);
  setInterval(checkExternal, EXTERNAL_CHECK_INTERVAL_MS);
}

const EXTERNAL_CHECK_INTERVAL_MS = 4000;

const TOAST_ICON: Record<AppState['toasts'][number]['kind'], IconName> = {
  ok: 'circle-check',
  info: 'info',
  warn: 'triangle-alert',
  err: 'circle-x',
};

function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
}

/** Text fields keep the browser's own Cmd+Z (undoing typed characters), not the app-level undo. */
function isTextEditing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target instanceof HTMLTextAreaElement) return true;
  if (!(target instanceof HTMLInputElement)) return false;
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'color', 'file', 'range'].includes(target.type);
}

/**
 * Global shortcuts:
 *  - Cmd/Ctrl+Z → undo, Cmd/Ctrl+Shift+Z or Ctrl+Y → redo (config edits)
 *  - Cmd/Ctrl+R → reload the workspace from disk instead of the page
 *    (Cmd/Ctrl+Shift+R still reloads the page itself)
 */
export function handleShortcut(ev: KeyboardEvent, ctrl: AppController): void {
  const mod = isMac() ? ev.metaKey : ev.ctrlKey;
  if (!mod || ev.altKey) return;
  const key = ev.key.toLowerCase();
  if (key === 'r' && !ev.shiftKey) {
    ev.preventDefault();
    if (!ctrl.state.busy) void ctrl.reloadWorkspace();
    return;
  }
  const redo = (key === 'z' && ev.shiftKey) || (key === 'y' && !ev.shiftKey && !isMac());
  const undo = key === 'z' && !ev.shiftKey;
  if (!undo && !redo) return;
  if (isTextEditing(ev.target) || !ctrl.state.workspace) return;
  ev.preventDefault();
  if (ctrl.state.busy) return;
  void (undo ? ctrl.undo() : ctrl.redo());
}
