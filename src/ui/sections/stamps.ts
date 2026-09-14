/**
 * Stamps tab: manage `StampDefinition`s (templates with text/image/pageNumber
 * layers, a default position and default pages) and the `StampInstance`s
 * that place them (enabled flag, page selection, optional position override).
 *
 * Editing keeps a local "draft" copy of whichever definition/instance is
 * selected so that continuous typing never gets interrupted by a full DOM
 * rebuild: the editor form is rebuilt only when the selection changes or the
 * underlying `stamps.json` changed from outside (e.g. `generate.ts` filling
 * in a font's sha256 after a run). Field edits mutate the draft in place and
 * schedule a 400ms-debounced save via `ctrl.updateDefinition` /
 * `ctrl.setInstancePages` / `ctrl.setInstancePosition`.
 */
import type {
  FontRef,
  ImageLayer,
  PageNumberLayer,
  PageSelector,
  StampAnchor,
  StampDefinition,
  StampInstance,
  StampLayer,
  StampPosition,
  TextLayer,
} from '@/core/types';
import { STAMP_ANCHORS } from '@/core/types';
import { mmToPt, ptToMm, round } from '@/core/units';
import { EVENT_TYPES } from '@/history';
import {
  BUILTIN_STAMP_TEMPLATES,
  DEFAULT_STAMP_POSITION,
  createId,
  createInstanceFromDefinition,
  describePageSelector,
  effectivePosition,
  isValidHexColor,
  parsePageList,
  validateStampsConfig,
} from '@/stamps';
import type { AppController, AppState } from '@/state/app';
import type { Section } from '../app';
import { createFontPicker } from '../components/fontPicker';
import { button, h, replaceChildren } from '../dom';

const LAYER_TYPE_LABELS: Record<string, string> = {
  text: 'テキスト',
  image: '画像',
  pageNumber: 'ページ番号',
  line: '線（未対応）',
  rectangle: '矩形（未対応）',
  qrcode: 'QRコード（未対応）',
  dynamicText: '動的テキスト（未対応）',
};

const ANCHOR_LABELS: Record<StampAnchor, string> = {
  'top-left': '左上',
  'top-center': '上',
  'top-right': '右上',
  'middle-left': '左',
  'middle-center': '中央',
  'middle-right': '右',
  'bottom-left': '左下',
  'bottom-center': '下',
  'bottom-right': '右下',
};

// ------------------------------------------------------------------ utils

/** A debounced function that can also be flushed: run its pending call (if any) immediately. */
type Debounced<Args extends unknown[]> = ((...args: Args) => void) & { flush: () => void };

function debounce<Args extends unknown[]>(fn: (...args: Args) => void, ms: number): Debounced<Args> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pendingArgs: Args | undefined;
  const debounced = ((...args: Args) => {
    pendingArgs = args;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      const toRun = pendingArgs;
      pendingArgs = undefined;
      if (toRun) fn(...toRun);
    }, ms);
  }) as Debounced<Args>;
  debounced.flush = () => {
    if (timer === undefined) return;
    clearTimeout(timer);
    timer = undefined;
    const toRun = pendingArgs;
    pendingArgs = undefined;
    if (toRun) fn(...toRun);
  };
  return debounced;
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'field' }, h('span', null, label), control);
}

function numberInput(value: number, onChange: (n: number) => void, opts: { step?: number; min?: number } = {}): HTMLInputElement {
  const inp = h('input', { type: 'number', value: String(value), step: String(opts.step ?? 1) });
  if (opts.min !== undefined) inp.min = String(opts.min);
  inp.addEventListener('input', () => {
    const n = parseFloat(inp.value);
    if (!Number.isNaN(n)) onChange(n);
  });
  return inp;
}

/** Number input that allows an empty value ("blank" = natural size / default). */
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

function describePosition(pos: StampPosition): string {
  return `${ANCHOR_LABELS[pos.anchor]} (${round(pos.offsetX, 1)}, ${round(pos.offsetY, 1)} pt)`;
}

