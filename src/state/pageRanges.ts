/**
 * "Export page ranges": write the continuous numbering of every source PDF
 * (`filename, page_start, page_end, page_count`) into `output/` as CSV and
 * JSON, e.g. to build a table of contents or a proceedings index.
 */
import { EVENT_TYPES } from '@/history';
import {
  PAGE_RANGES_BASENAME,
  formatPageRangesJson,
  formatPageRangesTable,
  pageRangeRows,
  type PageRangeRow,
} from '@/sequence';
import { basename, joinPath } from '@/workspace';
import type { AppController } from './app';

export interface PageRangesExport {
  csv: string;
  json: string;
  rows: PageRangeRow[];
}

/** Rows for the currently resolved sequence, with the stamped output names filled in. */
export function currentPageRangeRows(ctrl: AppController): PageRangeRow[] {
  const seq = ctrl.state.sequence;
  if (!seq) return [];
  return pageRangeRows(seq, { outputFor: (p) => basename(ctrl.outputPathFor(p)) });
}

/** Write `output/page-ranges.csv` and `output/page-ranges.json` and return their paths. */
export async function exportPageRanges(ctrl: AppController): Promise<PageRangesExport> {
  const ws = ctrl.requireWorkspace();
  const seq = await ctrl.refreshSequence();
  if (!seq) throw new Error('通しページ番号を解決できませんでした');
  const rows = pageRangeRows(seq, { outputFor: (p) => basename(ctrl.outputPathFor(p)) });
  const csv = joinPath(ws.config.directories.output, `${PAGE_RANGES_BASENAME}.csv`);
  const json = joinPath(ws.config.directories.output, `${PAGE_RANGES_BASENAME}.json`);
  await ws.fs.writeText(csv, formatPageRangesTable(rows, ','));
  await ws.fs.writeText(
    json,
    formatPageRangesJson(rows, {
      generatedAt: new Date().toISOString(),
      firstPage: ws.sequence.firstPage,
      lastPage: seq.lastPage,
    }),
  );
  await ctrl.log(EVENT_TYPES.sequenceExported, { csv, json, files: rows.length, lastPage: seq.lastPage });
  return { csv, json, rows };
}
