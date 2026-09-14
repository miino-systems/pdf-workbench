/**
 * Settings tab: UI preferences (localStorage only), workspace settings
 * (`.pdf-workbench/workspace.json`), the Phase 3 PDF→PNG/JPEG converter,
 * and a restatement of the privacy notice / data-storage map.
 */
import type { WorkspaceConfig } from '@/core/types';
import { DPI_PRESETS, convertPdfToImages, type ImageFormat } from '@/pdf/converter';
import { parsePageList, resolvePages } from '@/stamps';
import type { AppState } from '@/state/app';
import type { DisplayUnit, Theme } from '@/state/prefs';
import { basename, stripExtension } from '@/workspace';
import { PRIVACY_NOTICE, type Section } from '../app';
import { h, replaceChildren } from '../dom';

export const settingsSection: Section = {
  id: 'settings',
  title: 'Settings',
  mount(root, ctrl) {
    // -------------------------------------------------------- UI prefs
    const themeSelect = h(
      'select',
      { on: { change: () => ctrl.setPrefs({ theme: themeSelect.value as Theme }) } },
      h('option', { value: 'system' }, 'system'),
      h('option', { value: 'light' }, 'light'),
      h('option', { value: 'dark' }, 'dark'),
    );
    const unitSelect = h(
      'select',
      { on: { change: () => ctrl.setPrefs({ unit: unitSelect.value as DisplayUnit }) } },
      h('option', { value: 'mm' }, 'mm'),
      h('option', { value: 'pt' }, 'pt'),
    );
    const dpiSelect = h(
      'select',
      { on: { change: () => ctrl.setPrefs({ defaultDpi: Number(dpiSelect.value) }) } },
      [150, 300, 600].map((d) => h('option', { value: String(d) }, String(d))),
    );
    const uiPrefsPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'UI 設定'),
      h('p', { class: 'muted settings-note' }, 'この設定はブラウザの localStorage にのみ保存されます．Workspace には保存されません．'),
      h('div', { class: 'field' }, h('span', null, 'テーマ'), themeSelect),
      h('div', { class: 'field' }, h('span', null, '表示単位'), unitSelect),
      h('div', { class: 'field' }, h('span', null, 'デフォルト DPI'), dpiSelect),
    );

    // ---------------------------------------------------- workspace settings
    const nameInput = h('input', {
      type: 'text',
      on: { change: () => void commitWorkspaceConfig() },
    });
    const suffixInput = h('input', {
      type: 'text',
      on: { change: () => void commitWorkspaceConfig() },
    });
    const hashChainCheckbox = h('input', {
      type: 'checkbox',
      on: { change: () => void commitWorkspaceConfig() },
    });
    const directoriesTable = h('table');
    const wsPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Workspace 設定'),
      h('div', { class: 'field' }, h('span', null, '名前'), nameInput),
      h('div', { class: 'field' }, h('span', null, '出力ファイル名の接尾辞'), suffixInput),
      h('label', { class: 'row' }, hashChainCheckbox, ' events.jsonl に hash chain を付与（改変検知）'),
      h('h3', null, 'ディレクトリ（読み取り専用）'),
      directoriesTable,
    );

    async function commitWorkspaceConfig(): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws) return;
      const config: WorkspaceConfig = {
        ...ws.config,
        name: nameInput.value.trim() || ws.config.name,
        output: { ...ws.config.output, suffix: suffixInput.value },
        history: { ...ws.config.history, hashChain: hashChainCheckbox.checked },
      };
      await ctrl.updateWorkspaceConfig(config);
    }

    // ---------------------------------------------------- PDF -> PNG/JPEG
    const formatSelect = h('select', null, h('option', { value: 'png' }, 'PNG'), h('option', { value: 'jpeg' }, 'JPEG'));
    const convDpiSelect = h(
      'select',
      null,
      DPI_PRESETS.map((d) => h('option', { value: String(d) }, String(d))),
    );
    convDpiSelect.value = String(ctrl.state.prefs.defaultDpi);
    const pagesInput = h('input', { type: 'text', placeholder: '空欄 = 全ページ（例: 1,3-5）' });
    const qualityInput = h('input', { type: 'number', min: '0', max: '1', step: '0.05', value: '0.85' });
    const qualityField = h('div', { class: 'field' }, h('span', null, 'JPEG quality (0–1)'), qualityInput);
    qualityField.hidden = true;
    formatSelect.addEventListener('change', () => {
      qualityField.hidden = formatSelect.value !== 'jpeg';
    });
    const convertHint = h('p', { class: 'muted' }, 'PDF タブでファイルを選択してください．');
    const convertProgress = h('span', { class: 'muted' });
    const convertBtn = h(
      'button',
      { class: 'btn btn-primary', type: 'button', on: { click: () => void runConvert() } },
      '変換して preview/ に保存',
    );

    async function runConvert(): Promise<void> {
      const state = ctrl.state;
      const ws = state.workspace;
      if (!ws || !state.selectedFile || !state.selectedBytes) return;
      const format = formatSelect.value as ImageFormat;
      const dpi = Number(convDpiSelect.value);
      const pagesText = pagesInput.value.trim();
      const pages = pagesText ? resolvePages(parsePageList(pagesText, state.pageCount), state.pageCount) : undefined;
      const quality = format === 'jpeg' ? Number(qualityInput.value) : undefined;
      const baseName = stripExtension(basename(state.selectedFile));
      const sourceBytes = state.selectedBytes;
      const sourcePath = state.selectedFile;
      const total = pages ? pages.length : state.pageCount;

      await ctrl.run('PDF を画像に変換', async () => {
        let n = 0;
        convertProgress.textContent = `0 / ${total}`;
        for await (const img of convertPdfToImages(sourceBytes, { format, dpi, pages, quality, baseName })) {
          const bytes = new Uint8Array(await img.blob.arrayBuffer());
          await ws.fs.writeBytes(`${ws.config.directories.preview}/${img.fileName}`, bytes);
          n += 1;
          convertProgress.textContent = `${n} / ${total}`;
        }
        await ctrl.log('pdf.converted', { source: sourcePath, format, dpi, pages: n });
        ctrl.toast('ok', `${n} 件の画像を ${ws.config.directories.preview}/ に保存しました`);
      });
      convertProgress.textContent = '';
    }

    const convertPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'PDF → PNG / JPEG'),
      h('p', { class: 'muted settings-note' }, 'Phase 3 機能．選択中の PDF を preview/ にラスタライズします．'),
      convertHint,
      h(
        'div',
        { class: 'row' },
        h('div', { class: 'field' }, h('span', null, '形式'), formatSelect),
        h('div', { class: 'field' }, h('span', null, 'DPI'), convDpiSelect),
        h('div', { class: 'field', style: 'flex:1;min-width:180px' }, h('span', null, 'ページ'), pagesInput),
      ),
      qualityField,
      h('div', { class: 'row' }, convertBtn, convertProgress),
    );

    // -------------------------------------------------------------- privacy
    const privacyPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'プライバシー'),
      h('p', null, '🔒 ', PRIVACY_NOTICE),
      h(
        'table',
        null,
        h(
          'tbody',
          null,
          [
            ['localStorage', 'UI 設定（テーマ・表示単位・デフォルト DPI・最後に開いたタブなど）のみ'],
            ['IndexedDB', '最近使った Workspace のディレクトリハンドル（再オープン用）のみ'],
            ['Workspace（ローカルディスク）', 'PDF・画像・フォント・スタンプ定義・ジョブ履歴・イベントログなど，それ以外すべて'],
            ['ネットワーク', '送信なし．アプリはバンドルされたコードのみで動作します．'],
          ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, v))),
        ),
      ),
    );

    root.append(
      h('div', { class: 'grid grid-2' }, h('div', null, uiPrefsPanel, wsPanel), h('div', null, convertPanel, privacyPanel)),
    );

    let lastConfigRef: WorkspaceConfig | undefined;

    function renderDirectories(config: WorkspaceConfig): void {
      const d = config.directories;
      replaceChildren(
        directoriesTable,
        h(
          'tbody',
          null,
          [
            ['papers', d.papers],
            ['output', d.output],
            ['preview', d.preview],
            ['assets', d.assets],
            ['fonts', d.fonts],
          ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, `${v}/`)))),
        ),
      );
    }

    return (state: AppState) => {
      // UI prefs: always cheap to sync (select elements, no risk of clobbering typed text).
      if (document.activeElement !== themeSelect) themeSelect.value = state.prefs.theme;
      if (document.activeElement !== unitSelect) unitSelect.value = state.prefs.unit;
      if (document.activeElement !== dpiSelect) dpiSelect.value = String(state.prefs.defaultDpi);

      const ws = state.workspace;
      const disabled = !ws;
      nameInput.disabled = disabled;
      suffixInput.disabled = disabled;
      hashChainCheckbox.disabled = disabled;

      if (ws && ws.config !== lastConfigRef) {
        if (document.activeElement !== nameInput) nameInput.value = ws.config.name;
        if (document.activeElement !== suffixInput) suffixInput.value = ws.config.output.suffix;
        hashChainCheckbox.checked = ws.config.history.hashChain;
        renderDirectories(ws.config);
        lastConfigRef = ws.config;
      } else if (!ws) {
        replaceChildren(directoriesTable);
        lastConfigRef = undefined;
      }

      const canConvert = !!ws && !!state.selectedFile && !!state.selectedBytes && !state.busy;
      convertBtn.disabled = !canConvert;
      convertHint.hidden = !!state.selectedFile;
    };
  },
};
