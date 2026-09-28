/** Outputs generated with since-changed stamps are flagged as stale. */
import { describe, expect, it } from 'vitest';
import { AppController, computeStatus } from '@/state/app';
import { generateStampedPdf } from '@/state/generate';
import { stampsFingerprint } from '@/stamps';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

describe('stale outputs', () => {
  it('fingerprint ignores disabled placements, names and font hashes', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('ws'));
    await ctrl.initializePendingWorkspace();
    const cfg = structuredClone(ctrl.requireWorkspace().stamps);
    cfg.instances[0].enabled = true;
    const base = stampsFingerprint(cfg);
    const renamed = structuredClone(cfg);
    renamed.definitions.find((d) => d.id === cfg.instances[0].stampId)!.name = 'other name';
    expect(stampsFingerprint(renamed)).toBe(base);
    const otherDisabled = structuredClone(cfg);
    otherDisabled.instances[1].pages = { kind: 'last' };
    expect(stampsFingerprint(otherDisabled)).toBe(base);
    const moved = structuredClone(cfg);
    moved.instances[0].position = { anchor: 'top-left', offsetX: 1, offsetY: 1 };
    expect(stampsFingerprint(moved)).not.toBe(base);
  });

  it('marks a generated file as stale once its stamps change, and fresh again after regenerating', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('ws'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: [300, 300] }]));
    await ctrl.refreshFiles();
    const draft = ws.stamps.instances.find((i) => ws.stamps.definitions.find((d) => d.id === i.stampId)?.name === 'DRAFT')!;
    await ctrl.setInstanceEnabled(draft.id, true);

    await generateStampedPdf(ctrl, 'papers/a.pdf');
    expect(ctrl.state.files[0].job?.stampsHash).toMatch(/^stamps:[0-9a-f]{16}$/);
    expect(ctrl.state.files[0].status).toBe('processed');

    await ctrl.setInstancePosition(draft.id, { anchor: 'top-left', offsetX: 10, offsetY: 10 });
    expect(ctrl.state.files[0].status).toBe('stamps-changed');

    await generateStampedPdf(ctrl, 'papers/a.pdf');
    expect(ctrl.state.files[0].status).toBe('processed');
  });

  it('never flags jobs recorded before fingerprints existed', () => {
    const job = { id: 'j', source: 's', sourceHash: 'h', output: 'o', stampInstances: [], createdAt: '', status: 'processed' as const };
    expect(computeStatus(job, 'h', undefined, 'stamps:0000000000000000')).toBe('processed');
  });
});

describe('output name changes', () => {
  it('marks a file as needing an update when a re-imported CSV renames its output', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('ws'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    await ws.fs.writeBytes('papers/a.pdf', await buildFixturePdf([{ size: [300, 300] }]));
    await ctrl.refreshFiles();
    await ctrl.setInstanceEnabled(ws.stamps.instances[0].id, true);
    await generateStampedPdf(ctrl, 'papers/a.pdf');
    expect(ctrl.state.files[0].status).toBe('processed');

    await ctrl.updateSequence((cfg) => ({ ...cfg, entries: [{ file: 'papers/a.pdf', output: 'A1-01.pdf' }] }));
    expect(ctrl.state.files[0].status).toBe('output-changed');
    const { NEEDS_UPDATE_STATUSES, isUpToDate } = await import('@/state/app');
    expect(NEEDS_UPDATE_STATUSES.has('output-changed')).toBe(true);
    expect(isUpToDate('output-changed')).toBe(false);
  });
});
