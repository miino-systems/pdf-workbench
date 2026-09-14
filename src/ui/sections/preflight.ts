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
import type { PageSize, PreflightConfig, PreflightMargins, PreflightReport, PreflightWarningCode } from '@/core/types';
import { PAPER_SIZES_PT, toPt } from '@/core/units';
import { PdfRenderer } from '@/pdf/renderer';
import { checkMarginsByRaster, runPreflight, summarizeReport } from '@/preflight';
import type { AppController, AppState } from '@/state/app';
import type { Section } from '../app';
import { button, h, replaceChildren } from '../dom';

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

const SEVERITY_LABEL: Record<PreflightReport['result'], string> = { ok: '✓ OK', warning: '⚠ Warning', error: '✗ Error' };
const SEVERITY_CLASS: Record<PreflightReport['result'], string> = { ok: 'ok', warning: 'warn', error: 'err' };

async function runRasterMarginChecks(bytes: Uint8Array, margins: PreflightMargins, report: PreflightReport): Promise<void> {
  const renderer = new PdfRenderer(bytes);
  try {
    await renderer.load();
    const marginsPt = {
      top: toPt(margins.top, margins.unit),
      bottom: toPt(margins.bottom, margins.unit),
      left: toPt(margins.left, margins.unit),
      right: toPt(margins.right, margins.unit),
    };
    for (let pageNumber = 1; pageNumber <= renderer.pageCount; pageNumber += 1) {
      const pageSize: PageSize = renderer.getPageSize(pageNumber);
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

function buildRulesForm(ctrl: AppController, draft: PreflightConfig, statusEl: HTMLElement, saveNowRef: { save: () => void }): HTMLElement {
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

    const runButton = button('選択中の PDF を検査', () => void runCheck(), 'btn btn-primary');
    const runHint = h('p', { class: 'muted' });
    const resultBox = h('div', null);
    const runPanel = h('div', { class: 'panel' }, h('h2', null, '実行'), h('div', { class: 'row' }, runButton), runHint, resultBox);

    const gridEl = h('div', { class: 'grid grid-2' }, rulesPanel, runPanel);

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
            await runRasterMarginChecks(state.selectedBytes!, cfg.margins, report);
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

    function applyState(state: AppState): void {
      const ws = state.workspace;
      replaceChildren(root, ws ? gridEl : noWorkspace);
      if (!ws) return;

      const cfgJson = JSON.stringify(ws.preflight);
      if (!draft || cfgJson !== savedJson) {
        draft = cloneConfig(ws.preflight);
        savedJson = cfgJson;
        const statusEl = h('span', { class: 'muted' });
        replaceChildren(rulesFormBox, buildRulesForm(ctrl, draft, statusEl, saveNowRef));
      }
      rawJsonBox.textContent = JSON.stringify(ws.preflight, null, 2);

      renderRunPanel(state);
    }

    return (state) => applyState(state);
  },
};
