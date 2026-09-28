/**
 * Preflight tab: edit the workspace's single `PreflightConfig`
 * (`.pdf-workbench/preflight.json`) and run it against the currently
 * selected PDF (`AppState.selectedFile/selectedBytes/selectedSha256`).
 *
 * Running (one file or all of them) goes through `state/preflightBatch`:
 * the object-based checks from `runPreflight` plus the raster margin and
 * stamp-collision checks, rendering each page via `PdfRenderer` into an
 * offscreen canvas.
 */
import type { MarginTolerance, PageSelector, PreflightConfig, PreflightFinding, PreflightReport, PreflightTextRule } from '@/core/types';
import { PAPER_SIZES_PT } from '@/core/units';
import { PdfRenderer } from '@/pdf/renderer';
import { DEFAULT_MARGIN_TOLERANCE_PT, describePreflightCode, summarizeReport } from '@/preflight';
import { parsePageList } from '@/stamps';
import type { AppController, AppState } from '@/state/app';
import { loadPreflightSummary, preflightDir, preflightSingle, runPreflightBatch, type PageRaster, type PreflightBatchResult } from '@/state/preflightBatch';
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
  if (!c.checks) c.checks = { marginText: false, marginRaster: false, stampCollision: false, stampDuplicate: false, textOverlap: false, fonts: false };
  return c;
}

/**
 * Codes for the result table: each with its description when that says
 * more (e.g. a text rule's message), and the detail of problems without a
 * location (e.g. the font names of `FONT_NOT_EMBEDDED`).
 */
function describeCodes(codes: string[], config: PreflightConfig | undefined, findings: PreflightFinding[] = []): string {
  if (codes.length === 0) return '—';
  return codes
    .map((c) => {
      const d = describePreflightCode(c, config);
      const label = d === c || /^[A-Z_0-9]+$/.test(c) ? c : `${c}（${d}）`;
      const detail = [...new Set(findings.filter((f) => f.code === c && !f.rect && f.text).map((f) => f.text!))];
      return detail.length ? `${label}: ${detail.join(', ')}` : label;
    })
    .join(', ');
}

/** Phantom findings on a page (reference only, not counted), for the result table. */
function phantomNote(findings: PreflightFinding[] = []): HTMLElement | null {
  const codes = [...new Set(findings.filter((f) => f.phantom).map((f) => f.code))];
  return codes.length ? h('div', { class: 'muted' }, `参考: 見えない要素 ${codes.join(', ')}（結果に影響しません）`) : null;
}

/** A rule's pages as typed in the editor: empty = all pages, `1`, `1-2`, `1,3`, or `last` / `odd` / `even`. */
function pagesToText(sel: PageSelector | undefined): string {
  if (!sel || sel.kind === 'all') return '';
  if (sel.kind === 'first') return '1';
  if (sel.kind === 'range') return `${sel.from}-${sel.to}`;
  if (sel.kind === 'list') return sel.pages.join(',');
  return sel.kind;
}

function textToPages(text: string): PageSelector | undefined {
  const t = text.trim().toLowerCase();
  if (t === '' || t === 'all') return undefined;
  if (t === 'first') return { kind: 'first' };
  if (t === 'last' || t === 'odd' || t === 'even') return { kind: t };
  return parsePageList(t);
}

