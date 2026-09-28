/**
 * PDF tab: the main working screen.
 *  - left sidebar: papers/ file list, stamp checklist, job info, generate actions
 *  - right main: PDF.js preview with a draggable stamp-position overlay
 *
 * Layout follows `docs/ARCHITECTURE.md` §1 (UI reads/writes only through
 * `AppController`) and reuses the pure geometry helpers from `stamps/` and
 * `pdf/stamper/measure` so the overlay matches what `applyStamps` will
 * actually draw.
 */
import type { PageSize, StampDefinition, StampPosition, StampsConfig } from '@/core/types';
import { checkStampCollision } from '@/preflight';
import { PdfRenderer, canvasToPdf, pdfToCanvas } from '@/pdf/renderer';
import { StampMetrics, measureLayers, type Box } from '@/pdf/stamper';
import { describeRange, sequenceItemFor } from '@/sequence';
import { describePageSelector, effectivePosition, invertStampOrigin, resolvePages, stampRect } from '@/stamps';
import { NEEDS_UPDATE_STATUSES, STATUS_LABEL, isUpToDate, type AppState, type FileStatus, type PdfFileItem } from '@/state/app';
import { createFontResolver, generateStampedPdf } from '@/state/generate';
import { isPreflightSkipped, setPreflightSkipped } from '@/state/preflightBatch';
import { basename } from '@/workspace';
import type { Section } from '../app';
import { splitGrid } from '../components/splitGrid';
import { button, formatBytes, h, iconButton, replaceChildren } from '../dom';
import { icon, type IconName } from '../icons';

const ZOOM_OPTIONS = [50, 75, 100, 150, 200];

/**
 * File list groups, in display order: work still to do first, files whose
 * output is current at the bottom (so the list reads as a to-do list).
 */
const FILE_GROUPS: { id: string; label: string; test: (s: FileStatus) => boolean }[] = [
  { id: 'update', label: '要更新', test: (s) => NEEDS_UPDATE_STATUSES.has(s) },
  { id: 'error', label: 'エラー', test: (s) => s === 'error' },
  { id: 'todo', label: '未処理', test: (s) => s === 'not-processed' },
  { id: 'done', label: '最新', test: isUpToDate },
];

/** Files that 全ファイルを処理 regenerates: everything not up to date (or everything, when forced). */
function filesToProcess(files: PdfFileItem[], all: boolean): PdfFileItem[] {
  return all ? files : files.filter((f) => !isUpToDate(f.status));
}

/**
 * The number a page-number stamp would show on physical page `page` of the
 * selected file: its continuous number when the file is in the sequence
 * (so the overlay is measured for e.g. `123`, not `1`), else the page itself.
 */
function displayedPageNumber(state: AppState, page: number): number {
  const item = state.selectedFile ? sequenceItemFor(state.sequence, state.selectedFile) : undefined;
  return item?.pageStart !== undefined ? item.pageStart + page - 1 : page;
}

