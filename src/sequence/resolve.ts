/**
 * Continuous page numbering across the source PDFs of a workspace.
 *
 * Pure: given the `SequenceConfig` (order + per-file overrides) and the
 * files that actually exist (with their page counts), compute the page
 * range every file occupies. No filesystem or DOM access; the controller
 * supplies page counts (see `state/app.ts`).
 */
import type { SequenceConfig, SequenceEntry } from '@/core/types';

/** One source file as seen by the resolver. `pageCount` is undefined when the PDF could not be read. */
export interface SequenceFileInfo {
  /** Workspace-relative path, e.g. `papers/paper001.pdf`. */
  path: string;
  pageCount?: number;
}

export interface ResolvedSequenceItem {
  file: string;
  /** 0-based position in the resolved order. */
  index: number;
  /** True when `sequence.json` has an entry for this file. */
  listed: boolean;
  /** True for an entry whose file no longer exists in `papers/`. */
  missing: boolean;
  skipped: boolean;
  /** True when the start page comes from an explicit `startPage` pin. */
  pinned: boolean;
  pageCount?: number;
  /** First / last continuous page number. Absent when skipped, missing, or not computable. */
  pageStart?: number;
  pageEnd?: number;
}

export interface ResolvedSequence {
  items: ResolvedSequenceItem[];
  /** Highest page number assigned, if any file was numbered. */
  lastPage?: number;
  /** Number of pages that received a continuous number. */
  numberedPages: number;
  /** Non-fatal problems (unreadable files, entries pointing at missing files, ...). */
  warnings: string[];
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/** Natural ("numeric-aware") string order: `paper2` < `paper10`. Deterministic across locales. */
export function naturalCompare(a: string, b: string): number {
  const c = collator.compare(a, b);
  if (c !== 0) return c;
  return a < b ? -1 : a > b ? 1 : 0;
}

function fileName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/** Natural order by file name, then by full path (files live in one directory, so the path rarely matters). */
export function compareFileNames(a: string, b: string): number {
  return naturalCompare(fileName(a), fileName(b)) || naturalCompare(a, b);
}

/** First entry for `file` (duplicates are tolerated: the first one wins). */
export function entryFor(config: SequenceConfig, file: string): SequenceEntry | undefined {
  return config.entries.find((e) => e.file === file);
}

export interface OrderedFile {
  file: string;
  listed: boolean;
  missing: boolean;
}

/**
 * The order files are numbered in, before any page counting:
 *  - `order: 'name'`: every existing file in natural name order. Entries
 *    whose file is missing are appended (flagged) so the UI can offer to
 *    remove them.
 *  - `order: 'manual'`: listed entries first, in their order (missing ones
 *    flagged, duplicates collapsed), then unlisted files in name order.
 */
export function orderFiles(config: SequenceConfig, files: readonly string[]): OrderedFile[] {
  const present = new Set(files);
  const byName = [...files].sort(compareFileNames);
  const out: OrderedFile[] = [];
  const seen = new Set<string>();

  if (config.order === 'manual') {
    for (const e of config.entries) {
      if (seen.has(e.file)) continue;
      seen.add(e.file);
      out.push({ file: e.file, listed: true, missing: !present.has(e.file) });
    }
  }
  const listedFiles = new Set(config.entries.map((e) => e.file));
  for (const f of byName) {
    if (seen.has(f)) continue;
    seen.add(f);
    out.push({ file: f, listed: listedFiles.has(f), missing: false });
  }
  if (config.order === 'name') {
    for (const e of config.entries) {
      if (seen.has(e.file)) continue;
      seen.add(e.file);
      out.push({ file: e.file, listed: true, missing: true });
    }
  }
  return out;
}

function alignStart(start: number, startOn: SequenceConfig['startOn']): number {
  if (startOn === 'odd' && start % 2 === 0) return start + 1;
  if (startOn === 'even' && start % 2 !== 0) return start + 1;
  return start;
}

/**
 * Assign continuous page numbers.
 *
 * Rules, in order of precedence for each file:
 *  1. `skip` → no numbers; the cursor is unchanged.
 *  2. `startPage` pin → the file starts exactly there (no `startOn` alignment).
 *  3. otherwise the file starts at the cursor, aligned per `startOn`.
 * The cursor then moves to `pageEnd + 1`. A file whose page count is
 * unknown breaks the chain: it and every following file stay unnumbered
 * until a pin re-anchors the cursor (wrong numbers would be worse than none).
 */
export function resolveSequence(config: SequenceConfig, files: readonly SequenceFileInfo[]): ResolvedSequence {
  const infoByPath = new Map(files.map((f) => [f.path, f]));
  const warnings: string[] = [];
  const items: ResolvedSequenceItem[] = [];
  let cursor: number | undefined = Number.isFinite(config.firstPage) ? Math.trunc(config.firstPage) : 1;
  let lastPage: number | undefined;
  let numberedPages = 0;

  orderFiles(
    config,
    files.map((f) => f.path),
  ).forEach(({ file, listed, missing }, index) => {
    const entry = entryFor(config, file);
    const info = infoByPath.get(file);
    const item: ResolvedSequenceItem = {
      file,
      index,
      listed,
      missing,
      skipped: entry?.skip === true,
      pinned: !missing && entry?.skip !== true && entry?.startPage !== undefined,
      pageCount: info?.pageCount,
    };
    items.push(item);

    if (missing) {
      warnings.push(`${file}: ファイルが見つかりません（sequence.json のエントリのみ残っています）`);
      return;
    }
    if (item.skipped) return;

    if (entry?.startPage !== undefined) cursor = Math.trunc(entry.startPage);

    if (info?.pageCount === undefined) {
      warnings.push(`${file}: ページ数を取得できないため，以降の通し番号は確定できません`);
      cursor = undefined;
      return;
    }
    if (cursor === undefined) return; // chain broken earlier; wait for a pin
    if (info.pageCount <= 0) {
      warnings.push(`${file}: ページがありません`);
      return;
    }

    const start = item.pinned ? cursor : alignStart(cursor, config.startOn);
    item.pageStart = start;
    item.pageEnd = start + info.pageCount - 1;
    cursor = item.pageEnd + 1;
    lastPage = lastPage === undefined ? item.pageEnd : Math.max(lastPage, item.pageEnd);
    numberedPages += info.pageCount;
  });

  return { items, lastPage, numberedPages, warnings };
}

/** The resolved item for `file`, if the file is part of the sequence. */
export function sequenceItemFor(sequence: ResolvedSequence | undefined, file: string): ResolvedSequenceItem | undefined {
  return sequence?.items.find((i) => i.file === file);
}

/** Short label such as `p.21–28`, `除外`, or `—` for the UI. */
export function describeRange(item: ResolvedSequenceItem | undefined): string {
  if (!item) return '—';
  if (item.skipped) return '除外';
  if (item.pageStart === undefined || item.pageEnd === undefined) return '—';
  return item.pageStart === item.pageEnd ? `p.${item.pageStart}` : `p.${item.pageStart}–${item.pageEnd}`;
}
