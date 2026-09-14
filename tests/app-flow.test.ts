/**
 * End-to-end flow through the AppController (no DOM): initialise a workspace,
 * generate a stamped PDF, and check the invariants from spec §37:
 *  - the source PDF's SHA-256 does not change
 *  - the output is a separate file under output/
 *  - link annotations survive
 *  - a Japanese workspace font can be embedded
 *  - several stamps are applied at once
 *  - closing and reopening the workspace restores the configuration
 *  - events.jsonl records the operations
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { AppController } from '@/state/app';
import { generateStampedPdf } from '@/state/generate';
import { sha256 } from '@/crypto';
import { WORKBENCH_FILES } from '@/core/types';
import type { StampDefinition } from '@/core/types';
import { createInstanceFromDefinition } from '@/stamps';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const IPAG = readFileSync(path.resolve(__dirname, 'fixtures/ipag-subset.ttf'));
const PNG_1x1 = Uint8Array.from(
  atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='),
  (c) => c.charCodeAt(0),
);

async function setupWorkspace(handle: FileSystemDirectoryHandle): Promise<AppController> {
  const ctrl = new AppController();
  await ctrl.openHandle(handle);
  expect(ctrl.state.pendingInit).toBeDefined();
  await ctrl.initializePendingWorkspace();
  expect(ctrl.state.workspace).toBeDefined();
  return ctrl;
}

describe('AppController end-to-end flow', () => {
  it('generates a stamped PDF without touching the source and restores config on reopen', async () => {
    const handle = createMemoryDirectory('NOLTA2026');
    const ctrl = await setupWorkspace(handle);
    const ws = ctrl.requireWorkspace();

    // Seed workspace content: a source PDF with a link, a font and an image.
    const source = await buildFixturePdf([
      { size: [595.28, 841.89], texts: [{ text: 'Hello', x: 72, y: 700 }], link: { rect: [72, 690, 200, 715], uri: 'https://example.org' } },
      { size: [595.28, 841.89], texts: [{ text: 'Page two', x: 72, y: 700 }] },
    ]);
    await ws.fs.writeBytes('papers/paper001.pdf', source);
    await ws.fs.writeBytes('fonts/ipag-subset.ttf', new Uint8Array(IPAG));
    await ws.fs.writeBytes('assets/logo.png', PNG_1x1);
    const sourceHashBefore = await sha256(source);

    // Three stamps: Japanese text (workspace font), page number, image.
    const jp: StampDefinition = {
      id: 'jp',
      name: '日本語',
      layers: [{ id: 'l1', type: 'text', text: '学会投稿', font: { kind: 'workspace', path: 'fonts/ipag-subset.ttf' }, size: 14, color: '#000000' }],
      defaultPosition: { anchor: 'top-right', offsetX: 20, offsetY: 20 },
    };
    const num: StampDefinition = {
      id: 'num',
      name: 'Page number',
      layers: [{ id: 'l2', type: 'pageNumber', template: 'Page {page} of {pages}', font: { kind: 'standard', name: 'Helvetica' }, size: 10, color: '#000000' }],
      defaultPosition: { anchor: 'bottom-center', offsetX: 0, offsetY: 20 },
    };
    const img: StampDefinition = {
      id: 'img',
      name: 'Logo',
      layers: [{ id: 'l3', type: 'image', src: 'assets/logo.png', width: 50 }],
      defaultPosition: { anchor: 'bottom-left', offsetX: 20, offsetY: 20 },
      defaultPages: { kind: 'first' },
    };
    await ctrl.updateStamps((cfg) => {
      cfg.definitions = [jp, num, img];
      cfg.instances = [jp, num, img].map((d) => createInstanceFromDefinition(d));
    });

    await ctrl.refreshFiles();
    expect(ctrl.state.files.map((f) => f.path)).toEqual(['papers/paper001.pdf']);
    expect(ctrl.state.files[0].status).toBe('not-processed');

    await ctrl.selectFile('papers/paper001.pdf');
    const res = await generateStampedPdf(ctrl, 'papers/paper001.pdf');
    expect(res).toBeDefined();
    expect(res!.output).toBe('output/paper001_stamped.pdf');
    expect(res!.warnings).toEqual([]);

    // Source is untouched.
    const sourceAfter = await ws.fs.readBytes('papers/paper001.pdf');
    expect(await sha256(sourceAfter)).toBe(sourceHashBefore);

    // Output is a separate, valid PDF with the link preserved and fonts embedded.
    const out = await ws.fs.readBytes('output/paper001_stamped.pdf');
    expect(out.length).toBeGreaterThan(0);
    expect(await sha256(out)).not.toBe(sourceHashBefore);
    const outDoc = await PDFDocument.load(out);
    expect(outDoc.getPageCount()).toBe(2);
    const annots = outDoc.getPage(0).node.lookup(PDFName.of('Annots'));
    expect(annots).toBeDefined();
    expect(String(annots)).toContain('0 R');
    const fonts = outDoc.getPage(0).node.Resources()?.lookup(PDFName.of('Font'));
    expect(String(fonts)).toMatch(/\/IPA|\/Helvetica/);

    // Job recorded with the source hash; file status is now "processed".
    const job = ctrl.requireWorkspace().jobs.jobs[0];
    expect(job.source).toBe('papers/paper001.pdf');
    expect(job.sourceHash).toBe(sourceHashBefore);
    expect(job.output).toBe('output/paper001_stamped.pdf');
    expect(job.stampInstances).toHaveLength(3);
    expect(job.fonts?.some((f) => f.ref.kind === 'workspace' && f.sha256?.startsWith('sha256:'))).toBe(true);
    expect(ctrl.state.files[0].status).toBe('processed');

    // Font hash was persisted into stamps.json for reproducibility warnings.
    const stampsJson = JSON.parse(await ws.fs.readText(WORKBENCH_FILES.stamps));
    const layer = stampsJson.definitions[0].layers[0];
    expect(layer.font.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);

    // events.jsonl has the operations.
    const events = (await ws.fs.readText(WORKBENCH_FILES.events))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as { type: string; ts: string });
    const types = events.map((e) => e.type);
    expect(types[0]).toBe('workspace.initialized');
    expect(types).toContain('pdf.generated');
    for (const e of events) expect(e.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);

    // Close and reopen: configuration comes back from the workspace files.
    ctrl.closeWorkspace();
    expect(ctrl.state.workspace).toBeUndefined();
    await ctrl.openHandle(handle);
    const reopened = ctrl.requireWorkspace();
    expect(reopened.stamps.definitions.map((d) => d.id)).toEqual(['jp', 'num', 'img']);
    expect(reopened.jobs.jobs).toHaveLength(1);
    await ctrl.refreshFiles();
    // Status is computed lazily from the hash; wait for the hash task.
    await new Promise((r) => setTimeout(r, 50));
    expect(ctrl.state.files[0].status).toBe('processed');
    const reopenedEvents = (await ws.fs.readText(WORKBENCH_FILES.events)).split('\n').filter(Boolean);
    expect(reopenedEvents.length).toBe(events.length + 1);
    expect(JSON.parse(reopenedEvents.at(-1)!).type).toBe('workspace.opened');
  });

  it('flags a source that changed after processing', async () => {
    const handle = createMemoryDirectory('ws');
    const ctrl = await setupWorkspace(handle);
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: [595.28, 841.89] }]));
    const def: StampDefinition = {
      id: 'd',
      name: 'DRAFT',
      layers: [{ id: 'l', type: 'text', text: 'DRAFT', font: { kind: 'standard', name: 'Helvetica-Bold' }, size: 40, color: '#ff0000', opacity: 0.3 }],
    };
    await ctrl.updateStamps((cfg) => {
      cfg.definitions = [def];
      cfg.instances = [createInstanceFromDefinition(def)];
    });
    await ctrl.refreshFiles();
    await generateStampedPdf(ctrl, 'papers/a.pdf');
    expect(ctrl.state.files[0].status).toBe('processed');

    // Modify the source (simulating the user replacing the paper).
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: [595.28, 841.89], texts: [{ text: 'v2', x: 10, y: 10 }] }]));
    await ctrl.selectFile('papers/a.pdf');
    expect(ctrl.state.files[0].status).toBe('source-changed');
    expect(ctrl.state.toasts.some((t) => t.text.includes('元 PDF が前回処理時から変更されています'))).toBe(true);
  });

  it('refuses to generate when no stamp is enabled', async () => {
    const ctrl = await setupWorkspace(createMemoryDirectory('ws2'));
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: [595.28, 841.89] }]));
    await ctrl.updateStamps((cfg) => {
      for (const i of cfg.instances) i.enabled = false;
    });
    expect(await generateStampedPdf(ctrl, 'papers/a.pdf')).toBeUndefined();
    expect(await ws.fs.exists('output/a_stamped.pdf')).toBe(false);
  });
});
