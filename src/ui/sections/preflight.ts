/**
 * Preflight tab: edit the workspace's single `PreflightConfig`
 * (`.pdf-workbench/preflight.json`) and run it against the currently
 * selected PDF (`AppState.selectedFile/selectedBytes/selectedSha256`).
 *
 * Running combines the object-based checks from `runPreflight` (page size /
 * orientation / count, and optionally the text-based margin check) with an
 * optional raster-based margin check (`checkMarginsByRaster`), rendering
 * each page via `PdfRenderer` into an offscreen canvas. Raster failures are
 * non-fatal: the object-based report is still saved even if rasterisation
 * throws.
 */
import type { PageSize, PreflightConfig, PreflightReport, PreflightWarningCode } from '@/core/types';
import { PAPER_SIZES_PT, toPt } from '@/core/units';
import { PdfRenderer } from '@/pdf/renderer';
import { PREFLIGHT_PRESETS, applyPreflightPreset, checkMarginsByRaster, marginsForPage, runPreflight, summarizeReport } from '@/preflight';
import type { AppController, AppState } from '@/state/app';
import { loadPreflightSummary, preflightDir, runPreflightBatch, type PageRaster, type PreflightBatchResult } from '@/state/preflightBatch';
import type { Section } from '../app';
import { button, h, replaceChildren } from '../dom';

/** Render every page at 1 px/pt into an offscreen canvas, for the raster checks. */
async function* rasterizePages(bytes: Uint8Array): AsyncIterable<PageRaster> {
  const renderer = new PdfRenderer(bytes);
  try {
    await renderer.load();
    const canvas = document.createElement('canvas');
    for (let page = 1; page <= renderer.pageCount; page += 1) {
      await renderer.renderPage(page, canvas, { scale: 1 });
      const ctx2d = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx2d) throw new Error('2D canvas context unavailable');
      yield { page, pageSize: renderer.getPageSize(page), image: ctx2d.getImageData(0, 0, canvas.width, canvas.height) };
    }
  } finally {
    await renderer.destroy();
  }
}

function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): (...args: Args) => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return (...args: Args) => {
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control);
}

function optionalNumberInput(value: number | undefined, onChange: (n: number | undefined) => void): HTMLInputElement {
  const inp = h('input', { type: 'number', value: value === undefined ? '' : String(value) });
  inp.addEventListener('input', () => {
    if (inp.value.trim() === '') {
      onChange(undefined);
      return;
    }
    const n = parseFloat(inp.value);
    if (!Number.isNaN(n)) onChange(n);
  });
  return inp;
}

function cloneConfig(cfg: PreflightConfig): PreflightConfig {
  const c = structuredClone(cfg);
  if (!c.margins) c.margins = { top: 20, bottom: 20, left: 18, right: 18, unit: 'mm' };
  if (!c.page) c.page = {};
  if (!c.pages) c.pages = {};
  if (!c.checks) c.checks = { marginText: false, marginRaster: false, stampCollision: false };
  return c;
}

const SEVERITY_LABEL: Record<PreflightReport['result'], string> = { ok: 'OK', warning: '警告', error: 'エラー' };
const SEVERITY_CLASS: Record<PreflightReport['result'], string> = { ok: 'ok', warning: 'warn', error: 'err' };

async function runRasterMarginChecks(bytes: Uint8Array, config: PreflightConfig, report: PreflightReport): Promise<void> {
  const margins = config.margins;
  if (!margins) return;
  const renderer = new PdfRenderer(bytes);
  try {
    await renderer.load();
    for (let pageNumber = 1; pageNumber <= renderer.pageCount; pageNumber += 1) {
      const pageSize: PageSize = renderer.getPageSize(pageNumber);
      const pageMargins = marginsForPage(margins, config.marginOverrides, pageNumber, renderer.pageCount);
      const marginsPt = {
        top: toPt(pageMargins.top, pageMargins.unit),
        bottom: toPt(pageMargins.bottom, pageMargins.unit),
        left: toPt(pageMargins.left, pageMargins.unit),
        right: toPt(pageMargins.right, pageMargins.unit),
      };
      const canvas = document.createElement('canvas');
      await renderer.renderPage(pageNumber, canvas, { scale: 1 });
      const ctx2d = canvas.getContext('2d');
      if (!ctx2d) throw new Error('2D canvas context unavailable');
      const imageData = ctx2d.getImageData(0, 0, canvas.width, canvas.height);
      const codes = checkMarginsByRaster(imageData, pageSize, marginsPt);
      if (codes.length === 0) continue;
      const pageResult = report.pages.find((p) => p.page === pageNumber);
      if (pageResult) {
        const codeSet = new Set<PreflightWarningCode>(pageResult.warnings);
        for (const c of codes) codeSet.add(c);
        pageResult.warnings = [...codeSet];
      }
    }
  } finally {
    await renderer.destroy();
  }
  if (report.result === 'ok' && report.pages.some((p) => p.warnings.length > 0)) {
    report.result = 'warning';
  }
}

