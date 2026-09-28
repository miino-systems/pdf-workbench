/**
 * Batch preflight: every PDF is checked; PDFs with problems get an
 * annotated review copy in preflight/, clean ones don't (and lose a stale
 * copy), and a summary is written.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { AppController } from '@/state/app';
import { runPreflightBatch, type Rasterizer } from '@/state/preflightBatch';
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
    expect(bad.annotated).toBe('preflight/bad_stamped_preflight.pdf');
    expect(res.items.find((i) => i.file === 'papers/good.pdf')!.annotated).toBeUndefined();
    expect(await ws.fs.exists('preflight/good_stamped_preflight.pdf')).toBe(false);

    // The review copy keeps all pages and carries comments on page 2 only.
    const copy = await PDFDocument.load(await ws.fs.readBytes('preflight/bad_stamped_preflight.pdf'));
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
    expect(await ws.fs.exists('preflight/bad_stamped_preflight.pdf')).toBe(false);
  });
});

describe('full re-runs and cancelling', () => {
  it('empties the preflight folder before a batch, and stops when cancelled', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    const bad = await buildFixturePdf([{ size: A4, texts: [{ text: 'Header in the margin', x: 100, y: 820 }] }]);
    for (const n of ['a', 'b', 'c']) await ws.fs.writeBytes(`papers/${n}.pdf`, bad);
    await ws.fs.writeText('preflight/old_leftover.pdf', 'stale');
    await ctrl.refreshFiles();

    const ac = new AbortController();
    const res = await runPreflightBatch(ctrl, {
      signal: ac.signal,
      onProgress: (done) => {
        if (done === 1) ac.abort(); // stop after the first file
      },
    });
    expect(res.cancelled).toBe(true);
    expect(res.total).toBe(3);
    expect(res.items.map((i) => i.file)).toEqual(['papers/a.pdf']);
    expect(await ws.fs.exists('preflight/old_leftover.pdf')).toBe(false);
    expect(await ws.fs.exists('preflight/a_stamped_preflight.pdf')).toBe(true);
    expect(await ws.fs.exists('preflight/b_stamped_preflight.pdf')).toBe(false);
    expect(JSON.parse(await ws.fs.readText('preflight/summary.json')).cancelled).toBe(true);
  });

  it('clears output/ and forgets the jobs, but refuses source and settings folders', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: A4 }]));
    await ctrl.refreshFiles();
    await ctrl.setInstanceEnabled(ws.stamps.instances[0].id, true);
    const { generateStampedPdf } = await import('@/state/generate');
    await generateStampedPdf(ctrl, 'papers/a.pdf');
    await ws.fs.writeText('output/sub/extra.txt', 'x');
    expect(ctrl.state.files[0].status).toBe('processed');

    expect(await ctrl.countFilesIn('output')).toBe(2);
    expect(await ctrl.clearGeneratedDir('output')).toBe(2);
    expect(await ws.fs.list('output', { recursive: true })).toEqual([]);
    expect(ctrl.requireWorkspace().jobs.jobs).toEqual([]);
    expect(ctrl.state.files[0].status).toBe('not-processed');

    for (const dir of ['papers', 'assets', 'fonts', '.pdf-workbench', '', '.', 'papers/sub']) {
      await expect(ctrl.clearGeneratedDir(dir)).rejects.toThrow(/削除できない/);
    }
    expect(await ws.fs.exists('papers/a.pdf')).toBe(true);
  });
});

describe('single-file check', () => {
  it('writes the annotated copy, updates the summary row, and removes the copy once fixed', async () => {
    const { preflightSingle } = await import('@/state/preflightBatch');
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    const bad = await buildFixturePdf([{ size: A4, texts: [{ text: 'Header in the margin', x: 100, y: 820 }] }]);
    const good = await buildFixturePdf([{ size: A4, texts: [{ text: 'Body', x: 100, y: 500 }] }]);
    await ws.fs.writeBytes('papers/a.pdf', good);
    await ws.fs.writeBytes('papers/b.pdf', good);
    await ctrl.refreshFiles();
    await runPreflightBatch(ctrl);

    await ws.fs.writeBytes('papers/a.pdf', bad);
    const first = await preflightSingle(ctrl, 'papers/a.pdf', bad);
    expect(first.report.result).toBe('warning');
    expect(first.annotated).toBe('preflight/a_stamped_preflight.pdf');
    expect(await ws.fs.exists('preflight/a_stamped_preflight.pdf')).toBe(true);
    let summary = JSON.parse(await ws.fs.readText('preflight/summary.json'));
    expect(summary.counts).toEqual({ ok: 1, warning: 1, error: 0, failed: 0 });
    expect(summary.items.find((i: { file: string }) => i.file === 'papers/a.pdf').annotated).toBe('preflight/a_stamped_preflight.pdf');
    expect(await ws.fs.readText('preflight/summary.csv')).toContain('papers/a.pdf,warning');

    const fixed = await preflightSingle(ctrl, 'papers/a.pdf', good);
    expect(fixed.annotated).toBeUndefined();
    expect(await ws.fs.exists('preflight/a_stamped_preflight.pdf')).toBe(false);
    summary = JSON.parse(await ws.fs.readText('preflight/summary.json'));
    expect(summary.counts.ok).toBe(2);
  });

  it('writes the copy even when no batch has been run yet', async () => {
    const { preflightSingle } = await import('@/state/preflightBatch');
    const ctrl = await setup();
    const bad = await buildFixturePdf([{ size: A4, texts: [{ text: 'Header in the margin', x: 100, y: 820 }] }]);
    const res = await preflightSingle(ctrl, 'papers/x.pdf', bad);
    expect(await ctrl.requireWorkspace().fs.exists(res.annotated!)).toBe(true);
    expect(await ctrl.requireWorkspace().fs.exists('preflight/summary.json')).toBe(false);
  });
});

describe('phantom margin content', () => {
  /** A fake rasterizer: every page white at 1 px/pt, with `ink` (PDF rects) painted with `lum`. */
  function rasterizer(ink: { x: number; y: number; width: number; height: number }[] = [], lum = 0): Rasterizer {
    return async function* (bytes) {
      const doc = await PDFDocument.load(bytes);
      for (const [i, p] of doc.getPages().entries()) {
        const { width, height } = p.getSize();
        const w = Math.ceil(width);
        const hgt = Math.ceil(height);
        const data = new Uint8ClampedArray(w * hgt * 4).fill(255);
        for (const r of ink) {
          for (let y = Math.floor(height - r.y - r.height); y < Math.ceil(height - r.y); y++) {
            for (let x = Math.floor(r.x); x < Math.ceil(r.x + r.width); x++) data.set([lum, lum, lum, 255], (y * w + x) * 4);
          }
        }
        yield { page: i + 1, pageSize: { width, height }, image: { data, width: w, height: hgt } };
      }
    };
  }
  const footer = (): Promise<Uint8Array> =>
    buildFixturePdf([{ size: A4, texts: [{ text: 'Body text', x: 100, y: 500 }, { text: 'ghost', x: 300, y: 30 }] }]);

  it('passes a PDF whose margin text draws nothing, and still marks it in the review copy', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await footer());
    await ctrl.refreshFiles();

    const res = await runPreflightBatch(ctrl, { rasterize: rasterizer() });
    const item = res.items[0];
    expect(item.result).toBe('ok');
    expect(item.summary).toContain('見えない要素 1 箇所');
    expect(item.annotated).toBe('preflight/a_stamped_preflight.pdf');
    const report = JSON.parse(await ws.fs.readText(item.report!));
    expect(report.pages[0].warnings).toEqual([]);
    expect(report.pages[0].findings).toEqual([expect.objectContaining({ code: 'BOTTOM_MARGIN', source: 'text', text: 'ghost', phantom: true })]);

    const copy = await PDFDocument.load(await ws.fs.readBytes(item.annotated!));
    const annots = copy.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const contents = annots.asArray().map((ref) => copy.context.lookup(ref, PDFDict).get(PDFName.of('Contents'))!.toString());
    expect(contents.some((c) => c.includes(Buffer.from('（参考）見えない文字', 'utf16le').swap16().toString('hex').toUpperCase()))).toBe(true);
  });

  it('keeps the warning when the margin text shows', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await footer());
    await ctrl.refreshFiles();
    const res = await runPreflightBatch(ctrl, { rasterize: rasterizer([{ x: 300, y: 30, width: 20, height: 6 }]) });
    expect(res.items[0].result).toBe('warning');
    const report = JSON.parse(await ws.fs.readText(res.items[0].report!));
    expect(report.pages[0].warnings).toEqual(['BOTTOM_MARGIN']);
    expect(report.pages[0].findings.some((f: { phantom?: boolean }) => f.phantom)).toBe(false);
  });

  it('treats near-white margin ink as phantom, darker ink as a problem', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: A4, texts: [{ text: 'Body text', x: 100, y: 500 }] }]));
    await ctrl.refreshFiles();
    const box = [{ x: 400, y: 20, width: 10, height: 8 }];
    const faint = await runPreflightBatch(ctrl, { rasterize: rasterizer(box, 245) });
    expect(faint.items[0].result).toBe('ok');
    expect(faint.items[0].annotated).toBeDefined();
    const gray = await runPreflightBatch(ctrl, { rasterize: rasterizer(box, 200) });
    expect(gray.items[0].result).toBe('warning');
    expect(gray.items[0].summary).toContain('BOTTOM_MARGIN');
  });
});