function colorField(layer: TextLayer | PageNumberLayer, scheduleSave: () => void): HTMLElement {
  const safe = isValidHexColor(layer.color) && layer.color.length === 7 ? layer.color : '#000000';
  const colorInput = h('input', { type: 'color', value: safe });
  const hexInput = h('input', { type: 'text', value: layer.color, style: 'width:90px' });
  colorInput.addEventListener('input', () => {
    layer.color = colorInput.value;
    hexInput.value = colorInput.value;
    scheduleSave();
  });
  hexInput.addEventListener('input', () => {
    layer.color = hexInput.value;
    if (isValidHexColor(hexInput.value) && hexInput.value.length === 7) colorInput.value = hexInput.value;
    scheduleSave();
  });
  return h('div', { class: 'row' }, colorInput, hexInput);
}

// ---------------------------------------------------------- shared editors

/** 3x3 anchor grid + offsetX/offsetY (shown in the current display unit) + unit toggle. */
function createPositionEditor(ctrl: AppController, initial: StampPosition, onChange: (pos: StampPosition) => void): HTMLElement {
  let pos: StampPosition = { ...initial };
  let unit = ctrl.state.prefs.unit;

  const grid = h('div', { class: 'anchor-grid' });
  const anchorButtons = new Map<StampAnchor, HTMLButtonElement>();
  for (const a of STAMP_ANCHORS) {
    const btn = button(
      ANCHOR_LABELS[a],
      () => {
        pos = { ...pos, anchor: a };
        refreshAnchors();
        onChange({ ...pos });
      },
      'btn btn-sm anchor-btn',
    );
    anchorButtons.set(a, btn);
    grid.append(btn);
  }
  function refreshAnchors(): void {
    for (const [a, btn] of anchorButtons) btn.classList.toggle('active', a === pos.anchor);
  }

  const xInput = h('input', { type: 'number', step: '0.1' });
  const yInput = h('input', { type: 'number', step: '0.1' });
  const unitLabel = h('span', { class: 'muted' });

  const toDisplay = (pt: number): number => round(unit === 'mm' ? ptToMm(pt) : pt, 2);
  const toPtValue = (display: number): number => (unit === 'mm' ? mmToPt(display) : display);

  function syncInputs(): void {
    xInput.value = String(toDisplay(pos.offsetX));
    yInput.value = String(toDisplay(pos.offsetY));
    unitLabel.textContent = `単位: ${unit}`;
  }
  xInput.addEventListener('input', () => {
    const n = parseFloat(xInput.value);
    if (!Number.isNaN(n)) {
      pos = { ...pos, offsetX: toPtValue(n) };
      onChange({ ...pos });
    }
  });
  yInput.addEventListener('input', () => {
    const n = parseFloat(yInput.value);
    if (!Number.isNaN(n)) {
      pos = { ...pos, offsetY: toPtValue(n) };
      onChange({ ...pos });
    }
  });

  const toggleBtn = button(
    '単位: mm / pt',
    () => {
      unit = unit === 'mm' ? 'pt' : 'mm';
      ctrl.setPrefs({ unit });
      syncInputs();
    },
    'btn btn-sm',
  );

  refreshAnchors();
  syncInputs();

  return h(
    'div',
    { class: 'position-editor' },
    grid,
    h('div', { class: 'row' }, field('X offset', xInput), field('Y offset', yInput), toggleBtn, unitLabel),
  );
}

