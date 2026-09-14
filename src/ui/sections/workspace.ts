/**
 * Workspace tab: pick / reopen / initialise a workspace, show its layout,
 * and the Git helper (command generation + copy; no remote operations).
 */
import type { AppState } from '@/state/app';
import { DEFAULT_GITIGNORE, explainGitignore, gitInitCommands, gitUpdateCommands } from '@/git-helper';
import { WORKBENCH_DIR } from '@/core/types';
import { isLocalFontAccessSupported } from '@/workspace';
import type { Section } from '../app';
import { button, copyToClipboard, h, replaceChildren } from '../dom';

export const workspaceSection: Section = {
  id: 'workspace',
  title: 'Workspace',
  mount(root, ctrl) {
    const openPanel = h('div', { class: 'panel' });
    const infoPanel = h('div', { class: 'panel' });
    const gitPanel = h('div', { class: 'panel' });
    root.append(h('div', { class: 'grid grid-2' }, h('div', null, openPanel, infoPanel), gitPanel));

    void ctrl.refreshRecent();

    function renderOpen(state: AppState): void {
      const children: (HTMLElement | string)[] = [h('h2', null, 'Workspace を開く')];
      if (!state.fsSupported) {
        children.push(
          h(
            'div',
            { class: 'alert warn' },
            'このブラウザではローカルディレクトリ機能が利用できません．',
            h('br'),
            'File System Access API に対応した Desktop 版 Chrome / Edge をご利用ください．',
          ),
        );
      } else {
        children.push(
          h(
            'p',
            { class: 'muted' },
            'ローカルディレクトリを選択すると，そのディレクトリを Workspace として読み書きします．',
            '設定・履歴は Workspace 内の ',
            h('code', null, `${WORKBENCH_DIR}/`),
            ' に保存され，PDF はブラウザの外へ送信されません．',
          ),
          h(
            'div',
            { class: 'row' },
            button('📂 ディレクトリを選択', () => void ctrl.pickAndOpenWorkspace(), 'btn btn-primary'),
            state.workspace ? button('閉じる', () => ctrl.closeWorkspace()) : '',
          ),
        );
      }
      if (state.pendingInit) {
        children.push(
          h(
            'div',
            { class: 'alert' },
            h('strong', null, `「${state.pendingInit.handle.name}」`),
            ' には ',
            h('code', null, `${WORKBENCH_DIR}/`),
            ' がありません．新しい Workspace として初期化しますか？',
            h(
              'div',
              { class: 'row', style: 'margin-top:8px' },
              button('✨ 新しい Workspace として初期化', () => void ctrl.initializePendingWorkspace(), 'btn btn-primary'),
              button('キャンセル', () => ctrl.closeWorkspace()),
            ),
            h(
              'p',
              { class: 'muted', style: 'margin:8px 0 0' },
              '作成されるもの: papers/ output/ preview/ assets/ fonts/ ',
              h('code', null, `${WORKBENCH_DIR}/`),
              '{workspace,stamps,preflight,jobs}.json, history/events.jsonl, .gitignore',
            ),
          ),
        );
      }
      if (state.recent.length) {
        children.push(
          h('h3', null, '最近使った Workspace'),
          h(
            'ul',
            { class: 'list' },
            state.recent.map((r) =>
              h(
                'li',
                { on: { click: () => void ctrl.openRecent(r) } },
                h('span', { class: 'name' }, '📁 ', r.name),
                h('span', { class: 'muted' }, new Date(r.lastOpened).toLocaleString()),
                h(
                  'button',
                  {
                    class: 'btn btn-sm',
                    type: 'button',
                    title: '一覧から削除',
                    on: {
                      click: (ev) => {
                        ev.stopPropagation();
                        void ctrl.forgetRecent(r.name);
                      },
                    },
                  },
                  '✕',
                ),
              ),
            ),
          ),
          h('p', { class: 'muted' }, '再オープン時にはディレクトリへのアクセス許可を再度求められることがあります．'),
        );
      }
      replaceChildren(openPanel, ...children);
    }

    function renderInfo(state: AppState): void {
      const ws = state.workspace;
      if (!ws) {
        replaceChildren(
          infoPanel,
          h('h2', null, 'Workspace 構成'),
          h(
            'pre',
            null,
            `workspace/
├─ papers/     元 PDF（immutable）
├─ output/     生成 PDF
├─ preview/    PNG / JPEG
├─ assets/     スタンプ画像
├─ fonts/      .ttf / .otf
├─ ${WORKBENCH_DIR}/
│   ├─ workspace.json  stamps.json  preflight.json  jobs.json
│   ├─ reports/
│   └─ history/  events.jsonl  snapshots/
└─ .gitignore`,
          ),
        );
        return;
      }
      const d = ws.config.directories;
      replaceChildren(
        infoPanel,
        h('h2', null, `Workspace: ${ws.config.name}/`),
        h(
          'table',
          null,
          h('tbody', null, [
            ['元 PDF', `${d.papers}/`],
            ['出力', `${d.output}/  (suffix: ${ws.config.output.suffix})`],
            ['preview', `${d.preview}/`],
            ['画像', `${d.assets}/`],
            ['フォント', `${d.fonts}/`],
            ['設定・履歴', `${WORKBENCH_DIR}/`],
            ['作成日時', ws.config.createdAt],
            ['hash chain', ws.config.history.hashChain ? '有効' : '無効'],
            ['Local Font Access API', isLocalFontAccessSupported() ? '利用可能' : '非対応（Workspace フォント / ファイル選択を使用）'],
          ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, v))))),
        ),
        h('p', { class: 'muted' }, `PDF ファイル: ${state.files.length} 件 / ジョブ: ${ws.jobs.jobs.length} 件`),
      );
    }

    function commandBlock(title: string, cmds: string[]): HTMLElement {
      const text = cmds.join('\n');
      const status = h('span', { class: 'muted' });
      return h(
        'div',
        null,
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('strong', null, title),
          h(
            'span',
            { class: 'row' },
            status,
            button('コピー', () => {
              void copyToClipboard(text).then((ok) => {
                status.textContent = ok ? 'コピーしました' : 'コピーに失敗しました';
                setTimeout(() => (status.textContent = ''), 2000);
              });
            }, 'btn btn-sm'),
          ),
        ),
        h('pre', null, text),
      );
    }

    function renderGit(): void {
      replaceChildren(
        gitPanel,
        h('h2', null, 'Git（optional）'),
        h(
          'p',
          { class: 'muted' },
          'Git は任意です．アプリはコマンドを生成するだけで，git の実行・remote 操作・認証は一切行いません．',
          '以下をコピーして，Workspace ディレクトリでご自身のターミナルから実行してください．',
        ),
        commandBlock('初期化', gitInitCommands()),
        commandBlock('更新', gitUpdateCommands()),
        h('h3', null, '.gitignore'),
        h('p', { class: 'muted' }, explainGitignore()),
        h('pre', null, DEFAULT_GITIGNORE.trim()),
        h(
          'p',
          { class: 'muted' },
          'Git 管理対象として想定するのは ',
          h('code', null, `${WORKBENCH_DIR}/**`),
          ' と ',
          h('code', null, '.gitignore'),
          ' のみです．PDF・画像・生成物は Git に含めないことを推奨します．',
        ),
      );
    }

    renderGit();
    return (state) => {
      renderOpen(state);
      renderInfo(state);
    };
  },
};
