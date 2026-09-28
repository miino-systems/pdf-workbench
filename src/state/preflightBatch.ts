/**
 * "全 PDF を一括検査": run preflight on every source PDF, save each report,
 * and write an annotated review copy of every PDF with problems into the
 * preflight folder (default `preflight/`), plus `summary.csv` / `summary.json`
 * listing all files. The folder is emptied first, so afterwards it holds
 * exactly the PDFs that still need attention, plus passed PDFs whose copy
 * only marks phantom findings (invisible margin content, for reference).
 * PDFs marked "検査スルー" (`PreflightConfig.skipFiles`) are not checked:
 * they are listed as `skipped` and get no copy.
 *
 * Rendering pages (for the raster margin and stamp-collision checks, and for
 * telling invisible margin text from real text) needs
 * a canvas, so the UI passes a `rasterize` function; without one only the
 * object-based checks run.
 */
import type {
  PageSize,
  PreflightConfig,
  PreflightFinding,
  PreflightMargins,
  StampInstance,
  PreflightReport,
  PreflightWarningCode,
  Rect,
} from '@/core/types';
import { WORKBENCH_FILES } from '@/core/types';
import { toPt } from '@/core/units';
import { sha256 } from '@/crypto';
import { EVENT_TYPES } from '@/history';
import { formatTs } from '@/history/timestamp';
import { StampMetrics, measureLayers } from '@/pdf/stamper';
import { decodeImageFile } from '@/pdf/reader/images';
import {
  annotatePreflightPdf,
  checkStampCollision,
  describePreflightCode,
  countInkInRect,
  findMarginInkByRaster,
  imageSignature,
  marginFindingsForItems,
  marginTolerancesPt,
  marginsForPage,
  mergeFindings,
  reportFileName,
  runPreflight,
  summarizeReport,
  type DuplicateProbe,
  type ImageDataLike,
  type ImageSignature,
  type PageTextBox,
} from '@/preflight';
import { sequenceItemFor } from '@/sequence';
import { effectivePosition, resolvePages, stampRect } from '@/stamps';
import { basename } from '@/workspace';
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
  result: PreflightReport['result'] | 'failed' | 'skipped';
  summary: string;
  /** Workspace path of the annotated copy (only for files with problems or phantom findings). */
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
  counts: { ok: number; warning: number; error: number; failed: number; skipped: number };
}

export const DEFAULT_PREFLIGHT_DIR = 'preflight';

export function preflightDir(ctrl: AppController): string {
  return ctrl.requireWorkspace().config.directories.preflight ?? DEFAULT_PREFLIGHT_DIR;
}

const SKIPPED_SUMMARY = '検査スルー（PDF タブで指定）';

/** Is `file` marked "検査スルー" (left out of the batch check)? */
export function isPreflightSkipped(config: PreflightConfig, file: string): boolean {
  return config.skipFiles?.includes(file) ?? false;
}

function addFindings(report: PreflightReport, page: number, found: PreflightFinding[]): void {
  const result = report.pages.find((p) => p.page === page);
  if (!result || found.length === 0) return;
  const codes = new Set<PreflightWarningCode>(result.warnings);
  for (const f of found) if (!f.phantom) codes.add(f.code);
  result.warnings = [...codes];
  result.findings = mergeFindings([...(result.findings ?? []), ...found]);
}

/**
 * The box a text run occupies including descenders (`y` is its baseline):
 * the raster check leaves these out, since the text check already judged
 * the run by its baseline and descenders below a last line are normal.
 */
function textInkRect(t: Rect): Rect {
  const descent = t.height * 0.3;
  return { x: t.x - 0.5, y: t.y - descent, width: t.width + 1, height: t.height + descent + 0.5 };
}

const MARGIN_CODES: readonly PreflightWarningCode[] = ['TOP_MARGIN', 'BOTTOM_MARGIN', 'LEFT_MARGIN', 'RIGHT_MARGIN'];

/**
 * Re-judge a page's text margin hits against its rendering: a run that
 * leaves no ink (invisible or white text, e.g. a leftover from the
 * template) stays in the findings as `phantom` but no longer counts.
 * Every hit is re-checked, not just the (capped) findings in the report.
 */
