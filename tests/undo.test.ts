/**
 * Undo / redo of config edits and the Cmd+R workspace reload, through the
 * AppController (no DOM) against an in-memory workspace.
 */
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { AppController } from '@/state/app';
import { UndoStack, type ConfigSnapshot } from '@/state/undo';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

async function setup(name = 'ws'): Promise<{ ctrl: AppController; handle: FileSystemDirectoryHandle }> {
  const handle = createMemoryDirectory(name);
  const ctrl = new AppController();
  await ctrl.openHandle(handle);
  await ctrl.initializePendingWorkspace();
  return { ctrl, handle };
}

function snap(firstPage: number): ConfigSnapshot {
  return { sequence: { firstPage } } as unknown as ConfigSnapshot;
}

describe('UndoStack', () => {
  it('merges rapid edits with the same key and drops no-op entries', () => {
    const s = new UndoStack();
    s.push({ label: 'a', before: snap(1), after: snap(2), mergeKey: 'k', at: 0 });
    s.push({ label: 'a', before: snap(2), after: snap(3), mergeKey: 'k', at: 500 });
    expect(s.nextUndo?.before).toEqual(snap(1));
    expect(s.nextUndo?.after).toEqual(snap(3));
    // Outside the merge window: a separate step.
    s.push({ label: 'a', before: snap(3), after: snap(4), mergeKey: 'k', at: 5000 });
    expect(s.undo()?.after).toEqual(snap(4));
    expect(s.undo()?.after).toEqual(snap(3));
    expect(s.undo()).toBeUndefined();
    expect(s.redo()?.after).toEqual(snap(3));
    // A new edit discards the redo branch.
    s.push({ label: 'b', before: snap(3), after: snap(9), at: 6000 });
    expect(s.nextRedo).toBeUndefined();
    // Identical before/after is not recorded.
    s.push({ label: 'c', before: snap(9), after: snap(9), at: 7000 });
    expect(s.nextUndo?.label).toBe('b');
  });
});

describe('AppController undo / redo', () => {
  it('restores stamps.json and sequence.json, and redoes', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();
    const inst = ws.stamps.instances[0];
    const name = ws.stamps.definitions.find((d) => d.id === inst.stampId)!.name;
    expect(inst.enabled).toBe(false);
    expect(ctrl.state.undo.undo).toBeUndefined();

    await ctrl.setInstanceEnabled(inst.id, true);
    expect(ctrl.state.undo.undo).toBe(`スタンプを有効化（${name}）`);
    await ctrl.updateSequence({ ...ctrl.requireWorkspace().sequence, firstPage: 100 });
    expect(ctrl.state.undo.undo).toBe('通し番号の設定を変更');

    await ctrl.undo();
    expect(ctrl.requireWorkspace().sequence.firstPage).toBe(1);
    expect(JSON.parse(await ws.fs.readText(WORKBENCH_FILES.sequence)).firstPage).toBe(1);
    expect(ctrl.state.toasts.at(-1)?.text).toBe('↶ 元に戻しました: 通し番号の設定を変更');

    await ctrl.undo();
    expect(ctrl.requireWorkspace().stamps.instances[0].enabled).toBe(false);
    expect(JSON.parse(await ws.fs.readText(WORKBENCH_FILES.stamps)).instances[0].enabled).toBe(false);
    expect(ctrl.state.undo).toEqual({ undo: undefined, redo: `スタンプを有効化（${name}）` });

    await ctrl.redo();
    expect(ctrl.requireWorkspace().stamps.instances[0].enabled).toBe(true);
    expect(ctrl.state.toasts.at(-1)?.text).toBe(`↷ やり直しました: スタンプを有効化（${name}）`);

    const events = (await ws.fs.readText(WORKBENCH_FILES.events)).split('\n').filter(Boolean).map((l) => JSON.parse(l).type);
    expect(events.filter((t) => t === 'history.undo')).toHaveLength(2);
    expect(events).toContain('history.redo');
  });

  it('does not record bookkeeping updates without an event', async () => {
    const { ctrl } = await setup();
    await ctrl.updateStamps((cfg) => {
      cfg.version = cfg.version + 0;
      cfg.definitions[0].description = 'hash bookkeeping';
    });
    expect(ctrl.state.undo.undo).toBeUndefined();
  });
});

describe('AppController.reloadWorkspace', () => {
  it('re-reads files edited outside the app and keeps the selection', async () => {
    const { ctrl } = await setup();
    const ws = ctrl.requireWorkspace();
    const pdf = await buildFixturePdf([{ size: [200, 200] }, { size: [200, 200] }]);
    await ws.fs.writeBytes('papers/a.pdf', pdf);
    await ctrl.refreshFiles();
    await ctrl.selectFile('papers/a.pdf', 2);
    await ctrl.setInstanceEnabled(ws.stamps.instances[0].id, true);

    // Edited outside the app: a new PDF and a changed sequence.json.
    await ws.fs.writeBytes('papers/b.pdf', pdf);
    const seq = JSON.parse(await ws.fs.readText(WORKBENCH_FILES.sequence));
    await ws.fs.writeText(WORKBENCH_FILES.sequence, JSON.stringify({ ...seq, firstPage: 7 }));

    await ctrl.reloadWorkspace();
    expect(ctrl.state.files.map((f) => f.path)).toEqual(['papers/a.pdf', 'papers/b.pdf']);
    expect(ctrl.requireWorkspace().sequence.firstPage).toBe(7);
    expect(ctrl.state.selectedFile).toBe('papers/a.pdf');
    expect(ctrl.state.currentPage).toBe(2);
    // Undo history does not reach across a reload (the files may have changed on disk).
    expect(ctrl.state.undo.undo).toBeUndefined();
    expect(ctrl.state.toasts.at(-1)?.text).toContain('再読み込みしました');
  });
});
