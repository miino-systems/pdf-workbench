/**
 * Compact font picker control used by the Stamps editor for `TextLayer.font`
 * / `PageNumberLayer.font`. Lets the user choose a standard (non-embedded)
 * font, a font installed on their system (Local Font Access API), a font
 * file stored in the workspace's `fonts/` directory, or a font file picked
 * ad-hoc from disk (kept in memory only, via `pickedFontFiles`).
 *
 * After a non-standard font is chosen, it is resolved (sha256 computed) via
 * `FontResolver` so a content-hash mismatch against a previously used font
 * of the same name/path can be surfaced immediately.
 */
import type { FontRef, StandardFontName } from '@/core/types';
import { EVENT_TYPES } from '@/history';
import {
  getLastLocalFontsError,
  isLocalFontAccessAvailable,
  listLocalFonts,
  listWorkspaceFonts,
  pickFontFile,
  STANDARD_FONT_NAMES,
  withHash,
  fontWarningMessage,
  type LocalFontInfo,
} from '@/fonts';
import type { AppController } from '@/state/app';
import { createFontResolver, describeFont, pickedFontFiles } from '@/state/generate';
import { button, h, replaceChildren } from '../dom';

export interface FontPickerOptions {
  ctrl: AppController;
  value: FontRef;
  onChange(ref: FontRef): void;
}

const SOURCE_LABELS: { kind: FontRef['kind']; label: string }[] = [
  { kind: 'standard', label: '標準フォント (Helvetica など; 日本語不可)' },
  { kind: 'local', label: 'ローカルフォント' },
  { kind: 'workspace', label: 'Workspace フォント (fonts/*.ttf|otf)' },
  { kind: 'file', label: 'フォントファイルを選択' },
];

function shortHash(sha?: string): string {
  if (!sha) return '';
  const hex = sha.startsWith('sha256:') ? sha.slice('sha256:'.length) : sha;
  return hex.slice(0, 12);
}

