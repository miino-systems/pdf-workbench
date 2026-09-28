/**
 * Preflight tab, "検査結果": the last batch's rows, filtered by result and
 * by problem code, next to a preview of the selected row's annotated copy
 * (its source PDF when it has none), where a row can be marked
 * "検査スルー" (a known false positive) after looking at it.
 */
import type { PreflightWarningCode } from '@/core/types';
import { PdfRenderer } from '@/pdf/renderer';
import { describePreflightCode } from '@/preflight';
import type { AppController, AppState } from '@/state/app';
import {
  BATCH_KIND_ORDER,
  batchItemKind,
  countBatchCodes,
  describeProblems,
  filterBatchItems,
  isPreflightSkipped,
  setPreflightSkipped,
  type BatchItemKind,
  type PreflightBatchItem,
  type PreflightBatchResult,
  type Rasterizer,
} from '@/state/preflightBatch';
import { basename } from '@/workspace';
import { splitGrid } from '../components/splitGrid';
import { button, h, replaceChildren } from '../dom';

const KIND: Record<BatchItemKind, { cls: string; label: string; filter: string }> = {
  error: { cls: 'err', label: 'エラー', filter: 'エラー' },
  failed: { cls: 'err', label: '失敗', filter: '検査失敗' },
  warning: { cls: 'warn', label: '警告', filter: '警告' },
  phantom: { cls: '', label: '参考', filter: '見えない要素のみ' },
  skipped: { cls: '', label: 'スルー', filter: 'スルー' },
  ok: { cls: 'ok', label: 'OK', filter: '問題なし' },
};

const ZOOMS: [string, string][] = [
  ['fit', '幅に合わせる'],
  ['0.5', '50%'],
  ['0.75', '75%'],
  ['1', '100%'],
  ['1.25', '125%'],
  ['1.5', '150%'],
];

export interface ResultsView {
  el: HTMLElement;
  update(state: AppState, batch: PreflightBatchResult | undefined): void;
}