/** Why `pattern` isn't a valid regular expression, or `''`. */
function regexError(pattern: string, flags: string | undefined): string {
  try {
    new RegExp(pattern, `${(flags ?? '').replace(/[gyu]/g, '')}u`);
    return '';
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/**
 * Editor for `textRules`: one row per rule (id, 必須/禁止, pattern,
 * ignore case, pages, severity, message). A rule carrying both `require`
 * and `forbid` (hand-written JSON) edits the one its kind shows and keeps
 * the other.
 */
function buildTextRulesEditor(draft: PreflightConfig, scheduleSave: () => void): HTMLElement {
  const list = h('div', { class: 'text-rules' });
  const rules = (): PreflightTextRule[] => (draft.textRules ??= []);

  function row(rule: PreflightTextRule): HTMLElement {
    const idInput = h('input', { type: 'text', value: rule.id, placeholder: 'orcid', style: 'width:8em' });
    idInput.addEventListener('input', () => {
      rule.id = idInput.value.trim();
      scheduleSave();
    });

    let kind: 'require' | 'forbid' = rule.require !== undefined || rule.forbid === undefined ? 'require' : 'forbid';
    const kindSelect = h('select', {}, h('option', { value: 'require' }, '必須'), h('option', { value: 'forbid' }, '禁止'));
    kindSelect.value = kind;

    const patternInput = h('input', { type: 'text', value: rule[kind] ?? '', placeholder: '正規表現　例: ORCID\\s*iDs?', style: 'flex:1;min-width:14em' });
    const errorEl = h('span', { class: 'muted' });
    function validate(): void {
      const err = patternInput.value ? regexError(patternInput.value, rule.flags) : '';
      patternInput.setCustomValidity(err);
      patternInput.title = err;
      errorEl.textContent = err ? `正規表現エラー: ${err}` : '';
    }
    patternInput.addEventListener('input', () => {
      rule[kind] = patternInput.value;
      validate();
      scheduleSave();
    });
    kindSelect.addEventListener('change', () => {
      const pattern = rule[kind];
      delete rule[kind];
      kind = kindSelect.value === 'forbid' ? 'forbid' : 'require';
      rule[kind] = pattern ?? patternInput.value;
      scheduleSave();
    });

    const caseCheck = h('input', { type: 'checkbox', checked: (rule.flags ?? '').includes('i') });
    caseCheck.addEventListener('change', () => {
      const rest = (rule.flags ?? '').replace(/i/g, '');
      rule.flags = (caseCheck.checked ? `${rest}i` : rest) || undefined;
      validate();
      scheduleSave();
    });

    const pagesInput = h('input', { type: 'text', value: pagesToText(rule.pages), placeholder: '全ページ', style: 'width:6em' });
    pagesInput.title = '空欄 = 全ページ．例: 1，1-2，1,3，last，odd，even';
    pagesInput.addEventListener('input', () => {
      rule.pages = textToPages(pagesInput.value);
      if (!rule.pages) delete rule.pages;
      scheduleSave();
    });

    const severitySelect = h('select', {}, h('option', { value: 'warning' }, '警告'), h('option', { value: 'error' }, 'エラー'));
    severitySelect.value = rule.severity ?? 'warning';
    severitySelect.addEventListener('change', () => {
      if (severitySelect.value === 'error') rule.severity = 'error';
      else delete rule.severity;
      scheduleSave();
    });

    const messageInput = h('input', { type: 'text', value: rule.message ?? '', placeholder: 'メッセージ　例: ORCID 欄がありません', style: 'flex:1;min-width:14em' });
    messageInput.addEventListener('input', () => {
      rule.message = messageInput.value || undefined;
      scheduleSave();
    });

    const removeBtn = button('削除', () => {
      draft.textRules = rules().filter((r) => r !== rule);
      render();
      scheduleSave();
    }, 'btn btn-sm');

    validate();
    return h(
      'div',
      { class: 'text-rule', style: 'margin-bottom:8px' },
      h('div', { class: 'row' }, field('id', idInput), field('種類', kindSelect), field('パターン', patternInput), h('label', { class: 'row' }, caseCheck, '大小無視')),
      h('div', { class: 'row' }, field('ページ', pagesInput), field('重さ', severitySelect), field('メッセージ', messageInput), removeBtn),
      errorEl,
    );
  }

  function render(): void {
    replaceChildren(list, ...rules().map(row));
  }
  render();

  return h(
    'div',
    null,
    list,
    button('ルールを追加', () => {
      rules().push({ id: `rule${rules().length + 1}`, require: '' });
      render();
    }, 'btn btn-sm'),
    h(
      'p',
      { class: 'muted settings-note' },
      '必須: 指定したページのどこかにパターンに合うテキストがなければ報告（最初のページに付箋）．禁止: 合うテキストがあればその場所を報告．' +
        'テキストは改行・連続した空白を空白 1 つにしたもの．パターンは JavaScript の正規表現です．',
    ),
  );
}

const SEVERITY_LABEL: Record<PreflightReport['result'], string> = { ok: 'OK', warning: '警告', error: 'エラー' };
const SEVERITY_CLASS: Record<PreflightReport['result'], string> = { ok: 'ok', warning: 'warn', error: 'err' };

/** Lets the section trigger a save and recognise its own saves coming back. */
interface SaveRef {
  save: () => void;
  /** JSON of the config most recently handed to `updatePreflightConfig`. */
  savingJson?: string;
}

function buildRulesForm(
  ctrl: AppController,
  draft: PreflightConfig,
  statusEl: HTMLElement,
  saveNowRef: SaveRef,
): HTMLElement {
  const debouncedSave = debounce(() => void doSave(), 400);
  function scheduleSave(): void {
    statusEl.textContent = '未保存の変更…';
    debouncedSave();
  }
  async function doSave(): Promise<void> {
    statusEl.textContent = '保存中…';
    const toSave = structuredClone(draft);
    // Our own save coming back through the store must not rebuild the form
    // (that would drop the focus and the caret while the user is typing).
    saveNowRef.savingJson = JSON.stringify(toSave);
    await ctrl.updatePreflightConfig(toSave);
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

  // Per-side margin tolerance. A single number in preflight.json (older
  // files) fills all four boxes; any edit stores the per-side object, and
  // clearing every box goes back to the default.
  const sides = ['top', 'bottom', 'left', 'right'] as const;
  const initialTol: MarginTolerance =
    typeof margins.tolerance === 'number'
      ? { top: margins.tolerance, bottom: margins.tolerance, left: margins.tolerance, right: margins.tolerance }
      : { ...margins.tolerance };
  const toleranceInputs = sides.map((side) => {
    const inp = optionalNumberInput(initialTol[side], (n) => {
      const next: MarginTolerance = typeof margins.tolerance === 'object' ? { ...margins.tolerance } : { ...initialTol };
      if (n !== undefined && n >= 0) next[side] = n;
      else delete next[side];
      margins.tolerance = sides.some((s) => next[s] !== undefined) ? next : undefined;
      scheduleSave();
    });
    inp.placeholder = String(DEFAULT_MARGIN_TOLERANCE_PT);
    inp.step = '0.5';
    inp.min = '0';
    return inp;
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

  const stampDuplicateCheck = h('input', { type: 'checkbox', checked: draft.checks?.stampDuplicate ?? false });
  stampDuplicateCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, stampDuplicate: stampDuplicateCheck.checked };
    scheduleSave();
  });

  const textOverlapCheck = h('input', { type: 'checkbox', checked: draft.checks?.textOverlap ?? false });
  textOverlapCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, textOverlap: textOverlapCheck.checked };
    scheduleSave();
  });
  const fontsCheck = h('input', { type: 'checkbox', checked: draft.checks?.fonts ?? false });
  fontsCheck.addEventListener('change', () => {
    draft.checks = { ...draft.checks, fonts: fontsCheck.checked };
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
      field('サイズの許容誤差 (pt)', toleranceInput),
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
    h('h3', null, '余白の許容誤差 (pt)'),
    h(
      'div',
      { class: 'row' },
      field('上', toleranceInputs[0]),
      field('下', toleranceInputs[1]),
      field('左', toleranceInputs[2]),
      field('右', toleranceInputs[3]),
    ),
    h(
      'p',
      { class: 'muted settings-note' },
      `余白の線からこの距離（pt）までのはみ出しは違反にしません（辺ごと，空欄 = ${DEFAULT_MARGIN_TOLERANCE_PT} pt）．両端揃えの行や最終行のベースラインが線にちょうど接する場合の誤検出を防ぎます．`,
    ),
    h('h3', null, 'ページ数'),
    h('div', { class: 'row' }, field('最小', pagesMinInput), field('最大', pagesMaxInput)),
    h('h3', null, 'テキストルール'),
    buildTextRulesEditor(draft, scheduleSave),
    h('h3', null, 'チェック項目'),
    h(
      'div',
      { class: 'row' },
      h('label', { class: 'row' }, marginTextCheck, '余白（テキストベース）'),
      h('label', { class: 'row' }, marginRasterCheck, '余白（描画ベース）'),
      h('label', { class: 'row' }, stampCollisionCheck, 'スタンプ衝突'),
      h('label', { class: 'row' }, stampDuplicateCheck, 'スタンプ重複'),
      h('label', { class: 'row' }, textOverlapCheck, '文字の重なり'),
      h('label', { class: 'row' }, fontsCheck, 'フォント埋め込み'),
    ),
    h(
      'p',
      { class: 'muted settings-note' },
      'スタンプ重複: 有効なスタンプのテキストや画像と同じものが原稿にすでに入っていないかを調べます（テキストは語の 8 割以上が一致すれば重複，画像は大きさが違っても同じ絵なら重複）．' +
        '文字の重なり: 別々の文字列が重なって描かれている箇所（ロゴが文字に化けて重なった等の表示崩れ）を報告します．' +
        'フォント埋め込み: 埋め込まれていないフォントと Type 3 フォントを，最初に使われたページで報告します．',
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
    const batchCancelButton = button('中止', () => ctrl.cancelRunning(), 'btn', 'x');
    batchCancelButton.title = '検査中のファイルが終わったところで止めます（Esc）';
    const runPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, '一括検査'),
      h(
        'p',
        { class: 'muted settings-note' },
        '全 PDF を検査し，問題のあった PDF には問題箇所に赤枠と注釈（コメント）を付けたコピーを保存します（元 PDF は変更しません）．実行のたびに保存先フォルダの中身はいったん全て削除されます．',
      ),
      h('div', { class: 'row' }, batchButton, batchCancelButton),
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
      const dir = preflightDir(ctrl);
      const existing = await ctrl.countFilesIn(dir);
      if (
        existing > 0 &&
        !confirm(`全 ${ctrl.state.files.length} 件を検査し直します．${dir}/ 内の既存のファイル（${existing} 件：注釈付きコピーと summary）はすべて削除されます．よろしいですか？`)
      ) {
        return;
      }
      const label = 'Preflight 一括検査';
      const res = await ctrl.runCancellable(label, (signal) =>
        runPreflightBatch(ctrl, {
          rasterize: rasterizePages,
          signal,
          onProgress: (done, total) => ctrl.setProgress({ label, done, total }),
        }),
      );
      if (!res) return;
      batch = res;
      if (res.cancelled) {
        renderBatch(ctrl.state);
        ctrl.toast('info', `一括検査を中止しました（${res.items.length}/${res.total} 件を検査済み．結果は ${res.dir}/ にあります）`, 10000);
        return;
      }
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
      batchCancelButton.hidden = !state.cancel;
      batchCancelButton.disabled = !!state.cancel?.cancelling;
      batchCancelButton.lastChild!.textContent = state.cancel?.cancelling ? '中止しています…' : '中止';
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
          batch.cancelled ? h('span', { class: 'badge warn' }, `中止（${batch.items.length}/${batch.total ?? '?'} 件）`) : '',
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
    const saveNowRef: SaveRef = { save: () => undefined };

    /** The single check's review copy (undefined path when the file passed). */
    let lastAnnotated: { file: string; path?: string } | undefined;

    async function runCheck(): Promise<void> {
      const ws = ctrl.state.workspace;
      const state = ctrl.state;
      if (!ws || !state.selectedFile || !state.selectedBytes || !state.selectedSha256) return;
      await ctrl.run('Preflight を実行', async () => {
        const { report, annotated } = await preflightSingle(ctrl, state.selectedFile!, state.selectedBytes!, { rasterize: rasterizePages });
        lastAnnotated = { file: report.file, path: annotated };
        await ctrl.saveReport(report);
        batch = await loadPreflightSummary(ctrl);
        renderBatch(ctrl.state);
        ctrl.toast(
          report.result === 'error' ? 'err' : report.result === 'warning' ? 'warn' : 'ok',
          `Preflight 完了: ${summarizeReport(report)}${annotated ? `．注釈付きのコピーを ${annotated} に保存しました` : ''}`,
          8000,
        );
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
          h('td', null, describeCodes(p.errors ?? [], ws?.preflight, p.findings)),
          h('td', null, describeCodes(p.warnings, ws?.preflight, p.findings), phantomNote(p.findings)),
        ),
      );
      replaceChildren(
        resultBox,
        h(
          'div',
          { class: 'row' },
          badge,
          h('span', null, summarizeReport(report)),
          lastAnnotated?.file === report.file && lastAnnotated.path
            ? button('注釈付き PDF を開く', () => void openInTab(lastAnnotated!.path!), 'btn btn-sm', 'file-text')
            : '',
        ),
        h('p', { class: 'muted' }, `file: ${report.file} / sha256: ${report.sha256} / ranAt: ${report.ranAt}`),
        report.documentWarnings.length
          ? h('div', { class: 'alert warn' }, `文書レベルの警告: ${describeCodes(report.documentWarnings, ws?.preflight)}`)
          : null,
        h(
          'table',
          null,
          h('thead', null, h('tr', null, h('th', null, 'page'), h('th', null, 'errors'), h('th', null, 'warnings'))),
          h('tbody', null, rows),
        ),
      );
    }

    /** (Re)build the rules form for the current `draft`. */
    function renderForm(): void {
      if (!draft) return;
      const statusEl = h('span', { class: 'muted' });
      replaceChildren(rulesFormBox, buildRulesForm(ctrl, draft, statusEl, saveNowRef));
    }

    function applyState(state: AppState): void {
      const ws = state.workspace;
      const view = ws ? gridEl : noWorkspace;
      // Swap only when needed: re-attaching the form would drop the focus while typing.
      if (root.firstChild !== view) replaceChildren(root, view);
      if (!ws) return;

      const cfgJson = JSON.stringify(ws.preflight);
      if (draft && cfgJson !== savedJson && cfgJson === saveNowRef.savingJson) {
        // The config we just saved: the form already shows it.
        savedJson = cfgJson;
      } else if (!draft || cfgJson !== savedJson) {
        draft = cloneConfig(ws.preflight);
        savedJson = cfgJson;
        renderForm();
      }
      rawJsonBox.textContent = JSON.stringify(ws.preflight, null, 2);

      renderRunPanel(state);
      renderBatch(state);
    }

    return (state) => applyState(state);
  },
};