function markPhantomMarginText(
  report: PreflightReport,
  page: number,
  items: PageTextBox[],
  image: ImageDataLike,
  pageSize: PageSize,
  margins: PreflightMargins,
): void {
  const result = report.pages.find((p) => p.page === page);
  if (!result) return;
  const hits = marginFindingsForItems(items, pageSize, margins).findings.map((f) =>
    f.rect && countInkInRect(image, pageSize, textInkRect(f.rect)) === 0 ? { ...f, phantom: true } : f,
  );
  if (!hits.some((f) => f.phantom)) return;
  const isMarginText = (f: PreflightFinding): boolean => f.source === 'text' && MARGIN_CODES.includes(f.code);
  // Before the raster checks, the margin codes on a page come only from the text check.
  const visible = new Set(hits.filter((f) => !f.phantom).map((f) => f.code));
  result.warnings = result.warnings.filter((c) => !MARGIN_CODES.includes(c) || visible.has(c));
  result.findings = mergeFindings([...(result.findings ?? []).filter((f) => !isMarginText(f)), ...hits]);
}

/** Does the report hold findings kept only for reference (see `PreflightFinding.phantom`)? */
export function hasPhantomFindings(report: PreflightReport): boolean {
  return report.pages.some((p) => p.findings?.some((f) => f.phantom));
}

export interface PreflightOneOptions {
  rasterize?: Rasterizer;
  /** Stops between pages (throws an `AbortError`). */
  signal?: AbortSignal;
  now?: Date;
  /** Shared across a batch so fonts/images are loaded once. */
  metrics?: StampMetrics;
  /** Signatures of stamp images for the duplicate check, by `src`; shared across a batch. */
  signatures?: Map<string, Promise<ImageSignature | undefined>>;
}

/**
 * What each enabled stamp would add (its text layers' text, its image
 * layers' signatures), for the `STAMP_DUPLICATE` check. Page-number layers
 * are left out: numbers are everywhere in a paper.
 */
async function duplicateProbes(
  ctrl: AppController,
  signatures: Map<string, Promise<ImageSignature | undefined>>,
): Promise<{ probe: DuplicateProbe; pages: StampInstance['pages'] }[]> {
  const ws = ctrl.requireWorkspace();
  const out: { probe: DuplicateProbe; pages: StampInstance['pages'] }[] = [];
  for (const inst of ws.stamps.instances.filter((i) => i.enabled)) {
    const def = ws.stamps.definitions.find((d) => d.id === inst.stampId);
    if (!def) continue;
    const texts: string[] = [];
    const images: ImageSignature[] = [];
    for (const layer of def.layers) {
      if (layer.type === 'text' && layer.text.trim()) texts.push(layer.text);
      if (layer.type === 'image') {
        let sig = signatures.get(layer.src);
        if (!sig) {
          sig = ws.fs
            .readBytes(layer.src)
            .then(decodeImageFile)
            .then((img) => (img ? imageSignature(img) : undefined))
            .catch((e: unknown) => {
              console.warn('preflight: stamp image unreadable, skipped in the duplicate check', layer.src, e);
              return undefined;
            });
          signatures.set(layer.src, sig);
        }
        const found = await sig;
        if (found) images.push(found);
      }
    }
    if (texts.length || images.length) out.push({ probe: { name: def.name, texts, images }, pages: inst.pages });
  }
  return out;
}

