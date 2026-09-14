/**
 * "Generate PDF": the core Phase 1 workflow.
 *
 *   papers/x.pdf ──read──▶ applyStamps (pdf-lib, existing pages) ──▶ output/x_stamped.pdf
 *
 * The source file is only ever read. Fonts and images are resolved from the
 * workspace (or the in-memory picked-file cache); nothing leaves the browser.
 */
import type { FontRef, JobRecord, ResolvedFont } from '@/core/types';
import { sha256 } from '@/crypto';
import { FontResolver, fontWarningMessage, withHash } from '@/fonts';
import { EVENT_TYPES } from '@/history';
import { applyStamps } from '@/pdf/stamper';
import { createId } from '@/stamps';
import { basename } from '@/workspace';
import type { AppController } from './app';

/** Font files picked by the user with `<input type=file>` live here for the session. */
export const pickedFontFiles = new Map<string, Uint8Array>();

export interface GenerateResult {
  output: string;
  job: JobRecord;
  warnings: string[];
}

export function createFontResolver(ctrl: AppController): FontResolver {
  const ws = ctrl.requireWorkspace();
  return new FontResolver({
    readWorkspaceFile: (path) => ws.fs.readBytes(path),
    pickedFiles: pickedFontFiles,
  });
}

/**
 * Generate the stamped PDF for `sourcePath` using the currently enabled
 * stamp instances. Returns undefined when nothing was generated.
 */
export async function generateStampedPdf(ctrl: AppController, sourcePath: string): Promise<GenerateResult | undefined> {
  const ws = ctrl.requireWorkspace();
  const enabled = ws.stamps.instances.filter((i) => i.enabled);
  if (enabled.length === 0) {
    ctrl.toast('warn', '有効なスタンプがありません．Stamps タブでスタンプを有効にしてください．');
    return undefined;
  }

  const sourceBytes = await ws.fs.readBytes(sourcePath);
  const sourceHash = await sha256(sourceBytes);
  const outputPath = ctrl.outputPathFor(sourcePath);
  const resolver = createFontResolver(ctrl);
  const resolvedFonts = new Map<string, ResolvedFont>();
  const warnings: string[] = [];

  const resolveFont = async (ref: FontRef): Promise<ResolvedFont> => {
    const r = await resolver.resolve(ref);
    const key = JSON.stringify({ ...ref, sha256: undefined });
    if (!resolvedFonts.has(key)) {
      resolvedFonts.set(key, r);
      const w = fontWarningMessage(r);
      if (w) warnings.push(`${describeFont(ref)}: ${w}`);
    }
    return r;
  };

  const result = await applyStamps({
    sourceBytes,
    definitions: ws.stamps.definitions,
    instances: enabled,
    fileName: basename(sourcePath),
    resolveFont,
    resolveImage: (src) => ws.fs.readBytes(src),
  });
  warnings.push(...result.warnings);

  // Never write into papers/: outputPathFor always maps to the output dir.
  if (outputPath === sourcePath) throw new Error('出力先が元 PDF と同じです');
  await ws.fs.writeBytes(outputPath, result.bytes);
  const outputHash = await sha256(result.bytes);

  // Persist the font hashes we actually used so later runs can detect changes.
  await ctrl.updateStamps((cfg) => {
    for (const def of cfg.definitions) {
      for (const layer of def.layers) {
        if ((layer.type === 'text' || layer.type === 'pageNumber') && layer.font.kind !== 'standard') {
          const key = JSON.stringify({ ...layer.font, sha256: undefined });
          const r = resolvedFonts.get(key);
          if (r) layer.font = withHash(layer.font, r);
        }
      }
    }
  });

  const job: JobRecord = {
    id: createId('job'),
    source: sourcePath,
    sourceHash,
    output: outputPath,
    outputHash,
    stampInstances: result.applied.map((a) => a.instanceId),
    fonts: result.fonts,
    createdAt: new Date().toISOString(),
    status: warnings.length ? 'warning' : 'processed',
    message: warnings.length ? warnings.join('\n') : undefined,
  };
  await ctrl.recordJob(job);
  await ctrl.log(EVENT_TYPES.pdfGenerated, {
    source: basename(sourcePath),
    output: basename(outputPath),
    sourceHash,
    outputHash,
    stamps: job.stampInstances,
    pages: result.pageCount,
  });
  await ctrl.refreshFiles();
  return { output: outputPath, job, warnings };
}

export function describeFont(ref: FontRef): string {
  switch (ref.kind) {
    case 'standard':
      return ref.name;
    case 'local':
      return ref.fullName ?? ref.postscriptName;
    case 'workspace':
      return ref.path;
    case 'file':
      return ref.name;
  }
}
