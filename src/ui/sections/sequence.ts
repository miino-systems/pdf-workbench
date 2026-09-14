/**
 * Sequence tab: continuous page numbering across `papers/*.pdf`.
 *  - order (natural name order, or a manual list), first page number and
 *    odd/even alignment, per-file start pins and exclusions
 *  - the resulting `page_start–page_end` per file
 *  - export of that table to `output/page-ranges.csv` / `.json`
 *
 * All edits go through `AppController.updateSequence` (persisted to
 * `.pdf-workbench/sequence.json` + `events.jsonl`); the ordering logic
 * itself is the pure `sequence/` module.
 */
import type { SequenceConfig, SequenceOrder, SequenceStartOn } from '@/core/types';
import {
  describeRange,
  formatPageRangesTable,
  materializeOrder,
  moveFile,
  removeEntry,
  removeMissingEntries,
  setFileOverrides,
  useNameOrder,
  type ResolvedSequence,
} from '@/sequence';
import type { AppState } from '@/state/app';
import { currentPageRangeRows, exportPageRanges } from '@/state/pageRanges';
import { importSequenceFile } from '@/state/sequenceImport';
import { basename } from '@/workspace';
import type { Section } from '../app';
import { button, copyToClipboard, h, replaceChildren } from '../dom';

const ORDER_LABEL: Record<SequenceOrder, string> = {
  name: 'ファイル名順（自然順: paper2 < paper10）',
  manual: '手動（下の一覧の順）',
};

const START_ON_LABEL: Record<SequenceStartOn, string> = {
  any: '制限なし（前のファイルの直後から）',
  odd: '奇数ページ（右ページ）から開始',
  even: '偶数ページ（左ページ）から開始',
};

