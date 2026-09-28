import { WORKBENCH_FILES, type PreflightReport } from '@/core/types';

/** Strip a workspace-relative path down to its file stem (no directories, no extension). */
function baseNameWithoutExt(path: string): string {
  const name = path.split('/').pop() ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * File name for a preflight report saved under `.pdf-workbench/reports/`:
 * one per PDF, overwritten on every check (when it ran is the report's
 * `ranAt`), e.g. `reportFileName('papers/paper001.pdf')` → `paper001.json`.
 */
export function reportFileName(file: string): string {
  return `${baseNameWithoutExt(file)}.json`;
}

/** Workspace-relative path of `file`'s report. */
export function reportPath(file: string): string {
  return `${WORKBENCH_FILES.reportsDir}/${reportFileName(file)}`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether `name` is one of `file`'s reports in the old one-file-per-run
 * format, `<stem>.<YYYYMMDDTHHMMSS>.json`. Only that timestamp matches, so
 * `paper.v2.json` (the report of `paper.v2.pdf`) is not taken for one of
 * `paper.pdf`'s.
 */
export function isLegacyReportName(file: string, name: string): boolean {
  return new RegExp(`^${escapeRegExp(baseNameWithoutExt(file))}\\.\\d{8}T\\d{6}\\.json$`).test(name);
}

/** Longest finding `text` kept in a saved report (the offending text, not the page's). */
export const REPORT_TEXT_MAX = 80;

function clip(text: string): string {
  const chars = [...text];
  return chars.length > REPORT_TEXT_MAX ? `${chars.slice(0, REPORT_TEXT_MAX).join('')}…` : text;
}

/** `report` as saved: finding texts cut to `REPORT_TEXT_MAX` characters. */
export function serializeReport(report: PreflightReport): string {
  const pages = report.pages.map((p) =>
    p.findings ? { ...p, findings: p.findings.map((f) => (f.text === undefined ? f : { ...f, text: clip(f.text) })) } : p,
  );
  return `${JSON.stringify({ ...report, pages }, null, 2)}\n`;
}

/** What saving and removing reports needs from the workspace. */
export interface ReportFS {
  writeText(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  remove(path: string): Promise<void>;
  list(dir: string, opts?: { extensions?: string[] }): Promise<{ name: string }[]>;
}

/** Names of the files in the reports folder, for `saveReportFile` / `removeReportFiles` in a loop. */
export async function listReportNames(fs: ReportFS): Promise<string[]> {
  return (await fs.list(WORKBENCH_FILES.reportsDir, { extensions: ['.json'] })).map((e) => e.name);
}

async function removeLegacyReports(fs: ReportFS, file: string, names: string[]): Promise<void> {
  for (const name of names) {
    if (isLegacyReportName(file, name)) await fs.remove(`${WORKBENCH_FILES.reportsDir}/${name}`);
  }
}

/**
 * Save `report` over its PDF's report and remove that PDF's reports in the
 * old per-run format. `names` is the reports folder's listing (listed here
 * when not given). Returns the report's path.
 */
export async function saveReportFile(fs: ReportFS, report: PreflightReport, names?: string[]): Promise<string> {
  const path = reportPath(report.file);
  await fs.writeText(path, serializeReport(report));
  await removeLegacyReports(fs, report.file, names ?? (await listReportNames(fs)));
  return path;
}

/** Remove `file`'s report, old per-run ones included (for a PDF marked "検査スルー"). */
export async function removeReportFiles(fs: ReportFS, file: string, names?: string[]): Promise<void> {
  const path = reportPath(file);
  if (await fs.exists(path)) await fs.remove(path);
  await removeLegacyReports(fs, file, names ?? (await listReportNames(fs)));
}

/** Problem counts of a report, as logged with `preflight.run` (the report file keeps only the latest run). */
export function reportProblemCounts(report: PreflightReport): { errors: number; warnings: number } {
  let errors = 0;
  let warnings = 0;
  for (const c of report.documentWarnings) {
    if (c === 'PAGE_COUNT_MIN' || c === 'PAGE_COUNT_MAX') errors += 1;
    else warnings += 1;
  }
  for (const p of report.pages) {
    errors += p.errors?.length ?? 0;
    warnings += p.warnings.length;
  }
  return { errors, warnings };
}

/** Short Japanese one-liner summarising a report, for lists/toasts. */
export function summarizeReport(report: PreflightReport): string {
  const pageInfo = `${report.pageCount}ページ`;
  if (report.result === 'ok') {
    const phantoms = report.pages.reduce((n, p) => n + (p.findings?.filter((f) => f.phantom).length ?? 0), 0);
    return phantoms ? `問題なし (${pageInfo})．見えない要素 ${phantoms} 箇所（注釈のみ）` : `問題なし (${pageInfo})`;
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
    return `エラーあり (${pagesWithErrors}/${report.pageCount}ページ): ${codeList}`;
  }
  return `警告あり (${pagesWithWarnings}/${report.pageCount}ページ): ${codeList}`;
}
