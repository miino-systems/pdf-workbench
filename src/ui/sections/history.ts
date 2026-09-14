/**
 * History tab: the append-only `events.jsonl` log plus config snapshots.
 * Both are workspace state (`docs/ARCHITECTURE.md` principle F) — entirely
 * independent of Git, which the app never touches directly.
 */
import type { AppState } from '@/state/app';
import type { Section } from '../app';
import { button, h, replaceChildren } from '../dom';

/** Everything in a `HistoryEvent` except `ts`/`type`, for the compact-JSON column. */
function eventPayload(ev: Record<string, unknown>): Record<string, unknown> {
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ev)) {
    if (k !== 'ts' && k !== 'type') rest[k] = v;
  }
  return rest;
}

export const historySection: Section = {
  id: 'history',
  title: 'History',
  mount(root, ctrl) {
    const eventsPanel = h('div', { class: 'panel' });
    const snapshotsPanel = h('div', { class: 'panel' });
    root.append(h('div', { class: 'grid grid-2' }, eventsPanel, snapshotsPanel));

    let snapshotNames: string[] = [];
    let viewerName: string | undefined;
    let viewerJson: string | undefined;
    let verifyResult: { ok: boolean; brokenAt?: number } | undefined;
    let lastWorkspaceForSnapshots: AppState['workspace'];
    const viewerBox = h('div', { class: 'snapshot-view' });

    async function refreshSnapshots(): Promise<void> {
      snapshotNames = (await ctrl.snapshots?.list().catch(() => [] as string[])) ?? [];
      renderSnapshots(ctrl.state);
    }

    function renderViewer(): void {
      if (!viewerName || viewerJson === undefined) {
        replaceChildren(viewerBox);
        return;
      }
      replaceChildren(viewerBox, h('h3', null, viewerName), h('pre', null, viewerJson));
    }

    function renderSnapshots(state: AppState): void {
      const ws = state.workspace;
      const children: (HTMLElement | string)[] = [h('h2', null, 'Snapshots')];
      if (!ws) {
        children.push(h('p', { class: 'muted' }, 'Workspace が開かれていません．'));
      } else if (snapshotNames.length === 0) {
        children.push(h('p', { class: 'muted' }, 'Snapshot がありません．「Snapshot を保存」で作成できます．'));
      } else {
        children.push(
          h(
            'ul',
            { class: 'list static' },
            snapshotNames
              .slice()
              .reverse()
              .map((name) =>
                h(
                  'li',
                  null,
                  h('span', { class: 'name mono' }, name),
                  button(
                    '表示',
                    () => {
                      void ctrl.snapshots?.load(name).then((snap) => {
                        viewerName = name;
                        viewerJson = JSON.stringify(snap, null, 2);
                        renderViewer();
                      });
                    },
                    'btn btn-sm',
                  ),
                ),
              ),
          ),
        );
      }
      children.push(
        h(
          'p',
          { class: 'muted settings-note' },
          'Snapshot は内容の表示のみに対応しています．ワークスペースへの復元（restore）は Phase 3 で実装予定です．',
        ),
      );
      children.push(viewerBox);
      replaceChildren(snapshotsPanel, ...children);
    }

    function renderEvents(state: AppState): void {
      const ws = state.workspace;
      const header = h(
        'div',
        { class: 'row', style: 'justify-content:space-between' },
        h('h2', null, 'History'),
        h(
          'div',
          { class: 'row' },
          button('🔄 再読み込み', () => void ctrl.refreshEvents(), 'btn btn-sm'),
          button(
            '📸 Snapshot を保存',
            () => {
              const reason = window.prompt('保存理由', '手動保存');
              if (reason === null) return;
              void ctrl.saveSnapshot(reason).then((path) => {
                if (path) {
                  ctrl.toast('ok', `${path} に保存しました`);
                  void refreshSnapshots();
                }
              });
            },
            'btn btn-sm',
          ),
        ),
      );

      const children: (HTMLElement | string)[] = [
        header,
        h(
          'p',
          { class: 'muted' },
          'events.jsonl は追記専用（append-only）のログです．Git の履歴とは独立して，Workspace 内に直接記録されます．',
        ),
      ];

      if (ws) {
        children.push(
          h(
            'div',
            { class: 'row' },
            h('span', { class: 'muted' }, `hash chain: ${ws.config.history.hashChain ? '有効' : '無効'}`),
            ws.config.history.hashChain
              ? button(
                  '検証',
                  () => {
                    void ctrl.journal?.verifyChain().then((r) => {
                      verifyResult = r;
                      renderEvents(ctrl.state);
                    });
                  },
                  'btn btn-sm',
                )
              : '',
          ),
        );
        if (verifyResult) {
          children.push(
            h(
              'div',
              { class: `alert ${verifyResult.ok ? 'ok' : 'err'}` },
              verifyResult.ok
                ? '✓ hash chain は正しく検証されました'
                : `✗ hash chain が壊れています（index ${verifyResult.brokenAt}）`,
            ),
          );
        }
      }

      const events = state.events.slice(-200).reverse();
      if (events.length === 0) {
        children.push(h('p', { class: 'muted' }, 'イベントがありません．'));
      } else {
        children.push(
          h(
            'div',
            { class: 'events' },
            h(
              'table',
              null,
              h(
                'tbody',
                null,
                events.map((ev) =>
                  h(
                    'tr',
                    null,
                    h('td', null, h('span', { class: 'mono muted' }, ev.ts)),
                    h('td', null, h('code', null, ev.type)),
                    h('td', null, h('code', null, JSON.stringify(eventPayload(ev)))),
                  ),
                ),
              ),
            ),
          ),
        );
      }
      replaceChildren(eventsPanel, ...children);
    }

    return (state) => {
      if (state.workspace !== lastWorkspaceForSnapshots) {
        lastWorkspaceForSnapshots = state.workspace;
        snapshotNames = [];
        viewerName = undefined;
        viewerJson = undefined;
        verifyResult = undefined;
        if (state.workspace) void refreshSnapshots();
      }
      renderEvents(state);
      renderSnapshots(state);
    };
  },
};
