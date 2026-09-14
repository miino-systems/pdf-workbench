/**
 * Resolving `PageSelector` values into concrete 1-based page numbers, and
 * human readable (Japanese) descriptions of a selector, for a document with
 * a known page count.
 */
import type { PageSelector } from '@/core/types';

/**
 * Resolve a `PageSelector` into a sorted, deduplicated list of 1-based page
 * numbers, clamped to `1..pageCount`.
 *
 *  - `range`: `from`/`to` may be given in either order.
 *  - `list`: entries outside `1..pageCount` are silently dropped.
 *  - `odd`/`even`: based on the 1-based page number.
 */
export function resolvePages(selector: PageSelector, pageCount: number): number[] {
  if (pageCount <= 0) return [];

  const pages = new Set<number>();
  const clampPush = (n: number): void => {
    if (Number.isFinite(n) && n >= 1 && n <= pageCount) pages.add(Math.trunc(n));
  };

  switch (selector.kind) {
    case 'all':
      for (let i = 1; i <= pageCount; i += 1) pages.add(i);
      break;
    case 'first':
      clampPush(1);
      break;
    case 'last':
      clampPush(pageCount);
      break;
    case 'range': {
      const from = Math.min(selector.from, selector.to);
      const to = Math.max(selector.from, selector.to);
      for (let i = Math.max(1, from); i <= Math.min(pageCount, to); i += 1) pages.add(i);
      break;
    }
    case 'list':
      for (const p of selector.pages) clampPush(p);
      break;
    case 'odd':
      for (let i = 1; i <= pageCount; i += 2) pages.add(i);
      break;
    case 'even':
      for (let i = 2; i <= pageCount; i += 2) pages.add(i);
      break;
  }

  return Array.from(pages).sort((a, b) => a - b);
}

/** Short Japanese label describing a page selector, for use in the UI. */
export function describePageSelector(selector: PageSelector): string {
  switch (selector.kind) {
    case 'all':
      return '全ページ';
    case 'first':
      return '先頭ページ';
    case 'last':
      return '最終ページ';
    case 'range':
      return `p.${Math.min(selector.from, selector.to)}–${Math.max(selector.from, selector.to)}`;
    case 'list':
      return `p.${selector.pages.join(',')}`;
    case 'odd':
      return '奇数ページ';
    case 'even':
      return '偶数ページ';
  }
}

/**
 * Parse a comma-separated page list such as `"1,3-5,8"` (ranges may be
 * reversed, e.g. `"5-3"`) into a `{ kind: 'list' }` selector. Ranges are
 * expanded into individual page numbers. When `pageCount` is given, entries
 * outside `1..pageCount` are dropped; otherwise all positive integers parsed
 * from the string are kept.
 *
 * Intended as a UI helper for a free-text "pages" input field.
 */
export function parsePageList(input: string, pageCount?: number): PageSelector {
  const pages = new Set<number>();
  const inRange = (n: number): boolean =>
    Number.isFinite(n) && n >= 1 && (pageCount === undefined || n <= pageCount);

  for (const rawPart of input.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;

    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      const from = Math.min(a, b);
      const to = Math.max(a, b);
      for (let i = from; i <= to; i += 1) {
        if (inRange(i)) pages.add(i);
      }
      continue;
    }

    const single = parseInt(part, 10);
    if (!Number.isNaN(single) && inRange(single)) pages.add(single);
  }

  return { kind: 'list', pages: Array.from(pages).sort((a, b) => a - b) };
}