/** all / first / last / odd / even / range(from,to) / list(text, parsed via parsePageList). */
function createPageSelectorEditor(initial: PageSelector, onChange: (sel: PageSelector) => void): HTMLElement {
  let current: PageSelector = initial;
  const select = h('select', {});
  const kinds: { value: PageSelector['kind']; label: string }[] = [
    { value: 'all', label: '全ページ' },
    { value: 'first', label: '先頭ページ' },
    { value: 'last', label: '最終ページ' },
    { value: 'odd', label: '奇数ページ' },
    { value: 'even', label: '偶数ページ' },
    { value: 'range', label: '範囲' },
    { value: 'list', label: 'リスト' },
  ];
  for (const k of kinds) select.append(h('option', { value: k.value }, k.label));
  select.value = current.kind;

  const fromInput = h('input', { type: 'number', min: '1' });
  const toInput = h('input', { type: 'number', min: '1' });
  const rangeRow = h('div', { class: 'row' }, field('from', fromInput), field('to', toInput));

  const listInput = h('input', { type: 'text', placeholder: '例: 1,3-5,8' });
  const listRow = h('div', { class: 'field' }, h('span', null, 'ページリスト'), listInput);

  if (current.kind === 'range') {
    fromInput.value = String(current.from);
    toInput.value = String(current.to);
  }
  if (current.kind === 'list') {
    listInput.value = current.pages.join(',');
  }

  function syncVisibility(): void {
    rangeRow.hidden = current.kind !== 'range';
    listRow.hidden = current.kind !== 'list';
  }
  syncVisibility();

  select.addEventListener('change', () => {
    const kind = select.value as PageSelector['kind'];
    switch (kind) {
      case 'all':
        current = { kind: 'all' };
        break;
      case 'first':
        current = { kind: 'first' };
        break;
      case 'last':
        current = { kind: 'last' };
        break;
      case 'odd':
        current = { kind: 'odd' };
        break;
      case 'even':
        current = { kind: 'even' };
        break;
      case 'range':
        current = { kind: 'range', from: Number(fromInput.value) || 1, to: Number(toInput.value) || 1 };
        fromInput.value = String(current.from);
        toInput.value = String(current.to);
        break;
      case 'list':
        current = parsePageList(listInput.value);
        break;
    }
    syncVisibility();
    onChange(current);
  });

  const debouncedRangeChange = debounce(() => {
    if (current.kind !== 'range') return;
    current = { kind: 'range', from: Number(fromInput.value) || 1, to: Number(toInput.value) || 1 };
    onChange(current);
  }, 400);
  fromInput.addEventListener('input', debouncedRangeChange);
  toInput.addEventListener('input', debouncedRangeChange);

  const debouncedListChange = debounce(() => {
    current = parsePageList(listInput.value);
    onChange(current);
  }, 400);
  listInput.addEventListener('input', debouncedListChange);

  return h('div', null, select, rangeRow, listRow);
}

// ------------------------------------------------------------- layer edit

function newLayer(type: 'text' | 'image' | 'pageNumber'): StampLayer {
  const id = createId('layer');
  switch (type) {
    case 'text':
      return { id, type: 'text', text: '', font: { kind: 'standard', name: 'Helvetica' }, size: 12, color: '#000000' };
    case 'image':
      return { id, type: 'image', src: '' };
    case 'pageNumber':
      return {
        id,
        type: 'pageNumber',
        template: '{page} / {pages}',
        font: { kind: 'standard', name: 'Helvetica' },
        size: 10,
        color: '#000000',
      };
  }
}

function buildTextFields(ctrl: AppController, layer: TextLayer, scheduleSave: () => void): HTMLElement {
  const textArea = h('textarea', { value: layer.text });
  textArea.addEventListener('input', () => {
    layer.text = textArea.value;
    scheduleSave();
  });

  const fontPicker = createFontPicker({
    ctrl,
    value: layer.font,
    onChange: (ref: FontRef) => {
      layer.font = ref;
      scheduleSave();
    },
  });

  const sizeInput = numberInput(
    layer.size,
    (n) => {
      layer.size = n;
      scheduleSave();
    },
    { step: 1, min: 1 },
  );
  const colorRow = colorField(layer, scheduleSave);

  const opacityInput = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(layer.opacity ?? 1) });
  const opacityLabel = h('span', { class: 'muted' }, String(layer.opacity ?? 1));
  opacityInput.addEventListener('input', () => {
    layer.opacity = parseFloat(opacityInput.value);
    opacityLabel.textContent = opacityInput.value;
    scheduleSave();
  });

  const rotateInput = numberInput(layer.rotate ?? 0, (n) => {
    layer.rotate = n;
    scheduleSave();
  });
  const dxInput = numberInput(layer.dx ?? 0, (n) => {
    layer.dx = n;
    scheduleSave();
  });
  const dyInput = numberInput(layer.dy ?? 0, (n) => {
    layer.dy = n;
    scheduleSave();
  });

  return h(
    'div',
    null,
    field('テキスト', textArea),
    field('フォント', fontPicker),
    h(
      'div',
      { class: 'row' },
      field('サイズ (pt)', sizeInput),
      field('色', colorRow),
      field('不透明度', h('div', { class: 'row' }, opacityInput, opacityLabel)),
    ),
    h('div', { class: 'row' }, field('回転 (deg)', rotateInput), field('dx (pt)', dxInput), field('dy (pt)', dyInput)),
  );
}

