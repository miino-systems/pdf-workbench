import type { PreflightReport } from '@/core/types';

/** Zero-pad a number to `width` digits. */
function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/** `YYYYMMDDTHHMMSS` in local time (matches `history/`'s `snapshotFileName` convention). */
function formatCompactTimestamp(date: Date): string {
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** Strip a workspace-relative path down to its file stem (no directories, no extension). */
function baseNameWithoutExt(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * File name for a preflight report saved under
 * `.pdf-workbench/reports/`, e.g. `reportFileName('papers/paper001.pdf', new Date(...))`
 * → `paper001.20260914T103012.json`.
 */
export function reportFileName(file: string, date: Date = new Date()): string {
  return `${baseNameWithoutExt(file)}.${formatCompactTimestamp(date)}.json`;
}

/** Short Japanese one-liner summarising a report, for lists/toasts. */
export function summarizeReport(report: PreflightReport): string {
  const pageInfo = `${report.pageCount}ページ`;
  if (report.result === 'ok') {
    return `✓ 問題なし (${pageInfo})`;
  }

  const pagesWithErrors = report.pages.filter((p) => (p.errors?.length ?? 0) > 0).length;
  const pagesWithWarnings = report.pages.filter((p) => p.warnings.length > 0).length;
  const codes = new Set<string>(report.documentWarnings);
  for (const p of report.pages) {
    for (const c of p.errors ?? []) codes.add(c);
    for (const c of p.warnings) codes.add(c);
  }
  const codeList = [...codes].join(', ');

  if (report.result === 'error') {
    return `✗ エラーあり (${pagesWithErrors}/${report.pageCount}ページ): ${codeList}`;
  }
  return `⚠ 警告あり (${pagesWithWarnings}/${report.pageCount}ページ): ${codeList}`;
}
