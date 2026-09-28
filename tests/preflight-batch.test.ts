/**
 * Batch preflight: every PDF is checked; PDFs with problems get an
 * annotated review copy in preflight/, clean ones don't (and lose a stale
 * copy), and a summary is written.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { AppController } from '@/state/app';
import { runPreflightBatch } from '@/state/preflightBatch';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4: [number, number] = [595.28, 841.89];

async function setup(): Promise<AppController> {
  const ctrl = new AppController();
  await ctrl.openHandle(createMemoryDirectory('ws'));
  await ctrl.initializePendingWorkspace();
  const ws = ctrl.requireWorkspace();
  await ctrl.updatePreflightConfig({
    ...ws.preflight,
    page: { size: 'A4' },
    margins: { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm' },
    checks: { marginText: true, marginRaster: true, stampCollision: true },
  });
  return ctrl;
}

describe('runPreflightBatch', () => {
  it('annotates only the PDFs with problems and writes a summary', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/bad.pdf', await buildFixturePdf([
      { size: A4, texts: [{ text: 'Body text', x: 100, y: 500 }] },
      { size: A4, texts: [{ text: 'Header in the margin', x: 100, y: 820 }] },
    ]));
    await ws.fs.writeBytes('papers/good.pdf', await buildFixturePdf([{ size: A4, texts: [{ text: 'Fine', x: 100, y: 500 }] }]));
    await ctrl.refreshFiles();

    const progress: number[] = [];
    const res = await runPreflightBatch(ctrl, { onProgress: (done) => progress.push(done) });
    expect(progress).toEqual([0, 1, 2]);
    expect(res.counts).toEqual({ ok: 1, warning: 1, error: 0, failed: 0 });
    const bad = res.items.find((i) => i.file === 'papers/bad.pdf')!;
    expect(bad.annotated).toBe('preflight/bad_preflight.pdf');
    expect(res.items.find((i) => i.file === 'papers/good.pdf')!.annotated).toBeUndefined();
    expect(await ws.fs.exists('preflight/good_preflight.pdf')).toBe(false);

    // The review copy keeps all pages and carries comments on page 2 only.
    const copy = await PDFDocument.load(await ws.fs.readBytes('preflight/bad_preflight.pdf'));
    expect(copy.getPageCount()).toBe(2);
    expect(copy.getPage(0).node.Annots()?.size() ?? 0).toBe(0);
    const annots = copy.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    const subtypes = annots.asArray().map((ref) => String(copy.context.lookup(ref, PDFDict).get(PDFName.of('Subtype'))));
    expect(subtypes).toContain('/Square');
    expect(subtypes).toContain('/Text');

    const csv = await ws.fs.readText('preflight/summary.csv');
    expect(csv).toContain('papers/bad.pdf,warning');
    expect(csv).toContain('papers/good.pdf,ok');
    const report = JSON.parse(await ws.fs.readText(bad.report!));
    expect(report.pages[1].findings[0]).toMatchObject({ code: 'TOP_MARGIN', source: 'text', text: 'Header in the margin' });

    // Fixed at the source: the stale review copy disappears on the next run.
    await ws.fs.writeBytes('papers/bad.pdf', await buildFixturePdf([{ size: A4, texts: [{ text: 'Body text', x: 100, y: 500 }] }]));
    await ctrl.refreshFiles();
    const again = await runPreflightBatch(ctrl);
    expect(again.counts.ok).toBe(2);
    expect(await ws.fs.exists('preflight/bad_preflight.pdf')).toBe(false);
  });
});