function buildRulesForm(
  ctrl: AppController,
  draft: PreflightConfig,
  statusEl: HTMLElement,
  saveNowRef: { save: () => void },
  originalJson: string,
  rerenderForm: () => void,
): HTMLElement {
  const debouncedSave = debounce(() => void doSave(), 400);
  function scheduleSave(): void {
    statusEl.textContent = '未保存の変更…';
    debouncedSave();
  }
  async function doSave(): Promise<void> {
    statusEl.textContent = '保存中…';
    await ctrl.updatePreflightConfig(structuredClone(draft));
    statusEl.textContent = '保存しました';
  }
  saveNowRef.save = () => void doSave();

  const presetSelect = h('select', {});
  presetSelect.append(h('option', { value: '' }, 'ひな形を選択…'));
  for (const preset of PREFLIGHT_PRESETS) presetSelect.append(h('option', { value: preset.id }, preset.label));
  const presetNote = h('p', { class: 'muted' });
  function updatePresetNote(): void {
    const preset = PREFLIGHT_PRESETS.find((p) => p.id === presetSelect.value);
    presetNote.textContent = preset?.note ?? '';
  }
  presetSelect.addEventListener('change', updatePresetNote);
  updatePresetNote();

  const appliedFromLabel = h('p', { class: 'muted' });
  if (draft.preset) {
    const appliedFrom = PREFLIGHT_PRESETS.find((p) => p.id === draft.preset);
    appliedFromLabel.textContent = `適用元のひな形: ${appliedFrom?.label ?? draft.preset}`;
  }

  const applyPresetButton = button(
    'ひな形を適用',
    () => {
      const preset = PREFLIGHT_PRESETS.find((p) => p.id === presetSelect.value);
      if (!preset) {
        ctrl.toast('warn', 'ひな形を選択してください。');
        return;
      }
      const isDirty = JSON.stringify(draft) !== originalJson;
      if (isDirty && !confirm(`現在の余白・ページ設定を「${preset.label}」で置き換えます。未保存の変更があれば失われます。よろしいですか？`)) {
        return;
      }
      Object.assign(draft, applyPreflightPreset(preset, draft));
      // Re-render the whole form so every input reflects the new draft
      // values; saving itself is left to the existing 保存 button/debounce.
      rerenderForm();
    },
    'btn btn-sm',
  );

  const idInput = h('input', { type: 'text', value: draft.id });
  idInput.addEventListener('input', () => {
    draft.id = idInput.value;
    scheduleSave();
  });
  const nameInput = h('input', { type: 'text', value: draft.name ?? '' });
  nameInput.addEventListener('input', () => {
    draft.name = nameInput.value || undefined;
    scheduleSave();
  });

  const sizeSelect = h('select', {});
  sizeSelect.append(h('option', { value: '' }, '指定なし'));
  for (const key of Object.keys(PAPER_SIZES_PT)) sizeSelect.append(h('option', { value: key }, key));
  sizeSelect.value = draft.page?.size ?? '';
  sizeSelect.addEventListener('change', () => {
    draft.page = { ...draft.page, size: sizeSelect.value || undefined };
    scheduleSave();
  });

  const orientationSelect = h('select', {});
  orientationSelect.append(
    h('option', { value: '' }, '指定なし'),
    h('option', { value: 'portrait' }, 'portrait'),
    h('option', { value: 'landscape' }, 'landscape'),
  );
  orientationSelect.value = draft.page?.orientation ?? '';
  orientationSelect.addEventListener('change', () => {
    const v = orientationSelect.value;
    draft.page = { ...draft.page, orientation: v === 'portrait' || v === 'landscape' ? v : undefined };
    scheduleSave();
  });

  const toleranceInput = optionalNumberInput(draft.page?.tolerance, (n) => {
    draft.page = { ...draft.page, tolerance: n };
    scheduleSave();
  });

  const margins = draft.margins!;
  const topInput = optionalNumberInput(margins.top, (n) => {
    margins.top = n ?? 0;
    scheduleSave();
  });
  const bottomInput = optionalNumberInput(margins.bottom, (n) => {
    margins.bottom = n ?? 0;
    scheduleSave();
  });
  const leftInput = optionalNumberInput(margins.left, (n) => {
    margins.left = n ?? 0;
    scheduleSave();
  });
  const rightInput = optionalNumberInput(margins.right, (n) => {
    margins.right = n ?? 0;
    scheduleSave();
  });
  const marginUnitSelect = h('select', {});
  marginUnitSelect.append(h('option', { value: 'mm' }, 'mm'), h('option', { value: 'pt' }, 'pt'));
  marginUnitSelect.value = margins.unit;
  marginUnitSelect.addEventListener('change', () => {
    margins.unit = marginUnitSelect.value === 'pt' ? 'pt' : 'mm';
    scheduleSave();
  });

  const pagesMinInput = optionalNumberInput(draft.pages?.min, (n) => {
    draft.pages = { ...draft.pages, min: n };
    scheduleSave();
  });
  const pagesMaxInput = optionalNumberInput(draft.pages?.max, (n) => {
    draft.pages = { ...draft.pages, max: n };
    scheduleSave();
  });

  const marginTextCheck = h('input', { type: 'checkbox', checked: draft.checks?.marginText ?? false });
  marginTextCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, marginText: marginTextCheck.checked };
    scheduleSave();
  });
  const marginRasterCheck = h('input', { type: 'checkbox', checked: draft.checks?.marginRaster ?? false });
  marginRasterCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, marginRaster: marginRasterCheck.checked };
    scheduleSave();
  });
  const stampCollisionCheck = h('input', { type: 'checkbox', checked: draft.checks?.stampCollision ?? false });
  stampCollisionCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, stampCollision: stampCollisionCheck.checked };
    scheduleSave();
  });

  return h(
    'div',
    null,
    h('h3', null, 'ひな形 (プリセット)'),
    h('div', { class: 'row' }, field('ひな形', presetSelect), applyPresetButton),
    presetNote,
    appliedFromLabel,
    h('div', { class: 'row' }, field('id', idInput), field('名前', nameInput)),
    h('h3', null, 'ページ'),
    h(
      'div',
      { class: 'row' },
      field('サイズ', sizeSelect),
      field('向き', orientationSelect),
      field('許容誤差 (pt)', toleranceInput),
    ),
    h('h3', null, '余白 (margins)'),
    h(
      'div',
      { class: 'row' },
      field('上', topInput),
      field('下', bottomInput),
      field('左', leftInput),
      field('右', rightInput),
      field('単位', marginUnitSelect),
    ),
    h('h3', null, 'ページ数'),
    h('div', { class: 'row' }, field('最小', pagesMinInput), field('最大', pagesMaxInput)),
    h('h3', null, 'チェック項目'),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'row' }, marginTextCheck, '余白（テキストベース）'),
      h('label', { class: 'row' }, marginRasterCheck, '余白（描画ベース）'),
      h('label', { class: 'row' }, stampCollisionCheck, 'スタンプ衝突'),
    ),
    h('div', { class: 'row', style: 'margin-top:8px' }, button('保存', () => saveNowRef.save(), 'btn btn-primary btn-sm'), statusEl),
  );
}

