/**
 * "全 PDF を一括検査": run preflight on every source PDF, save each report,
 * and write an annotated review copy of every PDF with problems into the
 * preflight folder (default `preflight/`), plus `summary.csv` / `summary.json`
 * listing all files. The folder is emptied first, so afterwards it holds
 * exactly the PDFs that still need attention.
 *
 * Rendering pages (for the raster margin and stamp-collision checks) needs
 * a canvas, so the UI passes a `rasterize` function; without one only the
 * object-based checks run.
 */
import type { PageSize, PreflightFinding, PreflightReport, PreflightWarningCode, Rect } from '@/core/types';
import { WORKBENCH_FILES } from '@/core/types';
import { toPt } from '@/core/units';
import { sha256 } from '@/crypto';
import { EVENT_TYPES } from '@/history';
import { formatTs } from '@/history/timestamp';
import { StampMetrics, measureLayers } from '@/pdf/stamper';
import {
  annotatePreflightPdf,
  checkStampCollision,
  describePreflightCode,
  findMarginInkByRaster,
  marginTolerancePt,
  marginsForPage,
  mergeFindings,
  reportFileName,
  runPreflight,
  summarizeReport,
  type ImageDataLike,
  type PageTextBox,
} from '@/preflight';
import { sequenceItemFor } from '@/sequence';
import { effectivePosition, resolvePages, stampRect } from '@/stamps';
import { basename, stripExtension } from '@/workspace';
import type { AppController } from './app';
import { createFontResolver } from './generate';

/** One rendered page: `image` covers the whole visible page, row 0 at the top. */
export interface PageRaster {
  page: number;
  pageSize: PageSize;
  image: ImageDataLike;
}

export type Rasterizer = (bytes: Uint8Array) => AsyncIterable<PageRaster>;

export interface PreflightBatchItem {
  file: string;
  result: PreflightReport['result'] | 'failed';
  summary: string;
  /** Workspace path of the annotated copy (only for files with problems). */
  annotated?: string;
  /** Workspace path of the saved JSON report. */
  report?: string;
  pageCount?: number;
}

export interface PreflightBatchResult {
  /** Stopped before every file was checked: the summary lists only the files checked so far. */
  cancelled?: boolean;
  /** Number of files the run was started for. */
  total?: number;
  dir: string;
  ranAt: string;
  configId: string;
  items: PreflightBatchItem[];
  counts: { ok: number; warning: number; error: number; failed: number };
}

export const DEFAULT_PREFLIGHT_DIR = 'preflight';

export function preflightDir(ctrl: AppController): string {
  return ctrl.requireWorkspace().config.directories.preflight ?? DEFAULT_PREFLIGHT_DIR;
}

function addFindings(report: PreflightReport, page: number, found: PreflightFinding[]): void {
  const result = report.pages.find((p) => p.page === page);
  if (!result || found.length === 0) return;
  const codes = new Set<PreflightWarningCode>(result.warnings);
  for (const f of found) codes.add(f.code);
  result.warnings = [...codes];
  result.findings = mergeFindings([...(result.findings ?? []), ...found]);
}

/**
 * The box a text run occupies including descenders (`y` is its baseline):
 * the raster check leaves these out, since the text check already judged
 * the run by its baseline and descenders below a last line are normal.
 */
function textInkRect(t: PageTextBox): Rect {
  const descent = t.height * 0.3;
  return { x: t.x - 0.5, y: t.y - descent, width: t.width + 1, height: t.height + descent + 0.5 };
}

export interface PreflightOneOptions {
  rasterize?: Rasterizer;
  /** Stops between pages (throws an `AbortError`). */
  signal?: AbortSignal;
  now?: Date;
  /** Shared across a batch so fonts/images are loaded once. */
  metrics?: StampMetrics;
}

/**
 * Preflight one PDF: the object-based checks, then (with `rasterize`) the
 * raster margin check and the stamp-collision check for the enabled
 * placements. Used by the batch and by the single-file check.
 */
export async function preflightOne(
  ctrl: AppController,
  file: string,
  bytes: Uint8Array,
  opts: PreflightOneOptions = {},
): Promise<PreflightReport> {
  const ws = ctrl.requireWorkspace();
  const config = ws.preflight;
  const texts = new Map<number, PageTextBox[]>();
  const report = await runPreflight(bytes, config, {
    file,
    sha256: await sha256(bytes),
    now: opts.now,
    onPageText: (page, items) => texts.set(page, items),
  });

  const collision = config.checks?.stampCollision === true && !!opts.rasterize;
  if (!opts.rasterize || !(config.checks?.marginRaster || collision)) return report;

  const enabled = ws.stamps.instances.filter((i) => i.enabled);
  const metrics = opts.metrics ?? newStampMetrics(ctrl);
  if (collision) await metrics.prepare(ws.stamps.definitions);
  const pageStart = sequenceItemFor(ctrl.state.sequence, file)?.pageStart;

  for await (const { page, pageSize, image } of opts.rasterize(bytes)) {
    opts.signal?.throwIfAborted();
    const found: PreflightFinding[] = [];
    if (config.checks?.marginRaster && config.margins) {
      const m = marginsForPage(config.margins, config.marginOverrides, page, report.pageCount);
      found.push(
        ...findMarginInkByRaster(
          image,
          pageSize,
          { top: toPt(m.top, m.unit), bottom: toPt(m.bottom, m.unit), left: toPt(m.left, m.unit), right: toPt(m.right, m.unit) },
          { tolerance: marginTolerancePt(config.margins), ignore: (texts.get(page) ?? []).filter((t) => t.str.trim()).map(textInkRect) },
        ),
      );
    }
    if (collision) {
      for (const inst of enabled) {
        const def = ws.stamps.definitions.find((d) => d.id === inst.stampId);
        if (!def || !resolvePages(inst.pages, report.pageCount).includes(page)) continue;
        const box = measureLayers(
          def.layers,
          { page: pageStart !== undefined ? pageStart + page - 1 : page, pages: report.pageCount, file: basename(file), fonts: metrics.fonts, images: metrics.images },
          def.layout,
        );
        const rect = stampRect(effectivePosition(def, inst), pageSize, box);
        if (checkStampCollision(image, pageSize, rect).collides) found.push({ code: 'STAMP_COLLISION', source: 'stamp', rect, text: def.name });
      }
    }
    addFindings(report, page, found);
  }
  recomputeResult(report);
  return report;
}

