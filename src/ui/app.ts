/**
 * App shell: header (privacy notice, tabs, theme), section mounting, toasts.
 * Each section lives in `src/ui/sections/<id>.ts` and implements `Section`.
 */
import type { AppController, AppState } from '@/state/app';
import type { TabId } from '@/state/prefs';
import { h, replaceChildren } from './dom';

export interface Section {
  id: TabId;
  title: string;
  /** Mount into `root`; return an update callback invoked on every state change. */
  mount(root: HTMLElement, ctrl: AppController): (state: AppState, prev: AppState) => void;
}

export const PRIVACY_NOTICE = 'PDF・画像・フォントはブラウザ内で処理され，外部サーバへ送信されません．';

export function mountApp(rootEl: HTMLElement, ctrl: AppController, sections: Section[]): void {
  const tabs = h('nav', { class: 'tabs', attrs: { role: 'tablist' } });
  const main = h('main', { class: 'app-main' });
  const toasts = h('div', { class: 'toasts' });
  const busy = h('span', { class: 'muted' });
  const wsLabel = h('span', { class: 'muted' });

  const header = h(
    'header',
    { class: 'app-header' },
    h('h1', null, 'PDF Workbench'),
    wsLabel,
    tabs,
    h('span', { class: 'spacer' }),
    busy,
    h('span', { class: 'privacy-notice', title: PRIVACY_NOTICE }, '🔒 ', PRIVACY_NOTICE),
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
    const panel = h('section', { class: 'section', attrs: { role: 'tabpanel' }, id: `section-${section.id}` });
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
          t.text,
        ),
      ),
    );
  }

  function render(state: AppState, prev: AppState): void {
    applyTheme(state);
    showTab(state.prefs.lastTab);
    busy.textContent = state.busy ? `⏳ ${state.busy}…` : '';
    wsLabel.textContent = state.workspace ? `Workspace: ${state.workspace.config.name}/` : '';
    renderToasts(state);
    for (const u of updaters.values()) u(state, prev);
  }

  ctrl.store.subscribe(render);
  render(ctrl.state, ctrl.state);
}
