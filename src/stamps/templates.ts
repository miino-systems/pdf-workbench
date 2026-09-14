/**
 * Built-in stamp definitions offered out of the box, plus small id / instance
 * creation helpers shared by the UI.
 */
import type { PageSelector, StampDefinition, StampInstance } from '@/core/types';

/**
 * Create a reasonably unique id. Uses `crypto.randomUUID()` when available
 * (browsers, modern Node), otherwise falls back to a timestamp + random
 * suffix so the module still works in restrictive test environments.
 */
export function createId(prefix = 'id'): string {
  const cryptoObj = (globalThis as { crypto?: Crypto }).crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === 'function') {
    return `${prefix}-${cryptoObj.randomUUID()}`;
  }
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

/** Create a `StampInstance` for `def`, enabled, using its default pages. */
export function createInstanceFromDefinition(def: StampDefinition): StampInstance {
  const pages: PageSelector = def.defaultPages ?? { kind: 'all' };
  return {
    id: createId('inst'),
    stampId: def.id,
    enabled: true,
    pages,
  };
}

const ALL_PAGES: PageSelector = { kind: 'all' };

/** Built-in stamp definitions available in every new workspace. */
export const BUILTIN_STAMP_TEMPLATES: StampDefinition[] = [
  {
    id: 'draft',
    name: 'DRAFT',
    description: '下書きであることを示す大きな半透明の透かし文字。',
    layers: [
      {
        id: 'text',
        type: 'text',
        text: 'DRAFT',
        font: { kind: 'standard', name: 'Helvetica-Bold' },
        size: 48,
        color: '#c00000',
        opacity: 0.3,
      },
    ],
    defaultPosition: { anchor: 'top-center', offsetX: 0, offsetY: 36 },
    defaultPages: ALL_PAGES,
  },
  {
    id: 'confidential',
    name: 'Confidential',
    description: '右上に配置する赤色の "Confidential" ラベル。',
    layers: [
      {
        id: 'text',
        type: 'text',
        text: 'Confidential',
        font: { kind: 'standard', name: 'Helvetica-Bold' },
        size: 14,
        color: '#c00000',
      },
    ],
    defaultPosition: { anchor: 'top-right', offsetX: 36, offsetY: 24 },
    defaultPages: ALL_PAGES,
  },
  {
    id: 'page-number',
    name: 'Page Number',
    description: '下部中央に "現在ページ / 総ページ数" を表示。',
    layers: [
      {
        id: 'pageNumber',
        type: 'pageNumber',
        template: '{page} / {pages}',
        font: { kind: 'standard', name: 'Helvetica' },
        size: 10,
        color: '#000000',
      },
    ],
    defaultPosition: { anchor: 'bottom-center', offsetX: 0, offsetY: 24 },
    defaultPages: ALL_PAGES,
  },
  {
    id: 'cc-by-4.0',
    name: 'CC BY 4.0',
    description:
      'クリエイティブ・コモンズ表示ロゴを右下に配置します。使用する前に ' +
      '画像を workspace の assets/cc-by.png として配置してください。',
    layers: [
      {
        id: 'image',
        type: 'image',
        src: 'assets/cc-by.png',
        width: 88,
      },
    ],
    defaultPosition: { anchor: 'bottom-right', offsetX: 36, offsetY: 24 },
    defaultPages: ALL_PAGES,
  },
  {
    id: 'custom-text',
    name: 'Custom text',
    description: '自由編集用のテキストスタンプ雛形。',
    layers: [
      {
        id: 'text',
        type: 'text',
        text: 'Your text',
        font: { kind: 'standard', name: 'Helvetica' },
        size: 12,
        color: '#000000',
      },
    ],
    defaultPosition: { anchor: 'bottom-right', offsetX: 36, offsetY: 36 },
    defaultPages: ALL_PAGES,
  },
];
