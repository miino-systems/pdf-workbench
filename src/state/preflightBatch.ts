/**
 * "全 PDF を一括検査": run preflight on every source PDF, save each report,
 * and write an annotated review copy of every PDF with problems into the
 * preflight folder (default `preflight/`), plus `summary.csv` / `summary.json`
 * listing all files. Copies of files that now pass are removed, so the
 * folder always holds exactly the PDFs that still need attention.
 *
 * Rendering pages (for the raster margin and stamp-collision checks) needs
 * a canvas, so the UI passes a `rasterize` function; without one only the
 * object-based checks run.
 */
import type { PageSize, PreflightFinding, PreflightReport, PreflightWarningCode } from '@/core/types';
import { WORKBENCH_FILES } from '@/core/types';
import { toPt } from '@/core/units';
import { sha256 } from '@/crypto';
import { EVENT_TYPES } from '@/history';
import { formatTs } from '@/history/timestamp';
import { StampMetrics, measureLayers } from '@/pdf/stamper';
import {
  MAX_FINDINGS_PER_PAGE,
  annotatePreflightPdf,
  checkStampCollision,
  describePreflightCode,
  findMarginInkByRaster,
  marginsForPage,
  reportFileName,
  runPreflight,
  summarizeReport,
  type ImageDataLike,
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
  result.findings = [...(result.findings ?? []), ...found].slice(0, MAX_FINDINGS_PER_PAGE);
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
  opts: { rasterize?: Rasterizer; onProgress?: (done: number, total: number) => void } = {},
): Promise<PreflightBatchResult> {
  const ws = ctrl.requireWorkspace();
  const config = ws.preflight;
  const dir = preflightDir(ctrl);
  const files = ctrl.state.files.map((f) => f.path);
  const items: PreflightBatchItem[] = [];
  const ranAt = new Date();
  await ws.fs.mkdirp(dir);

  // Stamp collision: the enabled placements, measured with real metrics.
  const collision = config.checks?.stampCollision === true && !!opts.rasterize;
  const enabled = ws.stamps.instances.filter((i) => i.enabled);
  const metrics = new StampMetrics({
    resolveFont: (ref) => createFontResolver(ctrl).resolve(ref),
    readImage: (src) => ws.fs.readBytes(src),
  });
  if (collision) await metrics.prepare(ws.stamps.definitions);

  for (const [i, file] of files.entries()) {
    opts.onProgress?.(i, files.length);
    const stem = stripExtension(basename(file));
    const annotatedPath = `${dir}/${stem}_preflight.pdf`;
    try {
      const bytes = await ws.fs.readBytes(file);
      const report = await runPreflight(bytes, config, { file, sha256: await sha256(bytes), now: ranAt });

      if (opts.rasterize && (config.checks?.marginRaster || collision)) {
        const pageStart = sequenceItemFor(ctrl.state.sequence, file)?.pageStart;
        for await (const { page, pageSize, image } of opts.rasterize(bytes)) {
          const found: PreflightFinding[] = [];
          if (config.checks?.marginRaster && config.margins) {
            const m = marginsForPage(config.margins, config.marginOverrides, page, report.pageCount);
            found.push(
              ...findMarginInkByRaster(image, pageSize, {
                top: toPt(m.top, m.unit),
                bottom: toPt(m.bottom, m.unit),
                left: toPt(m.left, m.unit),
                right: toPt(m.right, m.unit),
              }),
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
      }

      const reportPath = `${WORKBENCH_FILES.reportsDir}/${reportFileName(file, ranAt)}`;
      await ws.fs.writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const item: PreflightBatchItem = { file, result: report.result, summary: summarizeReport(report), report: reportPath, pageCount: report.pageCount };
      if (report.result !== 'ok') {
        await ws.fs.writeBytes(annotatedPath, await annotatePreflightPdf(bytes, report, config));
        item.annotated = annotatedPath;
      } else if (await ws.fs.exists(annotatedPath)) {
        await ws.fs.remove(annotatedPath);
      }
      items.push(item);
    } catch (e) {
      console.error('preflight failed', file, e);
      items.push({ file, result: 'failed', summary: `検査できませんでした: ${e instanceof Error ? e.message : String(e)}` });
    }
  }
  opts.onProgress?.(files.length, files.length);

  const counts = { ok: 0, warning: 0, error: 0, failed: 0 };
  for (const it of items) counts[it.result === 'failed' ? 'failed' : it.result] += 1;
  const result: PreflightBatchResult = { dir, ranAt: formatTs(ranAt), configId: config.id, items, counts };

  const header = 'file,result,pages,problems,annotated';
  const rows = items.map((it) =>
    [it.file, it.result, it.pageCount, it.summary, it.annotated ?? ''].map(csvCell).join(','),
  );
  await ws.fs.writeText(`${dir}/summary.csv`, `﻿${[header, ...rows].join('\n')}\n`);
  await ws.fs.writeText(`${dir}/summary.json`, `${JSON.stringify(result, null, 2)}\n`);
  await ctrl.log(EVENT_TYPES.preflightBatch, { dir, files: items.length, ...counts });
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