export function createFontPicker(opts: FontPickerOptions): HTMLElement {
  const { ctrl } = opts;
  let value: FontRef = opts.value;

  const summary = h('div', { class: 'font-picker-summary muted' });
  const warnBox = h('div');
  const body = h('div', { class: 'font-picker-body' });

  const sourceSelect = h('select', {
    on: {
      change: () => renderBody(sourceSelect.value as FontRef['kind']),
    },
  });
  for (const s of SOURCE_LABELS) sourceSelect.append(h('option', { value: s.kind }, s.label));
  sourceSelect.value = value.kind;

  function updateSummary(): void {
    const hash = 'sha256' in value ? shortHash(value.sha256) : '';
    replaceChildren(summary, `選択中: ${describeFont(value)}`, hash ? ` (sha256: ${hash})` : '');
  }

  async function emit(ref: FontRef): Promise<void> {
    value = ref;
    updateSummary();
    opts.onChange(ref);
    if (ref.kind === 'standard') {
      replaceChildren(warnBox);
      return;
    }
    try {
      const resolver = createFontResolver(ctrl);
      const resolved = await resolver.resolve(ref);
      const withSha = withHash(ref, resolved);
      value = withSha;
      updateSummary();
      opts.onChange(withSha);
      const warning = fontWarningMessage(resolved);
      replaceChildren(warnBox, warning ? h('div', { class: 'alert warn' }, warning) : null);
      await ctrl.log(EVENT_TYPES.fontSelected, {
        kind: ref.kind,
        name: describeFont(ref),
        sha256: resolved.sha256,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctrl.toast('err', `フォントの読み込みに失敗しました: ${msg}`);
    }
  }

  function renderStandard(): void {
    const select = h('select', {
      on: {
        change: () => void emit({ kind: 'standard', name: select.value as StandardFontName }),
      },
    });
    for (const name of STANDARD_FONT_NAMES) select.append(h('option', { value: name }, name));
    if (value.kind === 'standard') select.value = value.name;
    replaceChildren(body, select);
  }

  function renderLocal(): void {
    if (!isLocalFontAccessAvailable()) {
      const err = getLastLocalFontsError();
      replaceChildren(
        body,
        h(
          'div',
          { class: 'alert warn' },
          'このブラウザでは Local Font Access API が利用できません',
          err ? h('div', { class: 'muted' }, err) : null,
        ),
      );
      return;
    }

    let fonts: LocalFontInfo[] = [];
    const filterInput = h('input', {
      type: 'text',
      placeholder: 'フィルタ (family / fullName / postscriptName / style)',
      hidden: true,
    });
    const select = h('select', { size: 8, hidden: true, style: 'width:100%' });

    function renderOptions(): void {
      const q = filterInput.value.trim().toLowerCase();
      const filtered = q
        ? fonts.filter((f) =>
            [f.family, f.fullName, f.postscriptName, f.style].some((s) => s.toLowerCase().includes(q)),
          )
        : fonts;
      replaceChildren(
        select,
        filtered.slice(0, 500).map((f) => h('option', { value: f.postscriptName }, `${f.family} — ${f.style} (${f.postscriptName})`)),
      );
    }

    filterInput.addEventListener('input', renderOptions);
    select.addEventListener('change', () => {
      const f = fonts.find((x) => x.postscriptName === select.value);
      if (f) void emit({ kind: 'local', family: f.family, postscriptName: f.postscriptName, fullName: f.fullName, style: f.style });
    });

    const loadBtn = button('ローカルフォントを読み込む', () => {
      void (async () => {
        fonts = (await ctrl.run('ローカルフォントを読み込み', () => listLocalFonts())) ?? [];
        if (fonts.length === 0) {
          const err = getLastLocalFontsError();
          if (err) ctrl.toast('warn', err);
        }
        filterInput.hidden = false;
        select.hidden = false;
        renderOptions();
      })();
    });

    replaceChildren(body, h('div', { class: 'row' }, loadBtn), filterInput, select);
  }

  function renderWorkspace(): void {
    const ws = ctrl.state.workspace;
    if (!ws) {
      replaceChildren(body, h('div', { class: 'alert warn' }, 'Workspace が開かれていません'));
      return;
    }
    const select = h('select', {});
    select.append(h('option', { value: '' }, '読み込み中…'));
    replaceChildren(body, select);
    select.addEventListener('change', () => {
      if (select.value) void emit({ kind: 'workspace', path: select.value });
    });
    void listWorkspaceFonts(ws.fs, ws.config.directories.fonts).then((entries) => {
      if (entries.length === 0) {
        replaceChildren(select, h('option', { value: '' }, '(fonts/ にファイルがありません)'));
        return;
      }
      replaceChildren(select, entries.map((e) => h('option', { value: e.path }, e.path)));
      if (value.kind === 'workspace') select.value = value.path;
    });
  }

  function renderFile(): void {
    async function pick(): Promise<void> {
      try {
        const picked = await pickFontFile();
        pickedFontFiles.set(picked.name, picked.bytes);
        await emit({ kind: 'file', name: picked.name });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctrl.toast('warn', `フォントファイルを選択できませんでした: ${msg}`);
      }
    }
    const info = value.kind === 'file' ? h('div', { class: 'muted' }, `現在: ${value.name}`) : null;
    replaceChildren(body, button('フォントファイルを選択', () => void pick()), info);
  }

  function renderBody(kind: FontRef['kind']): void {
    switch (kind) {
      case 'standard':
        renderStandard();
        break;
      case 'local':
        renderLocal();
        break;
      case 'workspace':
        renderWorkspace();
        break;
      case 'file':
        renderFile();
        break;
    }
  }

  updateSummary();
  renderBody(value.kind);

  return h('div', { class: 'font-picker' }, summary, sourceSelect, body, warnBox);
}
