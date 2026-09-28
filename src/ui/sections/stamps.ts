/**
 * Stamps tab: one list entry per stamp. `stamps.json` still separates the
 * design (`StampDefinition`: layers) from where it goes (`StampInstance`:
 * enabled flag, pages, position), but the UI presents them together — a
 * stamp is edited as its placements plus its design, and a second placement
 * is only added when the same design goes to different places (e.g. page
 * numbers bottom-right on odd pages and bottom-left on even ones). The
 * definition's `defaultPosition` / `defaultPages` are no longer shown: they
 * only seed a new stamp's first placement.
 *
 * Editing keeps a local "draft" copy of the selected definition so that
 * continuous typing never gets interrupted by a full DOM rebuild: the design
 * form is rebuilt only when the selection changes or the underlying
 * `stamps.json` changed from outside (e.g. undo, or `generate.ts` filling in
 * a font's sha256 after a run). Field edits mutate the draft in place and
 * schedule a 400ms-debounced save via `ctrl.updateDefinition`; placement
 * edits save through `ctrl.setInstancePages` / `ctrl.setInstancePosition`.
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
  StampLayout,
  StampPosition,
  TextAlign,
  TextLayer,
} from '@/core/types';
import { STAMP_ANCHORS } from '@/core/types';
import { mmToPt, ptToMm, round } from '@/core/units';
import { DEFAULT_LINE_HEIGHT_FACTOR } from '@/pdf/stamper/sanitize';
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

/** A debounced function that can also be flushed (run its pending call now) or cancelled (drop it). */
type Debounced<Args extends unknown[]> = ((...args: Args) => void) & { flush: () => void; cancel: () => void };

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
  debounced.cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    pendingArgs = undefined;
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

function describePosition(pos: StampPosition, unit: 'mm' | 'pt'): string {
  const v = (pt: number): number => round(unit === 'mm' ? ptToMm(pt) : pt, 1);
  return `${ANCHOR_LABELS[pos.anchor]} (${v(pos.offsetX)}, ${v(pos.offsetY)} ${unit})`;
}

const ALIGN_LABELS: Record<TextAlign, string> = { left: '左揃え', center: '中央揃え', right: '右揃え' };