/**
 * Preflight one PDF: the object-based checks (and, when enabled, whether a
 * stamp's text or image is already in it), then (with `rasterize`) the
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
  const probes = config.checks?.stampDuplicate ? await duplicateProbes(ctrl, opts.signatures ?? new Map()) : [];
  const report = await runPreflight(bytes, config, {
    file,
    sha256: await sha256(bytes),
    now: opts.now,
    onPageText: (page, items) => texts.set(page, items),
    duplicates: probes.length
      ? (page, pageCount) => probes.filter((p) => resolvePages(p.pages, pageCount).includes(page)).map((p) => p.probe)
      : undefined,
  });

  const collision = config.checks?.stampCollision === true && !!opts.rasterize;
  const phantomText = config.checks?.marginText === true && !!config.margins;
  if (!opts.rasterize || !(config.checks?.marginRaster || collision || phantomText)) return report;

  const enabled = ws.stamps.instances.filter((i) => i.enabled);
  const metrics = opts.metrics ?? newStampMetrics(ctrl);
  if (collision) await metrics.prepare(ws.stamps.definitions);
  const pageStart = sequenceItemFor(ctrl.state.sequence, file)?.pageStart;

  for await (const { page, pageSize, image } of opts.rasterize(bytes)) {
    opts.signal?.throwIfAborted();
    const found: PreflightFinding[] = [];
    if (phantomText && config.margins) {
      const m = marginsForPage(config.margins, config.marginOverrides, page, report.pageCount);
      markPhantomMarginText(report, page, texts.get(page) ?? [], image, pageSize, m);
    }
    if (config.checks?.marginRaster && config.margins) {
      const m = marginsForPage(config.margins, config.marginOverrides, page, report.pageCount);
      found.push(
        ...findMarginInkByRaster(
          image,
          pageSize,
          { top: toPt(m.top, m.unit), bottom: toPt(m.bottom, m.unit), left: toPt(m.left, m.unit), right: toPt(m.right, m.unit) },
          { tolerance: marginTolerancesPt(config.margins), ignore: (texts.get(page) ?? []).filter((t) => t.str.trim()).map(textInkRect) },
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

/** The result from the codes now on the report (the same rule as `runPreflight`). */
function recomputeResult(report: PreflightReport): void {
  const docError = report.documentWarnings.some((c) => c === 'PAGE_COUNT_MIN' || c === 'PAGE_COUNT_MAX');
  if (docError || report.pages.some((p) => (p.errors?.length ?? 0) > 0)) report.result = 'error';
  else if (report.documentWarnings.length > 0 || report.pages.some((p) => p.warnings.length > 0)) report.result = 'warning';
  else report.result = 'ok';
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
  const signatures = new Map<string, Promise<ImageSignature | undefined>>();

  let cancelled = false;
  for (const [i, file] of files.entries()) {
    opts.onProgress?.(i, files.length);
    if (opts.signal?.aborted) {
      cancelled = true;
      break;
    }
    if (isPreflightSkipped(config, file)) {
      items.push({ file, result: 'skipped', summary: SKIPPED_SUMMARY });
      continue;
    }
    const annotatedPath = ctrl.preflightCopyPathFor(file, dir);
    try {
      const bytes = await ws.fs.readBytes(file);
      const report = await preflightOne(ctrl, file, bytes, { rasterize: opts.rasterize, now: ranAt, metrics, signatures, signal: opts.signal });

      const reportPath = `${WORKBENCH_FILES.reportsDir}/${reportFileName(file, ranAt)}`;
      await ws.fs.writeText(reportPath, `${JSON.stringify(report, null, 2)}\n`);
      const item: PreflightBatchItem = { file, result: report.result, summary: summarizeReport(report), report: reportPath, pageCount: report.pageCount };
      if (report.result !== 'ok' || hasPhantomFindings(report)) {
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

  const counts = countResults(items);
  const result: PreflightBatchResult = { dir, ranAt: formatTs(ranAt), configId: config.id, items, counts, total: files.length, cancelled };

  await writeSummary(ctrl, result);
  await ctrl.log(EVENT_TYPES.preflightBatch, { dir, files: items.length, total: files.length, ...(cancelled ? { cancelled } : {}), ...counts });
  return result;
}

function countResults(items: PreflightBatchItem[]): PreflightBatchResult['counts'] {
  const counts = { ok: 0, warning: 0, error: 0, failed: 0, skipped: 0 };
  for (const it of items) counts[it.result] += 1;
  return counts;
}

/** Write `summary.csv` / `summary.json` for `result` into its folder. */
async function writeSummary(ctrl: AppController, result: PreflightBatchResult): Promise<void> {
  const ws = ctrl.requireWorkspace();
  const header = 'file,result,pages,problems,annotated';
  const rows = result.items.map((it) =>
    [it.file, it.result, it.pageCount, it.summary, it.annotated ?? ''].map(csvCell).join(','),
  );
  await ws.fs.writeText(`${result.dir}/summary.csv`, `\uFEFF${[header, ...rows].join('\n')}\n`);
  await ws.fs.writeText(`${result.dir}/summary.json`, `${JSON.stringify(result, null, 2)}\n`);
}

/**
 * "1 件だけ検査": check one PDF like the batch does and keep the preflight
 * folder consistent — write its annotated review copy when it has problems
 * (remove a stale one when it passes) and, when a batch summary exists,
 * update that file's row in it. A file marked "検査スルー" is checked
 * all the same (it was asked for by name) but leaves the folder alone.
 */
export async function preflightSingle(
  ctrl: AppController,
  file: string,
  bytes: Uint8Array,
  opts: { rasterize?: Rasterizer } = {},
): Promise<{ report: PreflightReport; annotated?: string }> {
  const ws = ctrl.requireWorkspace();
  const dir = preflightDir(ctrl);
  const annotatedPath = ctrl.preflightCopyPathFor(file, dir);
  const report = await preflightOne(ctrl, file, bytes, { rasterize: opts.rasterize });
  if (isPreflightSkipped(ws.preflight, file)) return { report };
  let annotated: string | undefined;
  if (report.result !== 'ok' || hasPhantomFindings(report)) {
    await ws.fs.writeBytes(annotatedPath, await annotatePreflightPdf(bytes, report, ws.preflight));
    annotated = annotatedPath;
  } else if (await ws.fs.exists(annotatedPath)) {
    await ws.fs.remove(annotatedPath);
  }

  const summary = await loadPreflightSummary(ctrl);
  if (summary) {
    const item: PreflightBatchItem = { file, result: report.result, summary: summarizeReport(report), pageCount: report.pageCount, annotated };
    const i = summary.items.findIndex((it) => it.file === file);
    if (i >= 0) summary.items[i] = { ...summary.items[i], ...item, annotated };
    else summary.items.push(item);
    summary.counts = countResults(summary.items);
    await writeSummary(ctrl, summary);
  }
  return { report, annotated };
}

/** The last batch summary saved in the preflight folder, if any. */
export async function loadPreflightSummary(ctrl: AppController): Promise<PreflightBatchResult | undefined> {
  const ws = ctrl.requireWorkspace();
  try {
    const summary = JSON.parse(await ws.fs.readText(`${preflightDir(ctrl)}/summary.json`)) as PreflightBatchResult;
    // Summaries from before "検査スルー" have no `skipped` count.
    summary.counts = countResults(summary.items);
    return summary;
  } catch {
    return undefined;
  }
}

/**
 * Mark / unmark `file` as "検査スルー" (PDF tab). The last batch summary
 * follows along so the preflight folder stays consistent: a skipped file's
 * row becomes `skipped` and its annotated copy is removed; an unskipped
 * file's row is dropped (it has not been checked yet).
 */
export async function setPreflightSkipped(ctrl: AppController, file: string, skip: boolean): Promise<void> {
  const ws = ctrl.requireWorkspace();
  const current = ws.preflight.skipFiles ?? [];
  if (current.includes(file) === skip) return;
  const skipFiles = skip ? [...current, file].sort() : current.filter((f) => f !== file);
  const { skipFiles: _drop, ...rest } = ws.preflight;
  await ctrl.updatePreflightConfig(skipFiles.length ? { ...rest, skipFiles } : rest);
  if (isPreflightSkipped(ws.preflight, file) !== skip) return; // not saved (edited externally)

  const summary = await loadPreflightSummary(ctrl);
  if (!summary) return;
  const i = summary.items.findIndex((it) => it.file === file);
  if (skip) {
    const annotated = summary.items[i]?.annotated ?? ctrl.preflightCopyPathFor(file, summary.dir);
    if (await ws.fs.exists(annotated)) await ws.fs.remove(annotated);
    const item: PreflightBatchItem = { file, result: 'skipped', summary: SKIPPED_SUMMARY };
    if (i >= 0) summary.items[i] = item;
    else summary.items.push(item);
  } else {
    if (i < 0) return;
    summary.items.splice(i, 1);
  }
  summary.counts = countResults(summary.items);
  await writeSummary(ctrl, summary);
}

/** Every problem code of a report in plain Japanese, for listings. */
export function describeProblems(codes: PreflightWarningCode[], config?: PreflightConfig): string {
  return [...new Set(codes)].map((c) => describePreflightCode(c, config)).join('，');
}
