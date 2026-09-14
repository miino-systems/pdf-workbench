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
import type { PageSize, StampPosition, StampsConfig } from '@/core/types';
import { checkStampCollision } from '@/preflight';
import { PdfRenderer, canvasToPdf, pdfToCanvas } from '@/pdf/renderer';
import { estimateStampBox } from '@/pdf/stamper/measure';
import { describePageSelector, effectivePosition, resolvePages, stampRect } from '@/stamps';
import { STATUS_LABEL, type AppState, type PdfFileItem } from '@/state/app';
import { generateStampedPdf } from '@/state/generate';
import { basename } from '@/workspace';
import type { Section } from '../app';
import { button, formatBytes, h, replaceChildren } from '../dom';

const ZOOM_OPTIONS = [50, 75, 100, 150, 200];

export const pdfSection: Section = {
  id: 'pdf',
  title: 'PDF',
  mount(root, ctrl) {
    // ---------------------------------------------------------- sidebar
    const filesPanel = h('div', { class: 'panel' });
    const stampsPanel = h('div', { class: 'panel' });
    const jobPanel = h('div', { class: 'panel' });
    const actionsPanel = h('div', { class: 'panel' });
    const sidebar = h('div', null, filesPanel, stampsPanel, jobPanel, actionsPanel);

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
    const prevBtn = button('◀', () => ctrl.setPage(ctrl.state.currentPage - 1), 'btn btn-sm');
    const nextBtn = button('▶', () => ctrl.setPage(ctrl.state.currentPage + 1), 'btn btn-sm');

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

    const previewPanel = h('div', { class: 'panel' }, h('h2', null, 'Preview'), toolbar, collisionMsg, previewWrap);

    root.append(h('div', { class: 'grid grid-sidebar' }, sidebar, previewPanel));

    // ------------------------------------------------------- render state
    let latestState: AppState = ctrl.state;
    let renderer: PdfRenderer | undefined;
    let rendererBytes: Uint8Array | undefined;
    let renderToken = 0;
    let lastScale = 1;
    let lastPageSize: PageSize | undefined;
    let showOverlay = true;
    let collidingIds = new Set<string>();

    let lastFilesSnapshot: PdfFileItem[] | undefined;
    let lastSelectedFile: string | undefined;
    let lastWorkspaceRef: AppState['workspace'];
    let lastStampsRef: StampsConfig | undefined;
    let lastRenderedPage = 0;
    let lastRenderedZoom = 0;

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

          const box = estimateStampBox(def, { page, pages: state.pageCount, file });
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

          const [vAnchor, hAnchor] = position.anchor.split('-') as [string, string];
          let offsetX: number;
          switch (hAnchor) {
            case 'left':
              offsetX = newX;
              break;
            case 'right':
              offsetX = pageSize.width - newX - box.width;
              break;
            default: // center
              offsetX = newX - (pageSize.width - box.width) / 2;
          }
          let offsetY: number;
          switch (vAnchor) {
            case 'top':
              offsetY = pageSize.height - newY - box.height;
              break;
            case 'bottom':
              offsetY = newY;
              break;
            default: // middle
              offsetY = newY - (pageSize.height - box.height) / 2;
          }
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
        const box = estimateStampBox(def, { page, pages: state.pageCount, file });
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
      const children: (HTMLElement | string)[] = [
        h(
          'div',
          { class: 'row', style: 'justify-content:space-between' },
          h('h2', null, 'PDF Files'),
          ws ? button('🔄 再読み込み', () => void ctrl.refreshFiles(), 'btn btn-sm') : '',
        ),
      ];
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
            { class: 'list' },
            state.files.map((f) => {
              const label = STATUS_LABEL[f.status];
              return h(
                'li',
                {
                  attrs: { role: 'option', 'aria-selected': String(f.path === state.selectedFile) },
                  title: label.text,
                  on: { click: () => void ctrl.selectFile(f.path) },
                },
                h('span', { class: `badge ${label.cls}` }, label.icon),
                h('span', { class: 'name' }, f.name),
                h('span', { class: 'muted' }, formatBytes(f.size)),
              );
            }),
          ),
        );
      }
      replaceChildren(filesPanel, ...children);
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
                h('label', { class: 'row', style: 'flex:1' }, checkbox, h('span', { class: 'name' }, def?.name ?? inst.stampId)),
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
          children.push(h('div', { class: 'alert warn' }, '⚠ 元 PDF が前回処理時から変更されています'));
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
                  ['ステータス', STATUS_LABEL[file?.status ?? 'processed'].text],
                ].map(([k, v]) => h('tr', null, h('th', null, k), h('td', null, h('code', null, v)))),
              ),
            ),
          );
          if (job.message) children.push(h('pre', { class: 'muted' }, job.message));
        }
      }
      replaceChildren(jobPanel, ...children);
    }

    function renderActions(state: AppState): void {
      const ws = state.workspace;
      const hasEnabled = ws?.stamps.instances.some((i) => i.enabled) ?? false;
      const generateDisabled = !ws || !state.selectedFile || !hasEnabled || !!state.busy;
      const batchDisabled = !ws || state.files.length === 0 || !hasEnabled || !!state.busy;

      const generateBtn = h(
        'button',
        {
          class: 'btn btn-primary',
          type: 'button',
          disabled: generateDisabled,
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

      const batchBtn = h(
        'button',
        {
          class: 'btn',
          type: 'button',
          disabled: batchDisabled,
          on: {
            click: () => {
              const paths = ctrl.state.files.map((f) => f.path);
              void ctrl.run('全ファイルを処理', async () => {
                let done = 0;
                let warned = 0;
                let failed = 0;
                for (const path of paths) {
                  try {
                    const res = await generateStampedPdf(ctrl, path);
                    if (res) {
                      done += 1;
                      if (res.warnings.length) warned += 1;
                      for (const w of res.warnings) ctrl.toast('warn', `${path}: ${w}`);
                    }
                  } catch (e) {
                    failed += 1;
                    console.error('batch generate failed', path, e);
                  }
                }
                ctrl.toast(
                  failed ? 'warn' : 'ok',
                  `${done} 件処理しました（警告 ${warned} 件${failed ? `／エラー ${failed} 件` : ''}）`,
                );
              });
            },
          },
        },
        '全ファイルを処理',
      );

      replaceChildren(actionsPanel, h('div', { class: 'row' }, generateBtn, batchBtn));
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
        state.files !== lastFilesSnapshot || state.selectedFile !== lastSelectedFile || state.workspace !== lastWorkspaceRef;
      if (filesChanged) {
        renderFiles(state);
        lastFilesSnapshot = state.files;
        lastSelectedFile = state.selectedFile;
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
