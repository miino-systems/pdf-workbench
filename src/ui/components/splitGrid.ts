/**
 * A two-column grid whose divider can be dragged (double-click resets it).
 * The left column's share of the width is kept per `key` in the UI
 * preferences (`UiPrefs.splits`). Below the narrow breakpoint the columns
 * stack and the handle hides (see `.grid-split` in styles.css).
 */
import type { AppController } from '@/state/app';
import { h } from '../dom';

const MIN = 0.15;
const MAX = 0.8;

export interface SplitGridOptions {
  /** Preference key, e.g. `pdf`. */
  key: string;
  /** Default share of the left column (0..1). */
  initial: number;
  /** Extra classes for the grid, e.g. `fill-layout`. */
  class?: string;
}

function clamp(r: number): number {
  return Math.min(MAX, Math.max(MIN, r));
}

export function splitGrid(ctrl: AppController, left: HTMLElement, right: HTMLElement, opts: SplitGridOptions): HTMLElement {
  const saved = ctrl.state.prefs.splits?.[opts.key];
  let ratio = clamp(typeof saved === 'number' && Number.isFinite(saved) ? saved : opts.initial);

  const handle = h('div', {
    class: 'split-handle',
    title: 'ドラッグで幅を変更（ダブルクリックで元に戻す）',
    attrs: { role: 'separator', 'aria-orientation': 'vertical' },
  });
  const grid = h('div', { class: `grid grid-split ${opts.class ?? ''}`.trim() }, left, handle, right);

  const apply = (): void => {
    grid.style.setProperty('--split-cols', `minmax(0, ${ratio}fr) 0px minmax(0, ${1 - ratio}fr)`);
  };
  const save = (): void => ctrl.setPrefs({ splits: { ...ctrl.state.prefs.splits, [opts.key]: ratio } });
  apply();

  handle.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    handle.setPointerCapture(ev.pointerId);
    grid.classList.add('splitting');
    const box = grid.getBoundingClientRect();
    const move = (e: PointerEvent): void => {
      ratio = clamp((e.clientX - box.left) / box.width);
      apply();
    };
    const up = (): void => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      grid.classList.remove('splitting');
      save();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  });
  handle.addEventListener('dblclick', () => {
    ratio = clamp(opts.initial);
    apply();
    save();
  });
  return grid;
}
