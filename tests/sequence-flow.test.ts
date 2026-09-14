/**
 * Continuous numbering through the AppController: page counts are read
 * from the workspace, `{page}` in page-number stamps follows
 * `sequence.json`, jobs remember the range they were generated with, a
 * later reorder flags them, and the page-range table is exported to
 * `output/`.
 */
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDocument, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import { WORKBENCH_FILES } from '@/core/types';
import type { StampDefinition } from '@/core/types';
import { AppController } from '@/state/app';
import { generateStampedPdf } from '@/state/generate';
import { exportPageRanges } from '@/state/pageRanges';
import { materializeOrder, moveFile, setFileOverrides } from '@/sequence';
import { createInstanceFromDefinition } from '@/stamps';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4: [number, number] = [595.28, 841.89];

async function pagesPdf(n: number): Promise<Uint8Array> {
  return buildFixturePdf(Array.from({ length: n }, (_, i) => ({ size: A4, texts: [{ text: `p${i + 1}`, x: 50, y: 700 }] })));
}

/** Decoded content stream(s) of one page, hex strings turned back into `(text)`. */
async function pageContent(bytes: Uint8Array, pageIndex: number): Promise<string> {
  const doc = await PDFDocument.load(bytes);
  const contents = doc.getPage(pageIndex).node.Contents();
  if (!contents) return '';
  const streams =
    contents instanceof PDFArray
      ? Array.from({ length: contents.size() }, (_, i) => contents.lookup(i, PDFRawStream))
      : [contents as PDFRawStream];
  const raw = streams.map((s) => new TextDecoder().decode(decodePDFRawStream(s).decode())).join('\n');
  // pdf-lib writes standard-font strings as hex (`<702E2033> Tj`); decode
  // them to `(p. 3)` so assertions can read the drawn text literally.
  return raw.replace(/<([0-9A-Fa-f]+)>/g, (_m, hex: string) => {
    const bytes = hex.match(/.{2}/g)?.map((h) => parseInt(h, 16)) ?? [];
    return `(${String.fromCharCode(...bytes)})`;
  });
}

function rangesOf(ctrl: AppController): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of ctrl.state.sequence?.items ?? []) {
    out[i.file.replace('papers/', '')] = i.skipped ? 'skip' : i.pageStart === undefined ? '-' : `${i.pageStart}-${i.pageEnd}`;
  }
  return out;
}

async function setup(): Promise<{ ctrl: AppController; handle: FileSystemDirectoryHandle }> {
  const handle = createMemoryDirectory('proceedings');
  const ctrl = new AppController();
  await ctrl.openHandle(handle);
  await ctrl.initializePendingWorkspace();
  const ws = ctrl.requireWorkspace();
  // Deliberately "unsorted" names: natural order must give paper1, paper2, paper10.
  await ws.fs.writeBytes('papers/paper10.pdf', await pagesPdf(1));
  await ws.fs.writeBytes('papers/paper2.pdf', await pagesPdf(3));
  await ws.fs.writeBytes('papers/paper1.pdf', await pagesPdf(2));
  const num: StampDefinition = {
    id: 'num',
    name: 'Page number',
    layers: [{ id: 'l', type: 'pageNumber', template: 'p. {page}', font: { kind: 'standard', name: 'Helvetica' }, size: 10, color: '#000000', startAt: 500 }],
    defaultPosition: { anchor: 'bottom-center', offsetX: 0, offsetY: 20 },
  };
  await ctrl.updateStamps((cfg) => {
    cfg.definitions = [num];
    cfg.instances = [createInstanceFromDefinition(num)];
  });
  await ctrl.refreshFiles();
  return { ctrl, handle };
}