function newStampMetrics(ctrl: AppController): StampMetrics {
  const ws = ctrl.requireWorkspace();
  return new StampMetrics({
    resolveFont: (ref) => createFontResolver(ctrl).resolve(ref),
    readImage: (src) => ws.fs.readBytes(src),
  });
}

function recomputeResult(report: PreflightReport): void {
  if (report.result === 'error') return;
  if (report.pages.some((p) => (p.errors?.length ?? 0) > 0)) report.result = 'error';
  else if (report.pages.some((p) => p.warnings.length > 0)) report.result = 'warning';
}

function csvCell(v: string | number | undefined): string {
  const s = v === undefined ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function runPreflightBatch(
  ctrl: AppController,
  opts: { rasterize?: Rasterizer; onProgress?: (done: number, total: number) => void; signal?: AbortSignal } = {},
): Promise<PreflightBatchResult> {
  const ws = ctrl.requireWorkspace();
  const config = ws.preflight;
  const dir = preflightDir(ctrl);
  const files = ctrl.state.files.map((f) => f.path);
  const items: PreflightBatchItem[] = [];
  const ranAt = new Date();
  await ctrl.clearGeneratedDir(dir);

  const metrics = newStampMetrics(ctrl);

  let cancelled = false;
  for (const [i, file] of files.entries()) {
    opts.onProgress?.(i, files.length);
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    const stem = stripExtension(basename(file));
    const annotatedPath = `${dir}/${stem}_preflight.pdf`;
    try {
      const bytes = await ws.fs.readBytes(file);
      const report = await preflightOne(ctrl, file, bytes, { rasterize: opts.rasterize, now: ranAt, metrics, signal: opts.signal });

      const reportPath = `${WORKBENCH_FILES.reportsDir}/${reportFileName(file, ranAt)}`;
      await ws.fs.writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const item: PreflightBatchItem = { file, result: report.result, summary: summarizeReport(report), report: reportPath, pageCount: report.pageCount };
      if (report.result !== 'ok') {
        await ws.fs.writeBytes(annotatedPath, await annotatePreflightPdf(bytes, report, config));
        item.annotated = annotatedPath;
      }
      items.push(item);
    } catch (e) {
      if (opts.signal?.aborted) {
        // Stopped mid-file: that file is neither reported nor annotated.
        cancelled = true;
        break;
      }
      console.error('preflight failed', file, e);
      items.push({ file, result: 'failed', summary: `検査できませんでした: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  if (!cancelled) opts.onProgress?.(files.length, files.length);

  const counts = { ok: 0, warning: 0, error: 0, failed: 0 };
  for (const it of items) counts[it.result === 'failed' ? 'failed' : it.result] += 1;
  const result: PreflightBatchResult = { dir, ranAt: formatTs(ranAt), configId: config.id, items, counts, total: files.length, cancelled };

  const header = 'file,result,pages,problems,annotated';
  const rows = items.map((it) =>
    [it.file, it.result, it.pageCount, it.summary, it.annotated ?? ''].map(csvCell).join(','),
  );
  await ws.fs.writeText(`${dir}/summary.csv`, `\uFEFF${[header, ...rows].join('\n')}\n`);
  await ws.fs.writeText(`${dir}/summary.json`, `${JSON.stringify(result, null, 2)}\n`);
  await ctrl.log(EVENT_TYPES.preflightBatch, { dir, files: items.length, total: files.length, ...(cancelled ? { cancelled } : {}), ...counts });
  return result;
}

/** The last batch summary saved in the preflight folder, if any. */
export async function loadPreflightSummary(ctrl: AppController): Promise<PreflightBatchResult | undefined> {
  const ws = ctrl.requireWorkspace();
  try {
    return JSON.parse(await ws.fs.readText(`${preflightDir(ctrl)}/summary.json`)) as PreflightBatchResult;
  } catch {
    return undefined;
  }
}

/** Every problem code of a report in plain Japanese, for listings. */
export function describeProblems(codes: PreflightWarningCode[]): string {
  return [...new Set(codes)].map(describePreflightCode).join('，');
}