/** 揃え + 行間 for the text-drawing layers (only matter for multi-line text). */
function textBlockFields(layer: TextLayer | PageNumberLayer, scheduleSave: () => void): HTMLElement {
  const alignSelect = h(
    'select',
    null,
    (Object.keys(ALIGN_LABELS) as TextAlign[]).map((a) => h('option', { value: a, selected: (layer.align ?? 'left') === a }, ALIGN_LABELS[a])),
  );
  alignSelect.addEventListener('change', () => {
    layer.align = alignSelect.value === 'left' ? undefined : (alignSelect.value as TextAlign);
    scheduleSave();
  });
  const lineHeightInput = h('input', { type: 'number', step: '0.05', min: '0.5', placeholder: String(DEFAULT_LINE_HEIGHT_FACTOR), value: layer.lineHeight === undefined ? '' : String(layer.lineHeight) });
  lineHeightInput.addEventListener('input', () => {
    const n = parseFloat(lineHeightInput.value);
    layer.lineHeight = lineHeightInput.value.trim() === '' || !(n > 0) ? undefined : n;
    scheduleSave();
  });
  return h('div', { class: 'row' }, field('行の揃え', alignSelect), field('行間（文字サイズの倍率，空=1.2）', lineHeightInput));
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
    field('テキスト（改行で複数行）', textArea),
    textBlockFields(layer, scheduleSave),
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
    textBlockFields(layer, scheduleSave),
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

// ---------------------------------------------------------------- section

/** "全ページ" for one placement, "2 配置" for several, "未配置" for none. */
/** 重ねる / 横に並べる / 縦に並べる, with gap and cross-axis alignment for the latter two. */
function createLayoutEditor(d: StampDefinition, scheduleSave: () => void): HTMLElement {
  const modes: { value: 'overlap' | StampLayout['direction']; label: string }[] = [
    { value: 'overlap', label: '重ねる（各レイヤーの dx/dy で調整）' },
    { value: 'row', label: '横に並べる（例: ロゴの右に文言）' },
    { value: 'column', label: '縦に並べる' },
  ];
  const modeSelect = h('select', null, modes.map((m) => h('option', { value: m.value, selected: (d.layout?.direction ?? 'overlap') === m.value }, m.label)));
  const gapInput = h('input', { type: 'number', step: '0.5', min: '0', value: String(d.layout?.gap ?? 0) });
  const alignSelect = h('select');
  const details = h('div', { class: 'row' }, field('間隔 (pt)', gapInput), field('揃え', alignSelect));

  function syncAlignOptions(): void {
    const labels = d.layout?.direction === 'column' ? ['左', '中央', '右'] : ['上', '中央', '下'];
    replaceChildren(
      alignSelect,
      (['start', 'center', 'end'] as const).map((v, i) => h('option', { value: v, selected: (d.layout?.align ?? 'center') === v }, labels[i])),
    );
    details.hidden = !d.layout;
  }
  function update(): void {
    const mode = modeSelect.value;
    d.layout =
      mode === 'overlap'
        ? undefined
        : { direction: mode as StampLayout['direction'], gap: parseFloat(gapInput.value) || 0, align: alignSelect.value as StampLayout['align'] };
    syncAlignOptions();
    scheduleSave();
  }
  modeSelect.addEventListener('change', update);
  gapInput.addEventListener('input', update);
  alignSelect.addEventListener('change', update);
  syncAlignOptions();
  return h(
    'div',
    null,
    modeSelect,
    details,
    h('p', { class: 'muted settings-note' }, '並べる場合はレイヤーの順（↑↓で変更）に配置され，dx/dy は追加の微調整になります．'),
  );
}

function describePlacements(instances: StampInstance[]): string {
  if (instances.length === 0) return '未配置';
  if (instances.length === 1) return describePageSelector(instances[0].pages);
  return `${instances.length} 配置`;
}

export const stampsSection: Section = {
  id: 'stamps',
  title: 'Stamps',
  fill: true,
  mount(root, ctrl) {
    const noWorkspace = h(
      'div',
      { class: 'alert warn' },
      'Workspace が開かれていません。 ',
      button('Workspace タブへ', () => ctrl.setPrefs({ lastTab: 'workspace' }), 'btn btn-sm'),
    );

    // ----- left column: one row per stamp -----
    const templateSelect = h('select', {});
    for (const t of BUILTIN_STAMP_TEMPLATES) templateSelect.append(h('option', { value: t.id }, t.name));
    const stampListEl = h('ul', { class: 'list' });
    const validationBox = h('div');
    const listPanel = h(
      'div',
      { class: 'panel' },
      h('h2', null, 'Stamps'),
      h(
        'div',
        { class: 'row' },
        templateSelect,
        button('テンプレートから追加', () => addFromTemplate(), 'btn btn-sm'),
        button('新規（空）', () => addBlank(), 'btn btn-sm'),
      ),
      stampListEl,
      validationBox,
    );

    // ----- right column: the selected stamp (design + placements) -----
    const defEditorPanel = h('div', { class: 'panel' });
    const placementsPanel = h('div', { class: 'panel' });

    const leftCol = h('div', { class: 'scroll-col' }, listPanel);
    const rightCol = h('div', { class: 'scroll-col' }, placementsPanel, defEditorPanel);
    const gridEl = h('div', { class: 'grid grid-sidebar fill-layout' }, leftCol, rightCol);

    // ----- selection + draft bookkeeping -----
    let selectedDefId: string | undefined;

    let draft: StampDefinition | undefined;
    let draftDefId: string | undefined;
    let savedJson: string | undefined;

    /** JSON of the selected stamp's placements as last rendered; a mismatch means they changed elsewhere. */
    let placementsJson: string | undefined;
    let placementsDefId: string | undefined;
    /** Saves started from the placement editor itself: their store updates must not rebuild it mid-typing. */
    let ownPlacementSaves = 0;

    // Pending debounced-save flushers, so switching the selection doesn't
    // leave up to 400ms of typing unsaved.
    let flushDefSave: (() => void) | undefined;
    let cancelDefSave: (() => void) | undefined;
    let flushPlacementSaves: (() => void)[] = [];

    function findDef(id: string | undefined): StampDefinition | undefined {
      return id ? ctrl.state.workspace?.stamps.definitions.find((d) => d.id === id) : undefined;
    }
    function placementsOf(id: string | undefined): StampInstance[] {
      return id ? (ctrl.state.workspace?.stamps.instances.filter((i) => i.stampId === id) ?? []) : [];
    }

    function selectDef(id: string | undefined): void {
      flushDefSave?.();
      for (const f of flushPlacementSaves) f();
      selectedDefId = id;
      applyState(ctrl.state);
      rightCol.scrollTop = 0;
    }

    /** Run a placement save without letting its own store update rebuild the editor. */
    function savePlacement(p: Promise<void>, status?: HTMLElement): void {
      ownPlacementSaves += 1;
      if (status) status.textContent = '保存中…';
      void p.finally(() => {
        ownPlacementSaves -= 1;
        placementsJson = JSON.stringify(placementsOf(placementsDefId));
        if (status) status.textContent = '保存しました';
      });
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
    /** New placement of the selected stamp, starting from its last placement (or the stamp's defaults). */
    function addPlacement(): void {
      const def = findDef(selectedDefId);
      if (!def) return;
      const last = placementsOf(def.id).at(-1);
      const inst = createInstanceFromDefinition(def);
      if (last) {
        inst.pages = structuredClone(last.pages);
        inst.position = { ...effectivePosition(def, last) };
      }
      void ctrl.addInstance(inst);
    }

    function renderStampList(): void {
      const ws = ctrl.state.workspace;
      const defs = ws?.stamps.definitions ?? [];
      const scrollTop = leftCol.scrollTop;
      replaceChildren(
        stampListEl,
        defs.map((d) => {
          const placements = placementsOf(d.id);
          const enabledCount = placements.filter((i) => i.enabled).length;
          const checkbox = h('input', {
            type: 'checkbox',
            checked: enabledCount > 0,
            disabled: placements.length === 0,
            title: placements.length > 1 ? 'すべての配置を有効／無効にする' : '有効',
          });
          checkbox.indeterminate = enabledCount > 0 && enabledCount < placements.length;
          checkbox.addEventListener('click', (ev) => ev.stopPropagation());
          checkbox.addEventListener('change', () => void ctrl.setStampEnabled(d.id, checkbox.checked));
          const types = [...new Set(d.layers.map((l) => l.type))];
          return h(
            'li',
            { attrs: { 'aria-selected': String(d.id === selectedDefId) }, on: { click: () => selectDef(d.id) } },
            checkbox,
            h('span', { class: 'name', title: types.join(', ') || '(レイヤーなし)' }, d.name),
            h('span', { class: placements.length ? 'muted' : 'warn' }, describePlacements(placements)),
            h(
              'button',
              {
                class: 'btn btn-sm',
                type: 'button',
                title: '削除',
                on: {
                  click: (ev) => {
                    ev.stopPropagation();
                    if (confirm(`スタンプ「${d.name}」を削除しますか？`)) {
                      void ctrl.removeDefinition(d.id);
                      if (selectedDefId === d.id) selectDef(undefined);
                    }
                  },
                },
              },
              '✕',
            ),
          );
        }),
      );
      leftCol.scrollTop = scrollTop;
      const problems = ws ? validateStampsConfig(ws.stamps) : [];
      replaceChildren(
        validationBox,
        problems.length ? h('div', { class: 'alert warn' }, problems.map((p) => h('div', null, p))) : null,
      );
    }

    function rebuildDefEditor(): void {
      if (!draft) {
        flushDefSave = undefined;
        replaceChildren(defEditorPanel);
        defEditorPanel.hidden = true;
        return;
      }
      defEditorPanel.hidden = false;
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
      cancelDefSave = debouncedSave.cancel;
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
        (['text', 'image', 'pageNumber'] as const).map((type) =>
          button(
            `＋ ${type}`,
            () => {
              d.layers.push(newLayer(type));
              scheduleSave();
              rebuildLayers();
            },
            'btn btn-sm',
          ),
        ),
      );

      replaceChildren(
        defEditorPanel,
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', null, 'デザイン'), defStatus),
        field('名前', nameInput),
        field('説明', descInput),
        h('h3', null, 'レイヤーの並べ方'),
        createLayoutEditor(d, scheduleSave),
        h('h3', null, 'レイヤー'),
        layersContainer,
        addLayerRow,
      );
    }

    function rebuildPlacements(): void {
      flushPlacementSaves = [];
      const def = findDef(selectedDefId);
      placementsDefId = def?.id;
      if (!def) {
        placementsJson = undefined;
        replaceChildren(
          placementsPanel,
          h('h2', null, 'スタンプを選択'),
          h('p', { class: 'muted' }, '左のリストから編集するスタンプを選択するか，テンプレートから追加してください。'),
        );
        return;
      }
      const placements = placementsOf(def.id);
      placementsJson = JSON.stringify(placements);

      const cards = placements.map((inst, idx) => {
        const status = h('span', { class: 'muted' });
        const enabledCheckbox = h('input', { type: 'checkbox', checked: inst.enabled });
        enabledCheckbox.addEventListener('change', () =>
          savePlacement(ctrl.setInstanceEnabled(inst.id, enabledCheckbox.checked), status),
        );
        const pagesEditor = createPageSelectorEditor(inst.pages, (sel) => savePlacement(ctrl.setInstancePages(inst.id, sel), status));
        const debouncedPosSave = debounce((pos: StampPosition) => savePlacement(ctrl.setInstancePosition(inst.id, pos), status), 400);
        flushPlacementSaves.push(debouncedPosSave.flush);
        const posEditor = createPositionEditor(ctrl, effectivePosition(def, inst), (pos) => {
          status.textContent = '未保存の変更…';
          debouncedPosSave(pos);
        });
        // An own position (set by dragging in the PDF preview or editing it
        // here) overrides the definition's defaultPosition — say so, since a
        // changed defaultPosition then has no effect on this placement.
        const defaultPos = def.defaultPosition ?? DEFAULT_STAMP_POSITION;
        const positionSource = inst.position
          ? h(
              'div',
              { class: 'row position-source' },
              h('span', { class: 'badge warn', title: 'stamps.json の instances[].position' }, '📌 独自の位置'),
              h('span', { class: 'muted' }, `既定位置は ${describePosition(defaultPos, ctrl.state.prefs.unit)}`),
              button('既定位置に戻す', () => savePlacement(ctrl.resetInstancePosition(inst.id), status), 'btn btn-sm'),
            )
          : h(
              'div',
              { class: 'row position-source' },
              h('span', { class: 'badge', title: 'stamps.json の definitions[].defaultPosition' }, '既定位置を使用中'),
              h('span', { class: 'muted' }, '変更するとこの配置だけの位置になります'),
            );
        return h(
          'div',
          { class: 'layer' },
          h(
            'div',
            { class: 'layer-header' },
            h('label', { class: 'row' }, enabledCheckbox, placements.length > 1 ? `配置 ${idx + 1}` : '有効'),
            status,
            h('span', { style: 'flex:1' }),
            button('✕', () => void ctrl.removeInstance(inst.id), 'btn btn-sm btn-danger'),
          ),
          h('div', { class: 'placement-body' }, field('ページ', pagesEditor), field('位置', h('div', null, positionSource, posEditor))),
        );
      });

      replaceChildren(
        placementsPanel,
        h('div', { class: 'row', style: 'justify-content:space-between' }, h('h2', null, def.name), button('＋ 配置を追加', () => addPlacement(), 'btn btn-sm')),
        placements.length
          ? cards
          : h('div', { class: 'alert warn' }, '配置がないため，このスタンプは PDF に適用されません。「＋ 配置を追加」で追加してください。'),
        placements.length === 1
          ? h('p', { class: 'muted settings-note' }, '同じスタンプをページごとに違う位置へ置く場合（例: 奇数ページは右下・偶数ページは左下）は配置を追加します。')
          : '',
      );
    }

    function applyState(state: AppState): void {
      const ws = state.workspace;
      const view = ws ? gridEl : noWorkspace;
      // Swap only when needed: re-attaching the grid would reset both columns' scroll.
      if (root.firstChild !== view) replaceChildren(root, view);
      if (!ws) return;

      renderStampList();

      const def = findDef(selectedDefId);
      if (!def) {
        if (draft !== undefined || !placementsPanel.hasChildNodes()) {
          draft = undefined;
          draftDefId = undefined;
          savedJson = undefined;
          rebuildDefEditor();
          rebuildPlacements();
        }
        return;
      }

      const selectionChanged = draftDefId !== def.id;
      if (selectionChanged || JSON.stringify(def) !== savedJson) {
        // Changed underneath the editor (undo, or stamps.json edited outside
        // the app): a pending save of the old draft must not overwrite it.
        if (!selectionChanged) cancelDefSave?.();
        draft = structuredClone(def);
        draftDefId = def.id;
        savedJson = JSON.stringify(draft);
        rebuildDefEditor();
      }
      const json = JSON.stringify(placementsOf(def.id));
      if (selectionChanged || placementsDefId !== def.id || (json !== placementsJson && ownPlacementSaves === 0)) {
        rebuildPlacements();
      } else if (json !== placementsJson) {
        placementsJson = json;
      }
      // The heading shows the (possibly just renamed) stamp name.
      const heading = placementsPanel.querySelector('h2');
      if (heading) heading.textContent = def.name;
    }

    return (state) => applyState(state);
  },
};