export const preflightSection: Section = {
  id: 'preflight',
  title: 'Preflight',
  mount(root, ctrl) {
    const noWorkspace = h(
      'div',
      { class: 'alert warn' },
      'Workspace が開かれていません。 ',
      button('Workspace タブへ', () => ctrl.setPrefs({ lastTab: 'workspace' }), 'btn btn-sm'),
    );

    const rulesFormBox = h('div', null);
    const rawJsonBox = h('pre', null);
    const rulesPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Preflight ルール'),
      rulesFormBox,
      h('details', { class: 'panel' }, h('summary', null, '保存される JSON (.pdf-workbench/preflight.json)'), rawJsonBox),
    );

    const runButton = button('選択中の PDF を検査', () => void runCheck(), 'btn');
    const runHint = h('p', { class: 'muted' });
    const resultBox = h('div', null);
    const batchButton = button('全 PDF を一括検査', () => void runBatch(), 'btn btn-primary');
    const batchBox = h('div', null);
    const runPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, '一括検査'),
      h(
        'p',
        { class: 'muted settings-note' },
        '全 PDF を検査し，問題のあった PDF には問題箇所に赤枠と注釈（コメント）を付けたコピーを保存します（元 PDF は変更しません）．',
      ),
      h('div', { class: 'row' }, batchButton),
      batchBox,
      h('h3', null, '1 件だけ検査'),
      h('div', { class: 'row' }, runButton),
      runHint,
      resultBox,
    );

    const gridEl = h('div', { class: 'grid grid-2' }, rulesPanel, runPanel);

    let batch: PreflightBatchResult | undefined;
    let batchWs: unknown;

    /** Open a workspace PDF in a new tab (blob URL; nothing leaves the browser). */
    async function openInTab(path: string): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws) return;
      const bytes = await ws.fs.readBytes(path);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }

    async function runBatch(): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws || ctrl.state.files.length === 0) return;
      saveNowRef.save();
      const label = 'Preflight 一括検査';
      const res = await ctrl.run(label, async () => {
        try {
          return await runPreflightBatch(ctrl, {
            rasterize: rasterizePages,
            onProgress: (done, total) => ctrl.setProgress({ label, done, total }),
          });
        } finally {
          ctrl.setProgress(undefined);
        }
      });
      if (!res) return;
      batch = res;
      renderBatch(ctrl.state);
      const { ok, warning, error, failed } = res.counts;
      ctrl.toast(
        error || failed ? 'err' : warning ? 'warn' : 'ok',
        `一括検査: 問題なし ${ok} 件／警告 ${warning} 件／エラー ${error} 件${failed ? `／検査失敗 ${failed} 件` : ''}．注釈付きのコピーを ${res.dir}/ に保存しました`,
        10000,
      );
    }

    function renderBatch(state: AppState): void {
      const ws = state.workspace;
      batchButton.disabled = !ws || state.files.length === 0 || !!state.busy;
      batchButton.textContent = `全 PDF を一括検査（${state.files.length} 件）`;
      if (!ws) return;
      if (batchWs !== ws.fs) {
        // Show the last saved summary of this workspace, if any.
        batchWs = ws.fs;
        batch = undefined;
        void loadPreflightSummary(ctrl).then((s) => {
          if (batchWs === ctrl.state.workspace?.fs) {
            batch = s;
            renderBatch(ctrl.state);
          }
        });
      }
      if (!batch) {
        replaceChildren(batchBox, h('p', { class: 'muted' }, `結果と注釈付き PDF は ${preflightDir(ctrl)}/ に保存されます．`));
        return;
      }
      const problems = batch.items.filter((it) => it.result !== 'ok');
      const { ok, warning, error, failed } = batch.counts;
      replaceChildren(
        batchBox,
        h(
          'div',
          { class: 'row' },
          h('span', { class: 'badge ok' }, `問題なし ${ok}`),
          h('span', { class: 'badge warn' }, `警告 ${warning}`),
          h('span', { class: 'badge err' }, `エラー ${error}`),
          failed ? h('span', { class: 'badge err' }, `検査失敗 ${failed}`) : '',
          h('span', { class: 'muted' }, `${batch.ranAt}（${batch.dir}/summary.csv）`),
        ),
        problems.length
          ? h(
              'ul',
              { class: 'list preflight-problems' },
              problems.map((it) =>
                h(
                  'li',
                  {
                    title: it.annotated ? 'クリックで注釈付きの PDF を開く' : '',
                    on: { click: () => it.annotated && void openInTab(it.annotated) },
                  },
                  h('span', { class: `badge ${it.result === 'warning' ? 'warn' : 'err'}` }, it.result === 'warning' ? '警告' : it.result === 'error' ? 'エラー' : '失敗'),
                  h('span', { class: 'name' }, it.file.split('/').pop() ?? it.file),
                  h('span', { class: 'muted', style: 'flex:2' }, it.summary),
                ),
              ),
            )
          : h('p', { class: 'ok' }, 'すべての PDF が問題なしでした．'),
      );
    }

    let draft: PreflightConfig | undefined;
    let savedJson: string | undefined;
    const saveNowRef: { save: () => void } = { save: () => undefined };

    async function runCheck(): Promise<void> {
      const ws = ctrl.state.workspace;
      const state = ctrl.state;
      if (!ws || !state.selectedFile || !state.selectedBytes || !state.selectedSha256) return;
      await ctrl.run('Preflight を実行', async () => {
        const cfg = ws.preflight;
        const report = await runPreflight(state.selectedBytes!, cfg, {
          file: state.selectedFile!,
          sha256: state.selectedSha256!,
        });
        if (cfg.checks?.marginRaster && cfg.margins) {
          try {
            await runRasterMarginChecks(state.selectedBytes!, cfg, report);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            ctrl.toast('warn', `描画ベースの余白チェックに失敗しました: ${msg}`);
          }
        }
        const path = await ctrl.saveReport(report);
        ctrl.toast(report.result === 'error' ? 'err' : report.result === 'warning' ? 'warn' : 'ok', `Preflight 完了: ${summarizeReport(report)} → ${path}`);
      });
    }

    function renderRunPanel(state: AppState): void {
      const ws = state.workspace;
      const canRun = !!(ws && state.selectedFile && state.selectedBytes && state.selectedSha256);
      runButton.disabled = !canRun;
      runHint.textContent = canRun
        ? `対象: ${state.selectedFile}`
        : 'PDF タブで検査する PDF を選択してください。';

      const report = state.lastReport;
      if (!report) {
        replaceChildren(resultBox, h('p', { class: 'muted' }, 'まだ実行結果がありません。'));
        return;
      }
      const badge = h('span', { class: `badge ${SEVERITY_CLASS[report.result]}` }, SEVERITY_LABEL[report.result]);
      const rows = report.pages.map((p) =>
        h(
          'tr',
          null,
          h('td', null, String(p.page)),
          h('td', null, (p.errors ?? []).join(', ') || '—'),
          h('td', null, p.warnings.join(', ') || '—'),
        ),
      );
      replaceChildren(
        resultBox,
        h('div', { class: 'row' }, badge, h('span', null, summarizeReport(report))),
        h('p', { class: 'muted' }, `file: ${report.file} / sha256: ${report.sha256} / ranAt: ${report.ranAt}`),
        report.documentWarnings.length
          ? h('div', { class: 'alert warn' }, `文書レベルの警告: ${report.documentWarnings.join(', ')}`)
          : null,
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, 'page'), h('th', null, 'errors'), h('th', null, 'warnings'))),
          h('tbody', null, rows),
        ),
      );
    }

    /**
     * (Re)build the rules form for the current `draft`. `markDirty` is set
     * when the rebuild comes from applying a preset (an in-memory change
     * that has not gone through `updatePreflightConfig` yet) rather than
     * from a freshly loaded/saved workspace config, so the status label
     * reflects that there is something to save.
     */
    function renderForm(markDirty: boolean): void {
      if (!draft) return;
      const statusEl = h('span', { class: 'muted' }, markDirty ? '未保存の変更（ひな形を適用）…' : '');
      replaceChildren(rulesFormBox, buildRulesForm(ctrl, draft, statusEl, saveNowRef, savedJson ?? '', () => renderForm(true)));
    }

    function applyState(state: AppState): void {
      const ws = state.workspace;
      replaceChildren(root, ws ? gridEl : noWorkspace);
      if (!ws) return;

      const cfgJson = JSON.stringify(ws.preflight);
      if (!draft || cfgJson !== savedJson) {
        draft = cloneConfig(ws.preflight);
        savedJson = cfgJson;
        renderForm(false);
      }
      rawJsonBox.textContent = JSON.stringify(ws.preflight, null, 2);

      renderRunPanel(state);
      renderBatch(state);
    }

    return (state) => applyState(state);
  },
};