export const pdfSection: Section = {
  id: 'pdf',
  title: 'PDF',
  fill: true,
  mount(root, ctrl) {
    // ---------------------------------------------------------- sidebar
    // The file list scrolls on its own so the whole tab fits in one screen.
    const filesHeader = h('div', { class: 'row', style: 'justify-content:space-between' });
    const filesScroll = h('div', { class: 'pdf-files-scroll' });
    const filesPanel = h('div', { class: 'panel pdf-files' }, filesHeader, filesScroll);
    const stampsPanel = h('div', { class: 'panel pdf-stamps' });
    const jobPanel = h('div', { class: 'panel' });
    const actionsPanel = h('div', { class: 'panel' });
    const sidebar = h('div', { class: 'pdf-sidebar' }, filesPanel, stampsPanel, jobPanel, actionsPanel);

    // ------------------------------------------------------------ main
    const pageInput = h('input', {
      type: 'number',
      min: '1',
      class: 'mono',
      style: { width: '64px' },
      on: {
        change: () => {
          const n = parseInt(pageInput.value, 10);
          if (Number.isFinite(n)) ctrl.setPage(n);
        },
      },
    });
    const pageCountLabel = h('span', { class: 'muted' }, '/ 0');
    const prevBtn = iconButton('chevron-left', '前のページ', () => ctrl.setPage(ctrl.state.currentPage - 1));
    const nextBtn = iconButton('chevron-right', '次のページ', () => ctrl.setPage(ctrl.state.currentPage + 1));

    const zoomSelect = h(
      'select',
      {
        on: {
          change: () => ctrl.setPrefs({ previewZoom: Number(zoomSelect.value) / 100 }),
        },
      },
      ZOOM_OPTIONS.map((z) => h('option', { value: String(z) }, `${z}%`)),
    );
    const fitBtn = button(
      'フィット',
      () => {
        if (!renderer || !lastPageSize) return;
        const pageSize = lastPageSize;
        const available = Math.max(80, previewWrap.clientWidth - 28);
        const zoom = Math.min(3, Math.max(0.25, available / pageSize.width));
        ctrl.setPrefs({ previewZoom: Math.round(zoom * 100) / 100 });
      },
      'btn btn-sm',
    );

    const overlayCheckbox = h('input', {
      type: 'checkbox',
      checked: true,
      on: {
        change: () => {
          showOverlay = overlayCheckbox.checked;
          drawOverlay(latestState);
        },
      },
    });

    const collisionBtn = button('衝突チェック', () => runCollisionCheck(), 'btn btn-sm');

    const toolbar = h(
      'div',
      { class: 'preview-toolbar' },
      prevBtn,
      h('span', null, pageInput, pageCountLabel),
      nextBtn,
      h('label', null, 'zoom ', zoomSelect),
      fitBtn,
      h('label', null, overlayCheckbox, ' スタンプ overlay'),
      collisionBtn,
    );

    const collisionMsg = h('div', { class: 'muted', style: { marginBottom: '8px' } });

    const canvasEl = h('canvas');
    const overlayLayer = h('div', { class: 'stamp-overlay-layer' });
    const previewPage = h('div', { class: 'preview-page', hidden: true }, canvasEl, overlayLayer);
    const placeholder = h('p', { class: 'muted' }, 'ファイルを選択してください');
    const previewWrap = h('div', { class: 'preview-wrap' }, placeholder, previewPage);

    const previewPanel = h('div', { class: 'panel pdf-preview' }, h('h2', null, 'Preview'), toolbar, collisionMsg, previewWrap);

    root.append(splitGrid(ctrl, sidebar, previewPanel, { key: 'pdf', initial: 0.32, class: 'fill-layout' }));

    // ------------------------------------------------------- render state
    let latestState: AppState = ctrl.state;
    let renderer: PdfRenderer | undefined;
    let rendererBytes: Uint8Array | undefined;
    let renderToken = 0;
    let lastScale = 1;
    let lastPageSize: PageSize | undefined;
    let showOverlay = true;
    let collidingIds = new Set<string>();
    /** Real font/image metrics for the overlay, per loaded workspace (a reload creates a fresh one). */
    let metrics: StampMetrics | undefined;
    let metricsWorkspaceFs: unknown;

    let lastFilesSnapshot: PdfFileItem[] | undefined;
    let lastSequenceRef: AppState['sequence'];
    let lastPreflightRef: unknown;
    let lastSelectedFile: string | undefined;
    let lastWorkspaceRef: AppState['workspace'];
    let lastStampsRef: StampsConfig | undefined;
    let lastRenderedPage = 0;
    let lastRenderedZoom = 0;

    /**
     * The box `applyStamps` will draw for `def`, measured with the real fonts
     * and image sizes once they are loaded (the heuristic estimate until then;
     * loading triggers a redraw).
     */
    function measureBox(state: AppState, def: StampDefinition, page: number, file: string | undefined): Box {
      const ws = state.workspace;
      if (ws && metricsWorkspaceFs !== ws.fs) {
        metricsWorkspaceFs = ws.fs;
        metrics = new StampMetrics({
          resolveFont: (ref) => createFontResolver(ctrl).resolve(ref),
          readImage: (src) => ws.fs.readBytes(src),
        });
      }
      const m = metrics;
      if (m && ws) {
        void m.prepare(ws.stamps.definitions).then((loaded) => {
          if (loaded && m === metrics) drawOverlay(latestState);
        });
      }
      return measureLayers(
        def.layers,
        { page: displayedPageNumber(state, page), pages: state.pageCount, file, fonts: m?.fonts, images: m?.images },
        def.layout,
      );
    }

    function setHasFile(has: boolean): void {
      previewPage.hidden = !has;
      placeholder.hidden = has;
    }

    function resetCollisions(): void {
      collidingIds = new Set();
      collisionMsg.textContent = '';
    }

    async function doRenderPage(state: AppState, token: number): Promise<void> {
      if (!renderer) return;
      const scale = state.prefs.previewZoom || 1;
      const page = Math.min(Math.max(1, state.currentPage), Math.max(1, renderer.pageCount));
      const result = await renderer.renderPage(page, canvasEl, { scale });
      if (token !== renderToken || !renderer) return; // superseded by a newer load/render
      lastScale = result.scale;
      lastPageSize = renderer.getPageSize(page);
      lastRenderedPage = page;
      lastRenderedZoom = scale;
      drawOverlay(state);
    }

    function triggerRender(state: AppState): void {
      if (!renderer) return;
      resetCollisions();
      const token = ++renderToken;
      void doRenderPage(state, token);
    }

    function scheduleLoad(bytes: Uint8Array | undefined): void {
      rendererBytes = bytes;
      const token = ++renderToken;
      const old = renderer;
      renderer = undefined;
      lastPageSize = undefined;
      resetCollisions();
      if (old) void old.destroy();
      if (!bytes) {
        setHasFile(false);
        return;
      }
      void (async () => {
        const r = new PdfRenderer(bytes);
        try {
          await r.load();
        } catch (e) {
          if (token === renderToken) {
            ctrl.toast('err', `PDF の読み込みに失敗しました: ${e instanceof Error ? e.message : String(e)}`);
          }
          return;
        }
        if (token !== renderToken) {
          void r.destroy();
          return;
        }
        renderer = r;
        ctrl.setPageCount(r.pageCount);
        setHasFile(true);
        triggerRender(ctrl.state);
      })();
    }

    function drawOverlay(state: AppState): void {
      const ws = state.workspace;
      if (!ws || !renderer || !lastPageSize) {
        replaceChildren(overlayLayer);
        return;
      }
      const pageSize = lastPageSize;
      const scale = lastScale;
      const page = state.currentPage;
      const file = state.selectedFile ? basename(state.selectedFile) : undefined;
      const divs: HTMLElement[] = [];

      if (showOverlay) {
        for (const inst of ws.stamps.instances) {
          const def = ws.stamps.definitions.find((d) => d.id === inst.stampId);
          if (!def) continue;
          const pages = resolvePages(inst.pages, state.pageCount);
          if (!pages.includes(page)) continue;

          const box = measureBox(state, def, page, file);
          const position = effectivePosition(def, inst);
          const rect = stampRect(position, pageSize, box);
          const topLeft = pdfToCanvas({ x: rect.x, y: rect.y + rect.height }, pageSize, scale);

          const cls = [
            'stamp-overlay',
            inst.enabled ? '' : 'disabled',
            collidingIds.has(inst.id) ? 'collides' : '',
          ]
            .filter(Boolean)
            .join(' ');

          const div = h(
            'div',
            {
              class: cls,
              style: {
                left: `${topLeft.x}px`,
                top: `${topLeft.y}px`,
                width: `${Math.max(1, rect.width * scale)}px`,
                height: `${Math.max(1, rect.height * scale)}px`,
              },
              title: describePageSelector(inst.pages),
            },
            def.name,
          );

          if (inst.enabled) attachDrag(div, inst.id, position, pageSize, scale, box);
          divs.push(div);
        }
      }
      replaceChildren(overlayLayer, divs);
    }

    /** Wire up pointer-drag repositioning for one overlay box, updating the instance's stored position on release. */
    function attachDrag(
      div: HTMLElement,
      instanceId: string,
      position: StampPosition,
      pageSize: PageSize,
      scale: number,
      box: { width: number; height: number },
    ): void {
      div.addEventListener('pointerdown', (ev: PointerEvent) => {
        ev.preventDefault();
        const startClientX = ev.clientX;
        const startClientY = ev.clientY;
        const startLeft = parseFloat(div.style.left) || 0;
        const startTop = parseFloat(div.style.top) || 0;
        let moved = 0;
        div.setPointerCapture(ev.pointerId);
        div.classList.add('dragging');

        const onMove = (mv: PointerEvent): void => {
          const dx = mv.clientX - startClientX;
          const dy = mv.clientY - startClientY;
          moved = Math.max(moved, Math.hypot(dx, dy));
          div.style.left = `${startLeft + dx}px`;
          div.style.top = `${startTop + dy}px`;
        };
        const onUp = (up: PointerEvent): void => {
          div.releasePointerCapture(up.pointerId);
          div.removeEventListener('pointermove', onMove);
          div.removeEventListener('pointerup', onUp);
          div.classList.remove('dragging');
          if (moved < 3) {
            // Not a real drag: snap back exactly (avoids drifting from rounding).
            div.style.left = `${startLeft}px`;
            div.style.top = `${startTop}px`;
            return;
          }
          const finalLeft = parseFloat(div.style.left) || 0;
          const finalTop = parseFloat(div.style.top) || 0;
          const topLeftPdf = canvasToPdf({ x: finalLeft, y: finalTop }, pageSize, scale);
          const newX = topLeftPdf.x;
          const newTopY = topLeftPdf.y; // pdf-space y of the box's *top* edge
          const newY = newTopY - box.height; // bottom-left y (Rect convention)

          let { offsetX, offsetY } = invertStampOrigin({ x: newX, y: newY }, position.anchor, pageSize, box);
          offsetX = Math.round(offsetX * 2) / 2;
          offsetY = Math.round(offsetY * 2) / 2;
          void ctrl.setInstancePosition(instanceId, { anchor: position.anchor, offsetX, offsetY });
        };
        div.addEventListener('pointermove', onMove);
        div.addEventListener('pointerup', onUp);
      });
    }

    function runCollisionCheck(): void {
      const state = latestState;
      const ws = state.workspace;
      if (!ws || !renderer || !lastPageSize) return;
      const pageSize = lastPageSize;
      const ctx = canvasEl.getContext('2d');
      if (!ctx) return;
      const imageData = ctx.getImageData(0, 0, canvasEl.width, canvasEl.height);
      const page = state.currentPage;
      const file = state.selectedFile ? basename(state.selectedFile) : undefined;
      const messages: string[] = [];
      collidingIds = new Set();

      for (const inst of ws.stamps.instances) {
        if (!inst.enabled) continue;
        const def = ws.stamps.definitions.find((d) => d.id === inst.stampId);
        if (!def) continue;
        const pages = resolvePages(inst.pages, state.pageCount);
        if (!pages.includes(page)) continue;
        const box = measureBox(state, def, page, file);
        const position = effectivePosition(def, inst);
        const rect = stampRect(position, pageSize, box);
        const result = checkStampCollision(imageData, pageSize, rect);
        if (result.collides) collidingIds.add(inst.id);
        messages.push(`${def.name}: ${result.message}`);
      }
      collisionMsg.textContent = messages.length ? messages.join(' ／ ') : '有効なスタンプがありません';
      drawOverlay(state);
    }

    // --------------------------------------------------------- sidebar UI

    function renderFiles(state: AppState): void {
      const ws = state.workspace;
      const groups = FILE_GROUPS.map((g) => ({ ...g, files: state.files.filter((f) => g.test(f.status)) }));
      replaceChildren(
        filesHeader,
        h('h2', null, 'PDF Files', ws && state.files.length ? h('span', { class: 'muted' }, ` (${state.files.length})`) : ''),
        ws ? button('再読み込み', () => void ctrl.refreshFiles(), 'btn btn-sm', 'refresh-cw') : '',
        ws && state.files.length
          ? h(
              'div',
              { class: 'file-counts' },
              groups.filter((g) => g.files.length).map((g) => h('span', { class: `file-count ${g.id}` }, `${g.label} ${g.files.length}`)),
            )
          : '',
      );
      // Within a group keep the numbering order (sequence), else name order.
      const orderIndex = new Map((state.sequence?.items ?? []).map((it, i) => [it.file, i]));
      const byOrder = (a: PdfFileItem, b: PdfFileItem): number =>
        (orderIndex.get(a.path) ?? Number.MAX_SAFE_INTEGER) - (orderIndex.get(b.path) ?? Number.MAX_SAFE_INTEGER);
      /** The output's file name, in gray after the source name (unless it is the same). */
      const outputNameHint = (path: string, name: string): HTMLElement | string => {
        const out = ctrl.outputPathFor(path);
        const outName = basename(out);
        return outName === name ? '' : h('span', { class: 'output-name', title: `出力: ${out}` }, outName);
      };
      const children: (HTMLElement | string)[] = [];
      if (!ws) {
        children.push(
          h('div', { class: 'alert warn' }, 'Workspace が開かれていません．Workspace タブでディレクトリを開いてください．'),
        );
      } else if (state.files.length === 0) {
        children.push(h('p', { class: 'muted' }, `${ws.config.directories.papers}/ に PDF を置いてください．`));
      } else {
        children.push(
          h(
            'ul',
            { class: 'list file-list' },
            groups.flatMap((g) => [
              g.files.length && groups.some((o) => o !== g && o.files.length)
                ? h('li', { class: `file-group ${g.id}`, attrs: { role: 'presentation' } }, `${g.label}（${g.files.length}）`)
                : '',
              ...[...g.files].sort(byOrder).map((f) => {
              const label = STATUS_LABEL[f.status];
              const range = sequenceItemFor(state.sequence, f.path);
              return h(
                'li',
                {
                  class: g.id === 'update' ? 'needs-update' : '',
                  dataset: { path: f.path },
                  attrs: { role: 'option', 'aria-selected': String(f.path === state.selectedFile) },
                  title: label.text,
                  on: { click: () => void ctrl.selectFile(f.path) },
                },
                h('span', { class: `status-icon ${label.cls}` }, icon(label.icon as IconName, { label: label.text })),
                h('span', { class: 'name' }, f.name, outputNameHint(f.path, f.name)),
                g.id === 'update' ? h('span', { class: 'update-chip' }, '要更新') : '',
                isPreflightSkipped(ws.preflight, f.path)
                  ? h('span', { class: 'skip-chip', title: 'Preflight の一括検査でスルーします（ジョブ情報で解除）' }, '検査スルー')
                  : '',
                range && !range.skipped && range.pageStart !== undefined
                  ? h('span', { class: 'muted mono', title: '通しページ番号（Sequence タブ）' }, describeRange(range))
                  : '',
                h('span', { class: 'muted' }, formatBytes(f.size)),
              );
              }),
            ]),
          ),
        );
      }
      // Rebuilding the list resets its scroll offset: keep it, and bring a
      // newly selected file into view.
      const scrollTop = filesScroll.scrollTop;
      replaceChildren(filesScroll, ...children);
      filesScroll.scrollTop = scrollTop;
      if (state.selectedFile !== lastSelectedFile) {
        const sel = [...filesScroll.querySelectorAll<HTMLElement>('li[data-path]')].find(
          (li) => li.dataset.path === state.selectedFile,
        );
        sel?.scrollIntoView({ block: 'nearest' });
      }
    }

    function renderStamps(state: AppState): void {
      const ws = state.workspace;
      const children: (HTMLElement | string)[] = [
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('h2', null, 'Stamps'),
          h(
            'a',
            {
              href: '#',
              on: {
                click: (ev) => {
                  ev.preventDefault();
                  ctrl.setPrefs({ lastTab: 'stamps' });
                },
              },
            },
            'Stamps タブで編集',
          ),
        ),
      ];
      if (!ws || ws.stamps.instances.length === 0) {
        children.push(h('p', { class: 'muted' }, 'スタンプがありません．'));
      } else {
        children.push(
          h(
            'ul',
            { class: 'list static' },
            ws.stamps.instances.map((inst) => {
              const def = ws.stamps.definitions.find((d) => d.id === inst.stampId);
              const checkbox = h('input', {
                type: 'checkbox',
                checked: inst.enabled,
                on: { change: () => void ctrl.setInstanceEnabled(inst.id, checkbox.checked) },
              });
              return h(
                'li',
                null,
                h(
                  'label',
                  { class: 'row', style: 'flex:1' },
                  checkbox,
                  h('span', { class: 'name' }, def?.name ?? inst.stampId),
                  inst.position
                    ? h('span', { class: 'muted', title: '独自の位置（ドラッグ等で設定）: 定義の既定位置より優先されます．Stamps タブで既定位置に戻せます' }, icon('pin', { label: '独自の位置' }))
                    : '',
                ),
                h('span', { class: 'muted' }, describePageSelector(inst.pages)),
              );
            }),
          ),
        );
      }
      replaceChildren(stampsPanel, ...children);
    }

    function renderJob(state: AppState): void {
      const ws = state.workspace;
      const file = state.files.find((f) => f.path === state.selectedFile);
      const children: (HTMLElement | string)[] = [h('h2', null, 'ジョブ情報')];
      if (!ws || !state.selectedFile) {
        children.push(h('p', { class: 'muted' }, 'ファイルを選択してください．'));
      } else {
        if (file?.status === 'source-changed') {
          children.push(h('div', { class: 'alert warn' }, icon('triangle-alert'), '元 PDF が前回処理時から変更されています'));
        }
        const job = file?.job;
        if (!job) {
          children.push(h('p', { class: 'muted' }, 'まだ処理されていません．'));
        } else {
          children.push(
            h(
              'table',
              null,
              h(
                'tbody',
                null,
                [
                  ['作成日時', job.createdAt],
                  ['出力', job.output],
                  ...(job.pageStart !== undefined && job.pageEnd !== undefined
                    ? [['通し番号', `p.${job.pageStart}–${job.pageEnd}`]]
                    : []),
                  ['ステータス', STATUS_LABEL[file?.status ?? 'processed'].text],
                ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, v)))),
              ),
            ),
          );
          if (job.message) children.push(h('pre', { class: 'muted' }, job.message));
        }
        const selected = state.selectedFile;
        const skipInput = h('input', {
          type: 'checkbox',
          checked: isPreflightSkipped(ws.preflight, selected),
          disabled: !!state.busy,
          on: {
            change: () =>
              void ctrl.run('検査スルーを変更', async () => {
                await setPreflightSkipped(ctrl, selected, skipInput.checked);
                ctrl.toast(
                  'info',
                  skipInput.checked
                    ? `${basename(selected)} を一括検査でスルーします`
                    : `${basename(selected)} のスルーを解除しました．Preflight タブで検査し直してください`,
                );
              }),
          },
        });
        children.push(
          h(
            'label',
            { class: 'row', title: '誤検出と分かっている PDF を Preflight の一括検査から外します（preflight.json の skipFiles）' },
            skipInput,
            'Preflight 検査スルー（誤検出）',
          ),
        );
      }
      replaceChildren(jobPanel, ...children);
    }

    /** "DRAFT（全ページ）" for each enabled / disabled placement, in stamps.json order. */
    function stampSummary(state: AppState): { enabled: string[]; disabled: string[] } {
      const ws = state.workspace;
      const enabled: string[] = [];
      const disabled: string[] = [];
      for (const inst of ws?.stamps.instances ?? []) {
        const name = ws?.stamps.definitions.find((d) => d.id === inst.stampId)?.name ?? inst.stampId;
        (inst.enabled ? enabled : disabled).push(`${name}（${describePageSelector(inst.pages)}）`);
      }
      return { enabled, disabled };
    }

    /** 全ファイルを処理 also regenerates up-to-date files (off: only what needs work). */
    let regenerateAll = false;

    async function runBatch(): Promise<void> {
      const paths = filesToProcess(ctrl.state.files, regenerateAll).map((f) => f.path);
      if (paths.length === 0) return;
      const skipped = ctrl.state.files.length - paths.length;
      const { enabled, disabled } = stampSummary(ctrl.state);
      // A full re-run starts from an empty output folder.
      const outputDir = ctrl.requireWorkspace().config.directories.output;
      const existing = regenerateAll ? await ctrl.countFilesIn(outputDir) : 0;
      const message =
        `${paths.length} 件の PDF に次のスタンプを付けて生成します${skipped ? `（最新の ${skipped} 件はそのまま）` : ''}．\n\n` +
        (existing ? `【注意】${outputDir}/ 内の既存のファイル ${existing} 件をすべて削除してから生成します．\n\n` : '') +
        `有効:\n${enabled.map((n) => `  ・${n}`).join('\n')}` +
        (disabled.length ? `\n\n無効（付きません）:\n${disabled.map((n) => `  ・${n}`).join('\n')}` : '') +
        '\n\nよろしいですか？';
      if (!confirm(message)) return;
      const label = '全ファイルを処理';
      await ctrl.runCancellable(label, async (signal) => {
        if (regenerateAll) await ctrl.clearGeneratedDir(outputDir);
        let done = 0;
        let warned = 0;
        let stopped = false;
        const failed: string[] = [];
        for (const [i, path] of paths.entries()) {
          if (signal.aborted) {
            stopped = true;
            break;
          }
          ctrl.setProgress({ label, done: i, total: paths.length });
          try {
            const res = await generateStampedPdf(ctrl, path);
            if (res) {
              done += 1;
              if (res.warnings.length) warned += 1;
              // A few per-file toasts; the rest are in each file's job info.
              if (warned <= 3) for (const w of res.warnings) ctrl.toast('warn', `${path}: ${w}`);
            }
          } catch (e) {
            failed.push(path);
            console.error('batch generate failed', path, e);
          }
        }
        if (stopped) {
          ctrl.toast('info', `全ファイルの処理を中止しました（${done}/${paths.length} 件を生成済み．残りは「更新が必要なファイルを処理」で続けられます）`, 10000);
          return;
        }
        ctrl.toast(
          failed.length ? 'warn' : 'ok',
          `${done} 件処理しました（警告 ${warned} 件${failed.length ? `／エラー ${failed.length} 件: ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? ' 他' : ''}` : ''}）`,
          10000,
        );
      });
    }

    function renderActions(state: AppState): void {
      const ws = state.workspace;
      const { enabled, disabled } = stampSummary(state);
      const hasEnabled = enabled.length > 0;
      const generateDisabled = !ws || !state.selectedFile || !hasEnabled || !!state.busy;
      const pending = filesToProcess(state.files, regenerateAll).length;
      const batchDisabled = !ws || pending === 0 || !hasEnabled || !!state.busy;

      const generateBtn = h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          disabled: generateDisabled,
          title: hasEnabled ? `付くスタンプ: ${enabled.join('，')}` : '有効なスタンプがありません',
          on: {
            click: () => {
              const path = state.selectedFile;
              if (!path) return;
              void ctrl.run('PDF を生成', () => generateStampedPdf(ctrl, path)).then((res) => {
                if (!res) return;
                ctrl.toast('ok', `${res.output} を生成しました`);
                for (const w of res.warnings) ctrl.toast('warn', w);
              });
            },
          },
        },
        'Generate PDF',
      );
      const batchBtn = button(
        regenerateAll ? `全ファイルを処理（${pending} 件）` : `更新が必要なファイルを処理（${pending} 件）`,
        () => void runBatch(),
        'btn',
        'refresh-cw',
      );
      batchBtn.disabled = batchDisabled;
      batchBtn.title = regenerateAll
        ? 'すべてのファイルを作り直します'
        : '未処理・要更新・エラーのファイルだけを生成します（最新のものはそのまま）';
      const allCheckbox = h('input', { type: 'checkbox', checked: regenerateAll, title: `オンにすると ${ws?.config.directories.output ?? 'output'}/ の既存ファイルをすべて削除してから作り直します` });
      allCheckbox.addEventListener('change', () => {
        regenerateAll = allCheckbox.checked;
        renderActions(ctrl.state);
      });
      const outputsBtn = button('出力フォルダ', () => void openOutputs(), 'btn', 'folder-open');
      outputsBtn.disabled = !ws;

      const p = state.progress;
      const pct = p ? Math.floor((p.done / Math.max(1, p.total)) * 100) : 0;
      replaceChildren(
        actionsPanel,
        ws
          ? h(
              'div',
              { class: 'stamp-summary' },
              hasEnabled
                ? h('div', null, h('strong', null, `付くスタンプ（${enabled.length}）: `), enabled.join('，'))
                : h('div', { class: 'alert warn' }, '有効なスタンプがありません．上の Stamps でチェックを入れてください．'),
              disabled.length ? h('div', { class: 'muted' }, `無効: ${disabled.join('，')}`) : '',
            )
          : '',
        p
          ? h(
              'div',
              { class: 'batch-progress' },
              h('progress', { max: p.total, value: p.done }),
              h('span', { class: 'mono' }, `${p.done}/${p.total}（${pct}%）`),
              state.cancel
                ? (() => {
                    const b = button(state.cancel.cancelling ? '中止しています…' : '中止', () => ctrl.cancelRunning(), 'btn btn-sm', 'x');
                    b.disabled = state.cancel.cancelling;
                    b.title = '処理中のファイルが終わったところで止めます（Esc）';
                    return b;
                  })()
                : '',
            )
          : '',
        h('div', { class: 'row' }, generateBtn, batchBtn, outputsBtn),
        ws ? h('label', { class: 'row muted settings-note', style: 'margin-top:6px' }, allCheckbox, 'すべて作り直す（出力フォルダを空にしてから）') : '',
      );
    }

    // ------------------------------------------------------ output folder

    const outputsDialog = h('dialog', { class: 'outputs-dialog' });
    root.append(outputsDialog);

    /** Open a workspace PDF in a new browser tab (a blob URL; nothing leaves the browser). */
    async function openInTab(path: string): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws) return;
      const bytes = await ws.fs.readBytes(path);
      const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/pdf' }));
      window.open(url, '_blank', 'noopener');
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }

    /**
     * Browsers cannot reveal a local folder in Finder/Explorer, so list
     * output/ here instead, each file openable in a new tab.
     */
    async function openOutputs(): Promise<void> {
      const ws = ctrl.state.workspace;
      if (!ws) return;
      const dir = ws.config.directories.output;
      const entries = await ws.fs.list(dir, { extensions: ['.pdf'] }).catch(() => []);
      const staleOutputs = new Map(
        ctrl.state.files.filter((f) => f.job && f.status !== 'processed' && f.status !== 'warning').map((f) => [f.job!.output, STATUS_LABEL[f.status].text]),
      );
      replaceChildren(
        outputsDialog,
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('h2', null, `${dir}/（${entries.length} 件）`),
          button('閉じる', () => outputsDialog.close(), 'btn btn-sm'),
        ),
        h(
          'p',
          { class: 'muted settings-note' },
          `ブラウザからは Finder / エクスプローラでフォルダを開けないため，一覧から開きます．フォルダの場所: Workspace「${ws.config.name}」内の ${dir}/`,
        ),
        entries.length
          ? h(
              'ul',
              { class: 'list outputs-list' },
              [...entries]
                .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
                .map((e) =>
                  h(
                    'li',
                    { on: { click: () => void openInTab(e.path) }, title: 'クリックで新しいタブに開く' },
                    h('span', { class: 'name' }, e.name),
                    staleOutputs.has(e.path) ? h('span', { class: 'badge warn', title: staleOutputs.get(e.path) }, '古い') : '',
                    h('span', { class: 'muted' }, new Date(e.lastModified).toLocaleString()),
                    h('span', { class: 'muted' }, formatBytes(e.size)),
                  ),
                ),
            )
          : h('p', { class: 'muted' }, 'まだ出力はありません．'),
      );
      if (!outputsDialog.open) outputsDialog.showModal();
    }

    function syncToolbar(state: AppState): void {
      if (document.activeElement !== pageInput) pageInput.value = String(state.currentPage);
      pageCountLabel.textContent = `/ ${state.pageCount}`;
      prevBtn.disabled = state.currentPage <= 1;
      nextBtn.disabled = state.currentPage >= Math.max(1, state.pageCount);
      const zoomPct = String(Math.round((state.prefs.previewZoom || 1) * 100));
      if (document.activeElement !== zoomSelect) zoomSelect.value = zoomPct;
      const disablePreviewControls = !state.workspace || !state.selectedFile;
      for (const el of [prevBtn, nextBtn, pageInput, zoomSelect, fitBtn, overlayCheckbox, collisionBtn]) {
        (el as HTMLButtonElement | HTMLInputElement | HTMLSelectElement).disabled = disablePreviewControls;
      }
    }

    return (state) => {
      latestState = state;

      const filesChanged =
        state.files !== lastFilesSnapshot ||
        state.selectedFile !== lastSelectedFile ||
        state.workspace !== lastWorkspaceRef ||
        state.sequence !== lastSequenceRef ||
        state.workspace?.preflight !== lastPreflightRef;
      if (filesChanged) {
        lastPreflightRef = state.workspace?.preflight;
        renderFiles(state);
        lastFilesSnapshot = state.files;
        lastSelectedFile = state.selectedFile;
        lastSequenceRef = state.sequence;
      }
      lastWorkspaceRef = state.workspace;

      const stampsRef = state.workspace?.stamps;
      if (stampsRef !== lastStampsRef) {
        renderStamps(state);
        drawOverlay(state);
        lastStampsRef = stampsRef;
      }

      renderJob(state);
      renderActions(state);
      syncToolbar(state);

      if (state.selectedBytes !== rendererBytes) {
        scheduleLoad(state.selectedBytes);
      } else if (renderer) {
        const zoom = state.prefs.previewZoom || 1;
        if (state.currentPage !== lastRenderedPage || zoom !== lastRenderedZoom) {
          lastRenderedPage = state.currentPage;
          lastRenderedZoom = zoom;
          triggerRender(state);
        }
      }
    };
  },
};