export const sequenceSection: Section = {
  id: 'sequence',
  title: 'Sequence',
  mount(root, ctrl) {
    // ------------------------------------------------------------ settings
    const orderSelect = h(
      'select',
      { on: { change: () => void commit((cfg) => ({ ...cfg, order: orderSelect.value as SequenceOrder })) } },
      (Object.keys(ORDER_LABEL) as SequenceOrder[]).map((k) => h('option', { value: k }, ORDER_LABEL[k])),
    );
    const firstPageInput = h('input', {
      type: 'number',
      min: '1',
      step: '1',
      class: 'mono',
      on: {
        change: () => {
          const n = parseInt(firstPageInput.value, 10);
          if (!Number.isFinite(n) || n < 1) return;
          void commit((cfg) => ({ ...cfg, firstPage: n }));
        },
      },
    });
    const startOnSelect = h(
      'select',
      { on: { change: () => void commit((cfg) => ({ ...cfg, startOn: startOnSelect.value as SequenceStartOn })) } },
      (Object.keys(START_ON_LABEL) as SequenceStartOn[]).map((k) => h('option', { value: k }, START_ON_LABEL[k])),
    );
    const settingsPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, '通しページ番号'),
      h(
        'p',
        { class: 'muted settings-note' },
        'papers/ の PDF を並べた順に通し番号を割り当てます．pageNumber スタンプの {page} はこの番号になります（除外したファイルはスタンプ側の startAt を使用）．',
      ),
      h('div', { class: 'field' }, h('span', null, '並び順'), orderSelect),
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'field' }, h('span', null, '最初のページ番号'), firstPageInput),
        h('div', { class: 'field', style: 'flex:1;min-width:220px' }, h('span', null, '各ファイルの開始ページ'), startOnSelect),
      ),
    );

    // -------------------------------------------------------------- import
    const fileInput = h('input', {
      type: 'file',
      accept: '.txt,.json,.csv,text/plain,application/json',
      style: 'display:none',
      on: {
        change: () => {
          const f = fileInput.files?.[0];
          fileInput.value = '';
          if (f) void runImport(f);
        },
      },
    });
    const dropZone = h(
      'div',
      {
        class: 'drop-zone',
        attrs: { role: 'button', tabindex: '0' },
        title: 'ファイル順の一覧（.txt: 1 行 1 ファイル / .json: sequence.json）をここにドロップ',
        on: {
          dragover: (ev) => {
            ev.preventDefault();
            if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
            dropZone.classList.add('active');
          },
          dragleave: () => dropZone.classList.remove('active'),
          drop: (ev) => {
            ev.preventDefault();
            dropZone.classList.remove('active');
            const f = ev.dataTransfer?.files?.[0];
            if (f) void runImport(f);
          },
          click: () => fileInput.click(),
          keydown: (ev) => {
            if (ev.key === 'Enter' || ev.key === ' ') {
              ev.preventDefault();
              fileInput.click();
            }
          },
        },
      },
      h('strong', null, '一覧ファイルをここにドロップ'),
      h('span', { class: 'muted' }, '（クリックで選択）'),
      h(
        'span',
        { class: 'muted settings-note' },
        '.txt: 1 行 1 ファイル名（末尾に 数字 = 開始番号固定，skip = 除外，# はコメント）／ .json: sequence.json 形式．' +
          '読み込んだ内容で sequence.json を上書きします（手動順）．',
      ),
      fileInput,
    );
    const importPanel = h('div', { class: 'panel' }, h('h2', null, 'ファイル順の読み込み'), dropZone);

    async function runImport(file: File): Promise<void> {
      if (!ctrl.state.workspace) {
        ctrl.toast('warn', 'Workspace を開いてから読み込んでください');
        return;
      }
      const res = await ctrl.run(`${file.name} を読み込み`, () => importSequenceFile(ctrl, file));
      if (!res) return;
      ctrl.toast('ok', `${res.source} から ${res.config.entries.length} 件の順序を読み込みました`);
      for (const w of res.warnings) ctrl.toast('warn', w, 10000);
    }

    // ---------------------------------------------------------------- list
    const listPanel = h('div', { class: 'panel' });

    // -------------------------------------------------------------- export
    const exportPreview = h('pre', { class: 'muted', style: 'max-height:320px;overflow:auto' });
    const exportBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        type: 'button',
        on: {
          click: () => {
            void ctrl.run('ページ範囲を書き出し', () => exportPageRanges(ctrl)).then((res) => {
              if (res) ctrl.toast('ok', `${res.csv} と ${res.json} を書き出しました（${res.rows.length} 件）`);
            });
          },
        },
      },
      'CSV / JSON を output/ に書き出す',
    );
    const copyBtn = button(
      'TSV をコピー',
      () => {
        void copyToClipboard(formatPageRangesTable(currentPageRangeRows(ctrl), '\t')).then((ok) => {
          ctrl.toast(ok ? 'ok' : 'warn', ok ? 'クリップボードにコピーしました' : 'コピーできませんでした');
        });
      },
      'btn',
    );
    const exportPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'ページ範囲の一覧'),
      h('p', { class: 'muted settings-note' }, 'filename, page_start, page_end, page_count の表を output/page-ranges.csv と .json に書き出します．'),
      h('div', { class: 'row' }, exportBtn, copyBtn),
      exportPreview,
    );

    root.append(h('div', { class: 'grid grid-2' }, h('div', null, settingsPanel, importPanel, listPanel), exportPanel));

    // ------------------------------------------------------------ helpers
    async function commit(mutate: (cfg: SequenceConfig) => SequenceConfig, event?: Record<string, unknown>): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws) return;
      await ctrl.updateSequence(mutate(ws.sequence), event);
    }

    function filePaths(): string[] {
      return ctrl.state.files.map((f) => f.path);
    }

    function renderList(state: AppState): void {
      const ws = state.workspace;
      const seq = state.sequence;
      const children: (HTMLElement | string)[] = [
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('h2', null, '順序'),
          ws
            ? h(
                'div',
                { class: 'row' },
                button('現在の順序を固定（手動に切替）', () => void commit((cfg) => materializeOrder(cfg, filePaths()), { action: 'materialize' }), 'btn btn-sm'),
                button('ファイル名順に戻す', () => void commit((cfg) => useNameOrder(cfg), { action: 'name-order' }), 'btn btn-sm'),
              )
            : '',
        ),
      ];

      if (!ws) {
        children.push(h('div', { class: 'alert warn' }, 'Workspace が開かれていません．Workspace タブでディレクトリを開いてください．'));
        replaceChildren(listPanel, ...children);
        return;
      }
      if (!seq) {
        children.push(h('p', { class: 'muted' }, 'ページ数を読み込み中…'));
        replaceChildren(listPanel, ...children);
        return;
      }
      if (seq.items.length === 0) {
        children.push(h('p', { class: 'muted' }, `${ws.config.directories.papers}/ に PDF を置いてください．`));
        replaceChildren(listPanel, ...children);
        return;
      }

      for (const w of seq.warnings) children.push(h('div', { class: 'alert warn' }, w));
      if (seq.items.some((i) => i.missing)) {
        children.push(
          h(
            'div',
            { class: 'row' },
            button('見つからないエントリを削除', () => void commit((cfg) => removeMissingEntries(cfg, filePaths()), { action: 'remove-missing' }), 'btn btn-sm'),
          ),
        );
      }

      const manual = ws.sequence.order === 'manual';
      const rows = seq.items.map((item, idx) => {
        const entry = ws.sequence.entries.find((e) => e.file === item.file);
        const upBtn = button('▲', () => void commit((cfg) => moveFile(cfg, filePaths(), item.file, -1), { action: 'move', file: item.file, delta: -1 }), 'btn btn-sm');
        const downBtn = button('▼', () => void commit((cfg) => moveFile(cfg, filePaths(), item.file, 1), { action: 'move', file: item.file, delta: 1 }), 'btn btn-sm');
        upBtn.disabled = item.missing || idx === 0;
        downBtn.disabled = item.missing || idx === seq.items.length - 1;
        upBtn.title = manual ? '上へ' : '上へ（並び順が「手動」に切り替わります）';
        downBtn.title = manual ? '下へ' : '下へ（並び順が「手動」に切り替わります）';

        const pinInput = h('input', {
          type: 'number',
          min: '1',
          step: '1',
          class: 'mono',
          placeholder: '自動',
          value: entry?.startPage !== undefined ? String(entry.startPage) : '',
          disabled: item.missing || item.skipped,
          title: '開始ページ番号を固定（空欄 = 前のファイルの続き）',
          style: { width: '72px' },
          on: {
            change: () => {
              const raw = pinInput.value.trim();
              const n = raw === '' ? undefined : parseInt(raw, 10);
              void commit((cfg) => setFileOverrides(cfg, item.file, { startPage: n }), { action: 'pin', file: item.file, startPage: n });
            },
          },
        });
        const skipInput = h('input', {
          type: 'checkbox',
          checked: item.skipped,
          disabled: item.missing,
          on: { change: () => void commit((cfg) => setFileOverrides(cfg, item.file, { skip: skipInput.checked }), { action: 'skip', file: item.file, skip: skipInput.checked }) },
        });

        const status: (HTMLElement | string)[] = [];
        if (item.missing) {
          status.push(
            h('span', { class: 'badge err' }, 'ファイルなし'),
            ' ',
            button('削除', () => void commit((cfg) => removeEntry(cfg, item.file), { action: 'remove', file: item.file }), 'btn btn-sm'),
          );
        } else if (item.pageCount === undefined) {
          status.push(h('span', { class: 'badge err' }, '読めません'));
        } else if (item.pinned) {
          status.push(h('span', { class: 'badge' }, '固定'));
        }
        if (manual && !item.listed && !item.missing) status.push(' ', h('span', { class: 'badge warn', title: 'リスト未登録．末尾にファイル名順で追加されています' }, '未登録'));

        return h(
          'tr',
          null,
          h('td', { class: 'mono muted' }, String(idx + 1)),
          h('td', null, h('span', { class: 'row', style: 'gap:2px;flex-wrap:nowrap' }, upBtn, downBtn)),
          h('td', null, h('span', { class: item.missing ? 'muted' : '' }, basename(item.file))),
          h('td', { class: 'mono' }, item.pageCount === undefined ? '—' : String(item.pageCount)),
          h('td', null, pinInput),
          h('td', null, skipInput),
          h('td', { class: 'mono' }, describeRange(item)),
          h('td', null, ...status),
        );
      });

      children.push(
        h(
          'div',
          { style: 'overflow-x:auto' },
          h(
            'table',
            null,
            h('thead', null, h('tr', null, ['#', '', 'ファイル', 'ページ数', '開始番号', '除外', '通し番号', ''].map((t) => h('th', null, t)))),
            h('tbody', null, rows),
          ),
        ),
        h(
          'p',
          { class: 'muted' },
          seq.lastPage !== undefined
            ? `通し番号: ${ws.sequence.firstPage}–${seq.lastPage}（${seq.numberedPages} ページ / ${seq.items.filter((i) => !i.missing).length} ファイル）`
            : '番号を割り当てたファイルはありません',
        ),
      );
      replaceChildren(listPanel, ...children);
    }

    function renderExport(state: AppState): void {
      const enabled = !!state.workspace && !!state.sequence && state.sequence.items.some((i) => !i.missing) && !state.busy;
      exportBtn.disabled = !enabled;
      copyBtn.disabled = !enabled;
      exportPreview.textContent = state.sequence ? formatPageRangesTable(currentPageRangeRows(ctrl), ',') : '';
    }

    let lastSequenceCfg: SequenceConfig | undefined;
    let lastResolved: ResolvedSequence | undefined;
    let lastWorkspace: AppState['workspace'];
    let lastBusy: string | undefined;

    return (state: AppState) => {
      const ws = state.workspace;
      const disabled = !ws;
      dropZone.classList.toggle('disabled', disabled);
      orderSelect.disabled = disabled;
      firstPageInput.disabled = disabled;
      startOnSelect.disabled = disabled;

      if (ws && ws.sequence !== lastSequenceCfg) {
        if (document.activeElement !== orderSelect) orderSelect.value = ws.sequence.order;
        if (document.activeElement !== firstPageInput) firstPageInput.value = String(ws.sequence.firstPage);
        if (document.activeElement !== startOnSelect) startOnSelect.value = ws.sequence.startOn;
      }

      const changed = ws !== lastWorkspace || state.sequence !== lastResolved || (ws?.sequence ?? undefined) !== lastSequenceCfg;
      if (changed) {
        renderList(state);
        renderExport(state);
      } else if (state.busy !== lastBusy) {
        renderExport(state);
      }
      lastWorkspace = ws;
      lastResolved = state.sequence;
      lastSequenceCfg = ws?.sequence;
      lastBusy = state.busy;
    };
  },
};