function buildImageFields(ctrl: AppController, layer: ImageLayer, scheduleSave: () => void): HTMLElement {
  const srcInput = h('input', { type: 'text', value: layer.src, style: 'flex:1' });
  srcInput.addEventListener('input', () => {
    layer.src = srcInput.value;
    scheduleSave();
  });

  const assetSelect = h('select', {});
  assetSelect.append(h('option', { value: '' }, '(assets/ から選択)'));
  const ws = ctrl.state.workspace;
  if (ws) {
    void ws.fs.list(ws.config.directories.assets, { extensions: ['.png', '.jpg', '.jpeg'] }).then((entries) => {
      for (const e of entries) assetSelect.append(h('option', { value: e.path }, e.path));
      if (entries.some((e) => e.path === layer.src)) assetSelect.value = layer.src;
    });
  }
  assetSelect.addEventListener('change', () => {
    if (assetSelect.value) {
      srcInput.value = assetSelect.value;
      layer.src = assetSelect.value;
      scheduleSave();
    }
  });

  const widthInput = optionalNumberInput(layer.width, (n) => {
    layer.width = n;
    scheduleSave();
  });
  const heightInput = optionalNumberInput(layer.height, (n) => {
    layer.height = n;
    scheduleSave();
  });

  const opacityInput = h('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(layer.opacity ?? 1) });
  const opacityLabel = h('span', { class: 'muted' }, String(layer.opacity ?? 1));
  opacityInput.addEventListener('input', () => {
    layer.opacity = parseFloat(opacityInput.value);
    opacityLabel.textContent = opacityInput.value;
    scheduleSave();
  });

  const dxInput = numberInput(layer.dx ?? 0, (n) => {
    layer.dx = n;
    scheduleSave();
  });
  const dyInput = numberInput(layer.dy ?? 0, (n) => {
    layer.dy = n;
    scheduleSave();
  });

  return h(
    'div',
    null,
    field('画像パス (src)', h('div', { class: 'row' }, srcInput, assetSelect)),
    h('p', { class: 'muted' }, 'assets/ に PNG/JPEG を置いてください（JSON には埋め込みません）'),
    h(
      'div',
      { class: 'row' },
      field('幅 (pt, 空=自然サイズ/縦横比維持)', widthInput),
      field('高さ (pt, 空=自然サイズ/縦横比維持)', heightInput),
      field('不透明度', h('div', { class: 'row' }, opacityInput, opacityLabel)),
    ),
    h('div', { class: 'row' }, field('dx (pt)', dxInput), field('dy (pt)', dyInput)),
  );
}

function buildPageNumberFields(ctrl: AppController, layer: PageNumberLayer, scheduleSave: () => void): HTMLElement {
  const templateInput = h('input', { type: 'text', value: layer.template, style: 'flex:1' });
  templateInput.addEventListener('input', () => {
    layer.template = templateInput.value;
    scheduleSave();
  });

  function insertQuick(text: string): void {
    const start = templateInput.selectionStart ?? templateInput.value.length;
    const end = templateInput.selectionEnd ?? templateInput.value.length;
    const v = templateInput.value;
    templateInput.value = v.slice(0, start) + text + v.slice(end);
    layer.template = templateInput.value;
    scheduleSave();
    templateInput.focus();
    const caret = start + text.length;
    templateInput.setSelectionRange(caret, caret);
  }
  const quickRow = h(
    'div',
    { class: 'row' },
    button('{page}', () => insertQuick('{page}'), 'btn btn-sm'),
    button('{page} / {pages}', () => insertQuick('{page} / {pages}'), 'btn btn-sm'),
    button('Page {page} of {pages}', () => insertQuick('Page {page} of {pages}'), 'btn btn-sm'),
  );

  const fontPicker = createFontPicker({
    ctrl,
    value: layer.font,
    onChange: (ref: FontRef) => {
      layer.font = ref;
      scheduleSave();
    },
  });
  const sizeInput = numberInput(
    layer.size,
    (n) => {
      layer.size = n;
      scheduleSave();
    },
    { step: 1, min: 1 },
  );
  const colorRow = colorField(layer, scheduleSave);
  const startAtInput = optionalNumberInput(layer.startAt, (n) => {
    layer.startAt = n;
    scheduleSave();
  });
  const totalOverrideInput = optionalNumberInput(layer.totalPagesOverride, (n) => {
    layer.totalPagesOverride = n;
    scheduleSave();
  });
  const dxInput = numberInput(layer.dx ?? 0, (n) => {
    layer.dx = n;
    scheduleSave();
  });
  const dyInput = numberInput(layer.dy ?? 0, (n) => {
    layer.dy = n;
    scheduleSave();
  });

  return h(
    'div',
    null,
    field('テンプレート', templateInput),
    quickRow,
    field('フォント', fontPicker),
    h('div', { class: 'row' }, field('サイズ (pt)', sizeInput), field('色', colorRow)),
    h('div', { class: 'row' }, field('開始番号 (startAt)', startAtInput), field('総ページ数上書き', totalOverrideInput)),
    h('p', { class: 'muted settings-note' }, 'Sequence タブで通し番号が割り当てられたファイルでは，startAt の代わりにその番号が使われます．'),
    h('div', { class: 'row' }, field('dx (pt)', dxInput), field('dy (pt)', dyInput)),
  );
}

function buildLayerFields(ctrl: AppController, layer: StampLayer, scheduleSave: () => void): HTMLElement {
  switch (layer.type) {
    case 'text':
      return buildTextFields(ctrl, layer, scheduleSave);
    case 'image':
      return buildImageFields(ctrl, layer, scheduleSave);
    case 'pageNumber':
      return buildPageNumberFields(ctrl, layer, scheduleSave);
    default:
      return h('p', { class: 'muted' }, `未対応のレイヤー種別: ${layer.type}`);
  }
}

function renderLayerRow(
  ctrl: AppController,
  draft: StampDefinition,
  layer: StampLayer,
  index: number,
  scheduleSave: () => void,
  rebuildLayers: () => void,
): HTMLElement {
  const header = h(
    'div',
    { class: 'layer-header' },
    h('span', { class: 'type' }, LAYER_TYPE_LABELS[layer.type] ?? layer.type),
    h('span', { style: 'flex:1' }),
    button(
      '↑',
      () => {
        if (index === 0) return;
        const arr = draft.layers;
        [arr[index - 1], arr[index]] = [arr[index], arr[index - 1]];
        scheduleSave();
        rebuildLayers();
      },
      'btn btn-sm',
    ),
    button(
      '↓',
      () => {
        const arr = draft.layers;
        if (index === arr.length - 1) return;
        [arr[index + 1], arr[index]] = [arr[index], arr[index + 1]];
        scheduleSave();
        rebuildLayers();
      },
      'btn btn-sm',
    ),
    button(
      '✕',
      () => {
        draft.layers.splice(index, 1);
        scheduleSave();
        rebuildLayers();
      },
      'btn btn-sm btn-danger',
    ),
  );
  return h('div', { class: 'layer' }, header, buildLayerFields(ctrl, layer, scheduleSave));
}

function cloneDraft(def: StampDefinition): StampDefinition {
  const d = structuredClone(def);
  if (!d.defaultPosition) d.defaultPosition = { ...DEFAULT_STAMP_POSITION };
  if (!d.defaultPages) d.defaultPages = { kind: 'all' };
  return d;
}

// ---------------------------------------------------------------- section

export const stampsSection: Section = {
  id: 'stamps',
  title: 'Stamps',
  mount(root, ctrl) {
    const noWorkspace = h(
      'div',
      { class: 'alert warn' },
      'Workspace が開かれていません。 ',
      button('Workspace タブへ', () => ctrl.setPrefs({ lastTab: 'workspace' }), 'btn btn-sm'),
    );

    // ----- left column: definitions + instances -----
    const templateSelect = h('select', {});
    for (const t of BUILTIN_STAMP_TEMPLATES) templateSelect.append(h('option', { value: t.id }, t.name));
    const defsListEl = h('ul', { class: 'list' });
    const validationBox = h('div');
    const definitionsPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Stamp definitions'),
      h(
        'div',
        { class: 'row' },
        templateSelect,
        button('テンプレートから追加', () => addFromTemplate(), 'btn btn-sm'),
        button('新規（空）', () => addBlank(), 'btn btn-sm'),
      ),
      defsListEl,
      validationBox,
    );

    const instancesListEl = h('ul', { class: 'list' });
    const addInstanceBtn = button('＋ instance', () => addInstanceForSelected(), 'btn btn-sm');
    const instancesPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Instances'),
      h('div', { class: 'row' }, addInstanceBtn),
      instancesListEl,
    );

    // ----- right column: definition editor + instance editor -----
    const defEditorPanel = h('div', { class: 'panel' });
    const instanceEditorPanel = h('div', { class: 'panel' });

    const gridEl = h(
      'div',
      { class: 'grid grid-sidebar' },
      h('div', null, definitionsPanel, instancesPanel),
      h('div', null, defEditorPanel, instanceEditorPanel),
    );

    // ----- selection + draft bookkeeping -----
    let selectedDefId: string | undefined;
    let selectedInstanceId: string | undefined;

    let draft: StampDefinition | undefined;
    let draftDefId: string | undefined;
    let savedJson: string | undefined;

    let instDraftId: string | undefined;
    let instSavedJson: string | undefined;

    // Pending debounced-save flushers for whichever definition/instance is
    // currently being edited, so switching the selection (or the whole
    // section unmounting) doesn't leave up to 400ms of typing unsaved.
    let flushDefSave: (() => void) | undefined;
    let flushInstSave: (() => void) | undefined;

    function findDef(id: string | undefined): StampDefinition | undefined {
      return id ? ctrl.state.workspace?.stamps.definitions.find((d) => d.id === id) : undefined;
    }
    function findInst(id: string | undefined): StampInstance | undefined {
      return id ? ctrl.state.workspace?.stamps.instances.find((i) => i.id === id) : undefined;
    }

    function selectDef(id: string | undefined): void {
      flushDefSave?.();
      selectedDefId = id;
      applyState(ctrl.state);
    }
    function selectInstance(id: string | undefined): void {
      flushInstSave?.();
      selectedInstanceId = id;
      applyState(ctrl.state);
    }

    function addFromTemplate(): void {
      if (!ctrl.state.workspace) return;
      const tmpl = BUILTIN_STAMP_TEMPLATES.find((t) => t.id === templateSelect.value);
      if (!tmpl) return;
      const def: StampDefinition = { ...structuredClone(tmpl), id: createId('stamp') };
      void ctrl.addDefinition(def).then(() => selectDef(def.id));
    }
    function addBlank(): void {
      if (!ctrl.state.workspace) return;
      const def: StampDefinition = {
        id: createId('stamp'),
        name: '新しいスタンプ',
        layers: [],
        defaultPosition: { ...DEFAULT_STAMP_POSITION },
        defaultPages: { kind: 'all' },
      };
      void ctrl.addDefinition(def).then(() => selectDef(def.id));
    }
    function addInstanceForSelected(): void {
      const def = findDef(selectedDefId);
      if (!def) return;
      void ctrl.addInstance(createInstanceFromDefinition(def));
    }

    function renderDefsList(): void {
      const ws = ctrl.state.workspace;
      const defs = ws?.stamps.definitions ?? [];
      replaceChildren(
        defsListEl,
        defs.map((d) => {
          const types = [...new Set(d.layers.map((l) => l.type))];
          return h(
            'li',
            { attrs: { 'aria-selected': String(d.id === selectedDefId) }, on: { click: () => selectDef(d.id) } },
            h('span', { class: 'name' }, d.name),
            h('span', { class: 'muted' }, `${d.layers.length} layers`),
            h('span', { class: 'badge' }, types.join(', ') || '(empty)'),
            h(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                title: '削除',
                on: {
                  click: (ev) => {
                    ev.stopPropagation();
                    if (confirm(`「${d.name}」を削除しますか？関連する instance も削除されます。`)) {
                      void ctrl.removeDefinition(d.id);
                      if (selectedDefId === d.id) selectDef(undefined);
                    }
                  },
                },
              },
              '削除',
            ),
          );
        }),
      );
      const problems = ws ? validateStampsConfig(ws.stamps) : [];
      replaceChildren(
        validationBox,
        problems.length ? h('div', { class: 'alert warn' }, problems.map((p) => h('div', null, p))) : null,
      );
    }

    function renderInstancesList(): void {
      const ws = ctrl.state.workspace;
      const instances = ws?.stamps.instances ?? [];
      addInstanceBtn.disabled = !selectedDefId;
      replaceChildren(
        instancesListEl,
        instances.map((inst) => {
          const def = ws?.stamps.definitions.find((d) => d.id === inst.stampId);
          const pos = def ? effectivePosition(def, inst) : (inst.position ?? DEFAULT_STAMP_POSITION);
          const checkbox = h('input', { type: 'checkbox', checked: inst.enabled });
          checkbox.addEventListener('click', (ev) => ev.stopPropagation());
          checkbox.addEventListener('change', () => void ctrl.setInstanceEnabled(inst.id, checkbox.checked));
          return h(
            'li',
            { attrs: { 'aria-selected': String(inst.id === selectedInstanceId) }, on: { click: () => selectInstance(inst.id) } },
            checkbox,
            h('span', { class: 'name' }, def?.name ?? inst.stampId),
            h('span', { class: 'muted' }, describePageSelector(inst.pages)),
            h('span', { class: 'muted' }, describePosition(pos)),
            h(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                title: '削除',
                on: {
                  click: (ev) => {
                    ev.stopPropagation();
                    void ctrl.removeInstance(inst.id);
                    if (selectedInstanceId === inst.id) selectInstance(undefined);
                  },
                },
              },
              '✕',
            ),
          );
        }),
      );
    }

    function rebuildDefEditor(): void {
      if (!draft) {
        flushDefSave = undefined;
        replaceChildren(
          defEditorPanel,
          h('h2', null, '定義エディタ'),
          h('p', { class: 'muted' }, '左のリストから編集する定義を選択してください。'),
        );
        return;
      }
      const d = draft;
      const defStatus = h('span', { class: 'muted' });

      async function doSave(): Promise<void> {
        const toSave = structuredClone(d);
        const stillActive = draftDefId === d.id;
        if (stillActive) {
          savedJson = JSON.stringify(toSave);
          defStatus.textContent = '保存中…';
        }
        await ctrl.updateDefinition(toSave);
        if (draftDefId === d.id) defStatus.textContent = '保存しました';
      }
      const debouncedSave = debounce(() => void doSave(), 400);
      flushDefSave = debouncedSave.flush;
      function scheduleSave(): void {
        defStatus.textContent = '未保存の変更…';
        debouncedSave();
      }

      const nameInput = h('input', { type: 'text', value: d.name });
      nameInput.addEventListener('input', () => {
        d.name = nameInput.value;
        scheduleSave();
      });
      const descInput = h('textarea', { value: d.description ?? '' });
      descInput.addEventListener('input', () => {
        d.description = descInput.value || undefined;
        scheduleSave();
      });

      const layersContainer = h('div', null);
      function rebuildLayers(): void {
        replaceChildren(layersContainer, d.layers.map((layer, idx) => renderLayerRow(ctrl, d, layer, idx, scheduleSave, rebuildLayers)));
      }
      rebuildLayers();

      const addLayerRow = h(
        'div',
        { class: 'row' },
        button(
          '＋ text',
          () => {
            d.layers.push(newLayer('text'));
            scheduleSave();
            rebuildLayers();
          },
          'btn btn-sm',
        ),
        button(
          '＋ image',
          () => {
            d.layers.push(newLayer('image'));
            scheduleSave();
            rebuildLayers();
          },
          'btn btn-sm',
        ),
        button(
          '＋ pageNumber',
          () => {
            d.layers.push(newLayer('pageNumber'));
            scheduleSave();
            rebuildLayers();
          },
          'btn btn-sm',
        ),
      );

      const positionEditor = createPositionEditor(ctrl, d.defaultPosition ?? DEFAULT_STAMP_POSITION, (pos) => {
        d.defaultPosition = pos;
        scheduleSave();
      });
      const pagesEditor = createPageSelectorEditor(d.defaultPages ?? { kind: 'all' }, (sel) => {
        d.defaultPages = sel;
        scheduleSave();
      });

      replaceChildren(
        defEditorPanel,
        h('h2', null, `編集: ${d.name}`),
        field('名前', nameInput),
        field('説明', descInput),
        h('h3', null, 'レイヤー'),
        layersContainer,
        addLayerRow,
        h('h3', null, '既定位置 (defaultPosition)'),
        positionEditor,
        h('h3', null, '既定ページ (defaultPages)'),
        pagesEditor,
        h('div', { class: 'row', style: 'margin-top:8px' }, button('保存', () => void doSave(), 'btn btn-primary btn-sm'), defStatus),
      );
    }

    function rebuildInstanceEditor(): void {
      flushInstSave = undefined;
      const ws = ctrl.state.workspace;
      const inst = findInst(selectedInstanceId);
      if (!inst || !ws) {
        replaceChildren(
          instanceEditorPanel,
          h('h2', null, 'Instance エディタ'),
          h('p', { class: 'muted' }, '左の Instances リストから選択してください。'),
        );
        return;
      }
      const def = ws.stamps.definitions.find((dd) => dd.id === inst.stampId);
      const instStatus = h('span', { class: 'muted' });

      const enabledCheckbox = h('input', { type: 'checkbox', checked: inst.enabled });
      enabledCheckbox.addEventListener('change', () => void ctrl.setInstanceEnabled(inst.id, enabledCheckbox.checked));

      const pagesEditor = createPageSelectorEditor(inst.pages, (sel) => {
        instStatus.textContent = '保存中…';
        void ctrl.setInstancePages(inst.id, sel).then(() => {
          instStatus.textContent = '保存しました';
        });
      });

      let positionBlock: HTMLElement;
      if (inst.position) {
        const debouncedPosSave = debounce((pos: StampPosition) => {
          instStatus.textContent = '保存中…';
          void ctrl.setInstancePosition(inst.id, pos).then(() => {
            instStatus.textContent = '保存しました';
          });
        }, 400);
        flushInstSave = debouncedPosSave.flush;
        const posEditor = createPositionEditor(ctrl, inst.position, debouncedPosSave);
        positionBlock = h(
          'div',
          null,
          posEditor,
          button(
            '定義の既定位置を使う',
            () => {
              void ctrl.updateStamps(
                (cfg) => {
                  const i = cfg.instances.find((x) => x.id === inst.id);
                  if (i) i.position = undefined;
                },
                { type: EVENT_TYPES.stampUpdated, instance: inst.id },
              );
            },
            'btn btn-sm',
          ),
        );
      } else {
        positionBlock = h(
          'div',
          null,
          h('p', { class: 'muted' }, '定義の既定位置を使用中です。'),
          button(
            '位置を上書きする',
            () => {
              const start = def ? effectivePosition(def, inst) : DEFAULT_STAMP_POSITION;
              void ctrl.setInstancePosition(inst.id, { ...start });
            },
            'btn btn-sm',
          ),
        );
      }

      replaceChildren(
        instanceEditorPanel,
        h('h2', null, `Instance: ${def?.name ?? inst.stampId}`),
        h('div', { class: 'row' }, h('label', { class: 'row' }, enabledCheckbox, '有効'), instStatus),
        h('h3', null, 'ページ'),
        pagesEditor,
        h('h3', null, '位置'),
        positionBlock,
      );
    }

    function applyState(state: AppState): void {
      const ws = state.workspace;
      replaceChildren(root, ws ? gridEl : noWorkspace);
      if (!ws) return;

      renderDefsList();
      renderInstancesList();

      const def = findDef(selectedDefId);
      if (!def) {
        if (draft !== undefined) {
          draft = undefined;
          draftDefId = undefined;
          savedJson = undefined;
          rebuildDefEditor();
        } else if (!defEditorPanel.hasChildNodes()) {
          rebuildDefEditor();
        }
      } else {
        const defJson = JSON.stringify(def);
        const selectionChanged = draftDefId !== def.id;
        const externalChange = !selectionChanged && defJson !== savedJson;
        if (selectionChanged || externalChange) {
          draft = cloneDraft(def);
          draftDefId = def.id;
          savedJson = JSON.stringify(draft);
          rebuildDefEditor();
        }
      }

      const inst = findInst(selectedInstanceId);
      if (!inst) {
        if (instDraftId !== undefined) {
          instDraftId = undefined;
          instSavedJson = undefined;
          rebuildInstanceEditor();
        } else if (!instanceEditorPanel.hasChildNodes()) {
          rebuildInstanceEditor();
        }
      } else {
        const instJson = JSON.stringify(inst);
        const selectionChanged = instDraftId !== inst.id;
        const externalChange = !selectionChanged && instJson !== instSavedJson;
        if (selectionChanged || externalChange) {
          instDraftId = inst.id;
          instSavedJson = instJson;
          rebuildInstanceEditor();
        }
      }
    }

    return (state) => applyState(state);
  },
};
