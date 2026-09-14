/**
 * Tabular export of a resolved sequence: one row per source file with its
 * continuous page range, as CSV / TSV text or JSON.
 */
import type { ResolvedSequence } from './resolve';

/** Base name of the files written into `output/` (`page-ranges.csv`, `page-ranges.json`). */
export const PAGE_RANGES_BASENAME = 'page-ranges';

export interface PageRangeRow {
  /** Source file name (no directory), e.g. `paper001.pdf`. */
  filename: string;
  /** Workspace-relative source path. */
  path: string;
  /** Name of the stamped output file, when the caller can compute it. */
  output?: string;
  page_start?: number;
  page_end?: number;
  page_count?: number;
  skipped: boolean;
}

/** Column order of the CSV / TSV export. */
export const PAGE_RANGE_COLUMNS = ['filename', 'page_start', 'page_end', 'page_count'] as const;

function fileName(path: string): string {
  const idx = path.lastIndexOf('/');
  return idx === -1 ? path : path.slice(idx + 1);
}

/**
 * Rows in sequence order. Missing files (entries without a PDF) are left
 * out; skipped files are kept with empty page columns so the list stays a
 * complete inventory of `papers/`.
 */
export function pageRangeRows(sequence: ResolvedSequence, opts?: { outputFor?: (path: string) => string }): PageRangeRow[] {
  const rows: PageRangeRow[] = [];
  for (const item of sequence.items) {
    if (item.missing) continue;
    const row: PageRangeRow = { filename: fileName(item.file), path: item.file, skipped: item.skipped };
    if (opts?.outputFor) row.output = opts.outputFor(item.file);
    if (item.pageStart !== undefined && item.pageEnd !== undefined) {
      row.page_start = item.pageStart;
      row.page_end = item.pageEnd;
    }
    if (item.pageCount !== undefined) row.page_count = item.pageCount;
    rows.push(row);
  }
  return rows;
}

function quoteField(value: string, delimiter: string): string {
  return value.includes(delimiter) || value.includes('"') || value.includes('\n') || value.includes('\r')
    ? `"${value.replace(/"/g, '""')}"`
    : value;
}

/**
 * `filename,page_start,page_end,page_count` with a header line, `\n` line
 * endings and RFC 4180 quoting. Pass `'\t'` for a TSV (clipboard-friendly).
 */
export function formatPageRangesTable(rows: readonly PageRangeRow[], delimiter: ',' | '\t' = ','): string {
  const lines = [PAGE_RANGE_COLUMNS.join(delimiter)];
  for (const row of rows) {
    lines.push(
      PAGE_RANGE_COLUMNS.map((col) => {
        const v = row[col];
        return v === undefined ? '' : quoteField(String(v), delimiter);
      }).join(delimiter),
    );
  }
  return `${lines.join('\n')}\n`;
}

export interface PageRangesDocument {
  generatedAt: string; // ISO-8601
  firstPage: number;
  lastPage?: number;
  files: PageRangeRow[];
}

/** Pretty-printed JSON with the same rows plus a small header. */
export function formatPageRangesJson(
  rows: readonly PageRangeRow[],
  meta: { generatedAt: string; firstPage: number; lastPage?: number },
): string {
  const doc: PageRangesDocument = { ...meta, files: [...rows] };
  return `${JSON.stringify(doc, null, 2)}\n`;
}