describe('continuous page numbering (sequence.json) end-to-end', () => {
  it('initialises sequence.json, resolves ranges in natural name order and shows them on the file list', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();
    expect(JSON.parse(await ws.fs.readText(WORKBENCH_FILES.sequence))).toEqual({
      version: 1,
      order: 'name',
      firstPage: 1,
      startOn: 'any',
      entries: [],
    });
    expect(rangesOf(ctrl)).toEqual({ 'paper1.pdf': '1-2', 'paper2.pdf': '3-5', 'paper10.pdf': '6-6' });
    expect(ctrl.state.sequence?.lastPage).toBe(6);
    expect(ctrl.state.sequence?.warnings).toEqual([]);
  });

  it('stamps {page} with the sequence number (overriding startAt), records it in the job, and flags a later reorder', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();

    const res = await generateStampedPdf(ctrl, 'papers/paper2.pdf');
    expect(res?.warnings).toEqual([]);
    expect(res?.job.pageStart).toBe(3);
    expect(res?.job.pageEnd).toBe(5);
    const out = await ws.fs.readBytes('output/paper2_stamped.pdf');
    expect(await pageContent(out, 0)).toContain('(p. 3)');
    expect(await pageContent(out, 2)).toContain('(p. 5)');
    expect(ctrl.state.files.find((f) => f.path === 'papers/paper2.pdf')?.status).toBe('processed');

    // The pdf.generated event carries the range.
    const last = ctrl.state.events.filter((e) => e.type === 'pdf.generated').at(-1);
    expect(last).toMatchObject({ source: 'paper2.pdf', pageStart: 3, pageEnd: 5 });

    // Move paper2 to the front: it now starts at 1 → the existing output is stale.
    await ctrl.updateSequence(moveFile(ws.sequence, ctrl.state.files.map((f) => f.path), 'papers/paper2.pdf', -1));
    expect(ctrl.requireWorkspace().sequence.order).toBe('manual');
    expect(rangesOf(ctrl)).toEqual({ 'paper2.pdf': '1-3', 'paper1.pdf': '4-5', 'paper10.pdf': '6-6' });
    expect(ctrl.state.files.find((f) => f.path === 'papers/paper2.pdf')?.status).toBe('numbering-changed');
    expect(ctrl.state.files.find((f) => f.path === 'papers/paper1.pdf')?.status).toBe('not-processed');
    expect(ctrl.state.events.filter((e) => e.type === 'sequence.updated')).toHaveLength(1);

    // Regenerating clears the flag and uses the new number.
    const res2 = await generateStampedPdf(ctrl, 'papers/paper2.pdf');
    expect(res2?.job.pageStart).toBe(1);
    expect(ctrl.state.files.find((f) => f.path === 'papers/paper2.pdf')?.status).toBe('processed');
    expect(await pageContent(await ws.fs.readBytes('output/paper2_stamped.pdf'), 0)).toContain('(p. 1)');
  });

  it('a skipped file falls back to the layer startAt; pins and odd alignment apply', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();
    let cfg = setFileOverrides(ws.sequence, 'papers/paper1.pdf', { skip: true });
    cfg = setFileOverrides(cfg, 'papers/paper2.pdf', { startPage: 10 });
    await ctrl.updateSequence({ ...cfg, startOn: 'odd' });
    expect(rangesOf(ctrl)).toEqual({ 'paper1.pdf': 'skip', 'paper2.pdf': '10-12', 'paper10.pdf': '13-13' });

    const skipped = await generateStampedPdf(ctrl, 'papers/paper1.pdf');
    expect(skipped?.job.pageStart).toBeUndefined();
    expect(await pageContent(await ws.fs.readBytes('output/paper1_stamped.pdf'), 1)).toContain('(p. 501)');

    const pinned = await generateStampedPdf(ctrl, 'papers/paper2.pdf');
    expect(pinned?.job.pageStart).toBe(10);
    expect(await pageContent(await ws.fs.readBytes('output/paper2_stamped.pdf'), 1)).toContain('(p. 11)');
  });

  it('exports output/page-ranges.csv and .json and logs the export', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();
    await ctrl.updateSequence(setFileOverrides(ws.sequence, 'papers/paper10.pdf', { skip: true }));

    const res = await exportPageRanges(ctrl);
    expect(res.csv).toBe('output/page-ranges.csv');
    expect(res.json).toBe('output/page-ranges.json');
    expect(await ws.fs.readText('output/page-ranges.csv')).toBe(
      'filename,page_start,page_end,page_count\n' + 'paper1.pdf,1,2,2\n' + 'paper2.pdf,3,5,3\n' + 'paper10.pdf,,,1\n',
    );
    const json = JSON.parse(await ws.fs.readText('output/page-ranges.json'));
    expect(json.firstPage).toBe(1);
    expect(json.lastPage).toBe(5);
    expect(json.files).toEqual([
      { filename: 'paper1.pdf', path: 'papers/paper1.pdf', output: 'paper1_stamped.pdf', page_start: 1, page_end: 2, page_count: 2, skipped: false },
      { filename: 'paper2.pdf', path: 'papers/paper2.pdf', output: 'paper2_stamped.pdf', page_start: 3, page_end: 5, page_count: 3, skipped: false },
      { filename: 'paper10.pdf', path: 'papers/paper10.pdf', output: 'paper10_stamped.pdf', page_count: 1, skipped: true },
    ]);
    expect(ctrl.state.events.at(-1)).toMatchObject({ type: 'sequence.exported', csv: 'output/page-ranges.csv', files: 3 });
  });

  it('persists the sequence across reopen, includes it in snapshots, and re-counts a replaced PDF', async () => {
    const { ctrl, handle } = await setup();
    const ws = ctrl.requireWorkspace();
    await ctrl.updateSequence({ ...materializeOrder(ws.sequence, ctrl.state.files.map((f) => f.path)), firstPage: 100 });
    const snapshotPath = await ctrl.saveSnapshot('test');
    const snapshot = JSON.parse(await ws.fs.readText(snapshotPath!));
    expect(snapshot.sequence.order).toBe('manual');
    expect(snapshot.sequence.firstPage).toBe(100);

    ctrl.closeWorkspace();
    expect(ctrl.state.sequence).toBeUndefined();
    await ctrl.openHandle(handle);
    const reopened = ctrl.requireWorkspace();
    expect(reopened.sequence.order).toBe('manual');
    expect(reopened.sequence.entries.map((e) => e.file)).toEqual(['papers/paper1.pdf', 'papers/paper2.pdf', 'papers/paper10.pdf']);
    expect(rangesOf(ctrl)).toEqual({ 'paper1.pdf': '100-101', 'paper2.pdf': '102-104', 'paper10.pdf': '105-105' });

    // Replace paper1 with a 5-page version: the cached page count is invalidated by size/mtime.
    await new Promise((r) => setTimeout(r, 5));
    await reopened.fs.writeBytes('papers/paper1.pdf', await pagesPdf(5));
    await ctrl.refreshFiles();
    expect(rangesOf(ctrl)).toEqual({ 'paper1.pdf': '100-104', 'paper2.pdf': '105-107', 'paper10.pdf': '108-108' });
  });

  it('a workspace created before sequence.json existed opens without warnings and numbers by name', async () => {
    const { ctrl, handle } = await setup();
    const ws = ctrl.requireWorkspace();
    await ws.fs.remove(WORKBENCH_FILES.sequence);
    ctrl.closeWorkspace();
    await ctrl.openHandle(handle);
    expect(ctrl.requireWorkspace().warnings).toEqual([]);
    expect(ctrl.state.toasts.filter((t) => t.kind === 'warn')).toEqual([]);
    expect(rangesOf(ctrl)).toEqual({ 'paper1.pdf': '1-2', 'paper2.pdf': '3-5', 'paper10.pdf': '6-6' });
  });
});