export function createResultsView(
  ctrl: AppController,
  opts: {
    rasterize: Rasterizer;
    /** Reload the summary after a row changed (e.g. "検査スルー" toggled). */
    reload: () => Promise<void>;
    /** The name a row is listed by (its review copy's). */
    nameOf: (it: PreflightBatchItem, dir: string) => string;
  },
): ResultsView {
  // ------------------------------------------------------------ filters
  const kinds = new Set<BatchItemKind>(BATCH_KIND_ORDER.filter((k) => k !== 'ok'));
  const codes = new Set<PreflightWarningCode>();
  let mode: 'any' | 'only' = 'any';
  let selected: string | undefined;

  const meta = h('div', { class: 'row muted' });
  const kindBox = h('div', { class: 'row results-kinds' });
  const codeBox = h('div', { class: 'results-codes' });
  const modeSelect = h(
    'select',
    { on: { change: () => ((mode = modeSelect.value as 'any' | 'only'), render()) } },
    h('option', { value: 'any' }, 'いずれかを含む'),
    h('option', { value: 'only' }, 'これだけを含む'),
  );
  const clearCodes = button('選択を解除', () => (codes.clear(), render()), 'btn btn-sm');
  const countLine = h('span', { class: 'muted' });
  const list = h('ul', { class: 'list results-list', tabIndex: 0 });
  list.addEventListener('keydown', (ev) => {
    const step = ev.key === 'ArrowDown' || ev.key === 'j' ? 1 : ev.key === 'ArrowUp' || ev.key === 'k' ? -1 : 0;
    if (!step) return;
    ev.preventDefault();
    const i = shown.findIndex((it) => it.file === selected);
    const next = shown[Math.min(shown.length - 1, Math.max(0, i + step))];
    if (next) select(next.file);
  });

  const listPanel = h(
    'div',
    { class: 'panel results-panel' },
    h('h2', null, '検査結果'),
    meta,
    kindBox,
    h('div', { class: 'row results-code-head' }, h('span', { class: 'muted' }, 'エラー内容'), modeSelect, clearCodes, countLine),
    codeBox,
    list,
  );

  // ------------------------------------------------------------ preview
  const title = h('h2', { class: 'results-title' }, 'Preview');
  const sourceLine = h('div', { class: 'muted results-source' });
  const problemsLine = h('div', { class: 'results-problems' });
  const skipInput = h('input', { type: 'checkbox', on: { change: () => void toggleSkip(skipInput.checked) } });
  const skipLabel = h(
    'label',
    { class: 'row', title: '誤検出と分かっている PDF を一括検査から外します（preflight.json の skipFiles）' },
    skipInput,
    '検査スルー（誤検出）',
  );
  const zoomSelect = h('select', { on: { change: () => void renderPages() } }, ZOOMS.map(([v, l]) => h('option', { value: v }, l)));
  const openBtn = button('新しいタブで開く', () => void openInTab(), 'btn btn-sm', 'file-text');
  const pages = h('div', { class: 'preview-wrap results-pages' });
  const previewPanel = h(
    'div',
    { class: 'panel results-preview' },
    title,
    sourceLine,
    h('div', { class: 'preview-toolbar' }, skipLabel, h('label', null, 'zoom ', zoomSelect), openBtn),
    problemsLine,
    pages,
  );

  const el = splitGrid(ctrl, listPanel, previewPanel, { key: 'preflightResults', initial: 0.4, class: 'fill-layout' });

  let batch: PreflightBatchResult | undefined;
  let shown: PreflightBatchItem[] = [];
  let lastState: AppState = ctrl.state;

  function render(): void {
    const b = batch;
    if (!b) {
      replaceChildren(meta, `まだ一括検査の結果がありません．「ルールと実行」タブで一括検査を実行してください．`);
      replaceChildren(kindBox);
      replaceChildren(codeBox);
      replaceChildren(list);
      countLine.textContent = '';
      shown = [];
      select(undefined);
      return;
    }
    replaceChildren(
      meta,
      `${b.ranAt}（${b.dir}/summary.csv）`,
      b.cancelled ? h('span', { class: 'badge warn' }, `中止（${b.items.length}/${b.total ?? '?'} 件）`) : '',
    );

    const perKind = new Map<BatchItemKind, number>();
    for (const it of b.items) perKind.set(batchItemKind(it), (perKind.get(batchItemKind(it)) ?? 0) + 1);
    replaceChildren(
      kindBox,
      BATCH_KIND_ORDER.filter((k) => perKind.get(k) || kinds.has(k)).map((k) => {
        const input = h('input', {
          type: 'checkbox',
          checked: kinds.has(k),
          on: { change: () => ((input.checked ? kinds.add(k) : kinds.delete(k)), render()) },
        });
        return h('label', { class: 'row' }, input, `${KIND[k].filter} ${perKind.get(k) ?? 0}`);
      }),
    );

    // Code chips count the rows the result filter lets through.
    const byKind = b.items.filter((it) => kinds.has(batchItemKind(it)));
    const available = countBatchCodes(byKind);
    for (const c of [...codes]) if (!available.some(([code]) => code === c)) codes.delete(c);
    replaceChildren(
      codeBox,
      available.length
        ? available.map(([c, n]) =>
            h(
              'button',
              {
                type: 'button',
                class: `code-chip${codes.has(c) ? ' active' : ''}`,
                title: describePreflightCode(c, lastState.workspace?.preflight),
                attrs: { 'aria-pressed': String(codes.has(c)) },
                on: { click: () => ((codes.has(c) ? codes.delete(c) : codes.add(c)), render()) },
              },
              `${c} `,
              h('span', { class: 'muted' }, String(n)),
            ),
          )
        : h('span', { class: 'muted' }, '該当するエラー内容はありません'),
    );
    clearCodes.disabled = codes.size === 0;

    shown = filterBatchItems(b.items, { kinds, codes, mode });
    countLine.textContent = `${shown.length} / ${b.items.length} 件`;
    replaceChildren(
      list,
      shown.length
        ? shown.map((it) => {
            const k = KIND[batchItemKind(it)];
            return h(
              'li',
              {
                class: it.file === selected ? 'selected' : '',
                dataset: { file: it.file },
                title: it.file,
                attrs: { 'aria-selected': String(it.file === selected) },
                on: { click: () => select(it.file) },
              },
              h('span', { class: `badge ${k.cls}` }, k.label),
              h('span', { class: 'name' }, opts.nameOf(it, b.dir)),
              h('span', { class: 'muted summary' }, it.result === 'skipped' && it.codes?.length ? `スルー: ${it.codes.join(', ')}` : it.summary),
            );
          })
        : h('li', { class: 'muted', attrs: { role: 'presentation' } }, '条件に合う PDF はありません'),
    );
    if (!shown.some((it) => it.file === selected)) select(shown[0]?.file);
    else showPreview();
  }

  function select(file: string | undefined): void {
    selected = file;
    for (const li of list.querySelectorAll<HTMLElement>('li[data-file]')) {
      const on = li.dataset.file === file;
      li.classList.toggle('selected', on);
      li.setAttribute('aria-selected', String(on));
      if (on) li.scrollIntoView({ block: 'nearest' });
    }
    showPreview();
  }

  function current(): PreflightBatchItem | undefined {
    return batch?.items.find((it) => it.file === selected);
  }

  // ------------------------------------------------------------ rendering
  let renderer: PdfRenderer | undefined;
  let loadedPath: string | undefined;
  let token = 0;
  let renderedWidth = 0;

  function showPreview(): void {
    const it = current();
    const ws = lastState.workspace;
    skipInput.disabled = !it || !ws || !!lastState.busy;
    // While a change is being saved, show what was asked for, not the old setting.
    skipInput.checked = pending && it && pending.file === it.file ? pending.skip : !!(it && ws && isPreflightSkipped(ws.preflight, it.file));
    openBtn.disabled = !it;
    if (!it || !batch) {
      title.textContent = 'Preview';
      sourceLine.textContent = '';
      problemsLine.textContent = '';
      void load(undefined);
      return;
    }
    title.textContent = opts.nameOf(it, batch.dir);
    const path = it.annotated ?? it.file;
    sourceLine.textContent = it.annotated ? `元 PDF: ${it.file}` : `${it.file}（注釈付きコピーなし）`;
    problemsLine.textContent = it.codes?.length ? describeProblems(it.codes, ws?.preflight) : it.summary;
    void load(path);
  }

  async function load(path: string | undefined): Promise<void> {
    if (path === loadedPath) return;
    loadedPath = path;
    const my = ++token;
    const old = renderer;
    renderer = undefined;
    if (old) void old.destroy();
    replaceChildren(pages, path ? h('p', { class: 'muted' }, '読み込み中…') : h('p', { class: 'muted' }, 'PDF を選択してください'));
    const ws = lastState.workspace;
    if (!path || !ws) return;
    try {
      const r = new PdfRenderer(await ws.fs.readBytes(path));
      await r.load();
      if (my !== token) {
        void r.destroy();
        return;
      }
      renderer = r;
      await renderPages();
    } catch (e) {
      if (my === token) replaceChildren(pages, h('p', { class: 'muted' }, `PDF を開けませんでした: ${e instanceof Error ? e.message : String(e)}`));
    }
  }

  async function renderPages(): Promise<void> {
    const r = renderer;
    if (!r) return;
    const my = ++token;
    const available = Math.max(200, pages.clientWidth - 28);
    renderedWidth = pages.clientWidth;
    const canvases = Array.from({ length: r.pageCount }, () => h('canvas'));
    const scroll = pages.scrollTop;
    replaceChildren(pages, canvases.map((c, i) => h('div', { class: 'preview-page results-page', title: `p.${i + 1}` }, c)));
    pages.scrollTop = scroll;
    for (const [i, canvas] of canvases.entries()) {
      const size = r.getPageSize(i + 1);
      const scale = zoomSelect.value === 'fit' ? Math.min(3, available / size.width) : Number(zoomSelect.value);
      await r.renderPage(i + 1, canvas, { scale });
      if (my !== token || r !== renderer) return;
    }
  }

  // Fit-to-width follows the column when the divider or the window moves.
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  new ResizeObserver(() => {
    if (zoomSelect.value !== 'fit' || !renderer || Math.abs(pages.clientWidth - renderedWidth) < 8) return;
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderPages(), 150);
  }).observe(pages);

  let pending: { file: string; skip: boolean } | undefined;

  async function toggleSkip(skip: boolean): Promise<void> {
    const it = current();
    if (!it) return;
    const name = basename(it.file);
    pending = { file: it.file, skip };
    try {
      await ctrl.run('検査スルーを変更', async () => {
        await setPreflightSkipped(ctrl, it.file, skip, { rasterize: opts.rasterize });
        pending = undefined;
        await opts.reload();
        ctrl.toast('info', skip ? `${name} を一括検査でスルーします` : `${name} のスルーを解除し，検査し直しました`);
      });
    } finally {
      pending = undefined;
      showPreview();
    }
  }

  async function openInTab(): Promise<void> {
    const ws = lastState.workspace;
    if (!ws || !loadedPath) return;
    const bytes = await ws.fs.readBytes(loadedPath);
    const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
    window.open(url, '_blank', 'noopener');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  return {
    el,
    update(state, next) {
      const busyChanged = !!state.busy !== !!lastState.busy;
      lastState = state;
      if (next !== batch) {
        batch = next;
        // A rewritten summary may point at a new copy of the same file: load it again.
        loadedPath = undefined;
        render();
      } else if (busyChanged) {
        showPreview();
      }
    },
  };
}
