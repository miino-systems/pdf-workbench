/**
 * Config files edited outside the app (editor, script, git) must never be
 * overwritten with the stale in-memory copy. Field report: a text size,
 * logo size and line spacing changed in stamps.json by hand were reverted
 * by a single drag in the Workbench.
 */
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import type { StampsConfig } from '@/core/types';
import { AppController } from '@/state/app';
import { createMemoryDirectory } from './helpers/memfs';

async function setup(): Promise<AppController> {
  const ctrl = new AppController();
  await ctrl.openHandle(createMemoryDirectory('ws'));
  await ctrl.initializePendingWorkspace();
  return ctrl;
}

async function editOnDisk(ctrl: AppController, edit: (cfg: StampsConfig) => void): Promise<void> {
  const fs = ctrl.requireWorkspace().fs;
  const cfg = JSON.parse(await fs.readText(WORKBENCH_FILES.stamps)) as StampsConfig;
  edit(cfg);
  await fs.writeText(WORKBENCH_FILES.stamps, JSON.stringify(cfg, null, 2));
}

async function onDisk(ctrl: AppController): Promise<StampsConfig> {
  return JSON.parse(await ctrl.requireWorkspace().fs.readText(WORKBENCH_FILES.stamps)) as StampsConfig;
}

function firstTextLayer(cfg: StampsConfig): { size: number } {
  for (const d of cfg.definitions) for (const l of d.layers) if (l.type === 'text') return l;
  throw new Error('no text layer');
}

describe('external edits of stamps.json', () => {
  it('keeps an external change when the app then moves a stamp', async () => {
    const ctrl = await setup();
    const inst = ctrl.requireWorkspace().stamps.instances[0];
    await editOnDisk(ctrl, (cfg) => {
      firstTextLayer(cfg).size = 33;
    });

    await ctrl.setInstancePosition(inst.id, { anchor: 'top-right', offsetX: 10, offsetY: 12 });

    const disk = await onDisk(ctrl);
    expect(firstTextLayer(disk).size).toBe(33);
    expect(disk.instances.find((i) => i.id === inst.id)?.position).toEqual({ anchor: 'top-right', offsetX: 10, offsetY: 12 });
    expect(firstTextLayer(ctrl.requireWorkspace().stamps).size).toBe(33);
    expect(ctrl.state.toasts.some((t) => t.text.includes('読み直してから変更を適用しました'))).toBe(true);
  });

  it('drops a design edit built from a copy that was changed externally', async () => {
    const ctrl = await setup();
    const stale = structuredClone(ctrl.requireWorkspace().stamps.definitions[0]);
    await editOnDisk(ctrl, (cfg) => {
      cfg.definitions[0].name = 'Renamed outside';
    });
    await ctrl.updateDefinition({ ...stale, description: 'edited in the app' });

    const disk = await onDisk(ctrl);
    expect(disk.definitions[0].name).toBe('Renamed outside');
    expect(disk.definitions[0].description).not.toBe('edited in the app');
    expect(ctrl.requireWorkspace().stamps.definitions[0].name).toBe('Renamed outside');
  });

  it('applies a design edit when only another stamp changed externally', async () => {
    const ctrl = await setup();
    const def = structuredClone(ctrl.requireWorkspace().stamps.definitions[0]);
    await editOnDisk(ctrl, (cfg) => {
      cfg.definitions[1].name = 'Other renamed';
    });
    await ctrl.updateDefinition({ ...def, name: 'Mine' });
    const disk = await onDisk(ctrl);
    expect(disk.definitions[0].name).toBe('Mine');
    expect(disk.definitions[1].name).toBe('Other renamed');
  });

  it('reloads externally edited files on check, and undo does not revert them', async () => {
    const ctrl = await setup();
    const inst = ctrl.requireWorkspace().stamps.instances[0];
    await ctrl.setInstanceEnabled(inst.id, true);
    expect(ctrl.state.undo.undo).toBeDefined();

    await editOnDisk(ctrl, (cfg) => {
      firstTextLayer(cfg).size = 44;
    });
    expect(await ctrl.checkExternalChanges()).toEqual(['stamps.json']);
    expect(firstTextLayer(ctrl.requireWorkspace().stamps).size).toBe(44);
    expect(ctrl.state.undo.undo).toBeUndefined();
    expect(await ctrl.checkExternalChanges()).toEqual([]);

    // Own writes are not mistaken for external edits.
    await ctrl.setInstanceEnabled(inst.id, false);
    expect(await ctrl.checkExternalChanges()).toEqual([]);
  });

  it('refuses to save over a file that is no longer valid JSON', async () => {
    const ctrl = await setup();
    const fs = ctrl.requireWorkspace().fs;
    await fs.writeText(WORKBENCH_FILES.stamps, '{ "broken": ');
    await ctrl.setInstanceEnabled(ctrl.requireWorkspace().stamps.instances[0].id, true);
    expect(await fs.readText(WORKBENCH_FILES.stamps)).toBe('{ "broken": ');
    expect(ctrl.state.toasts.some((t) => t.kind === 'err' && t.text.includes('JSON として読めません'))).toBe(true);
  });

  it('drops a Settings save when workspace.json changed externally', async () => {
    const ctrl = await setup();
    const fs = ctrl.requireWorkspace().fs;
    const cfg = JSON.parse(await fs.readText(WORKBENCH_FILES.workspace));
    await fs.writeText(WORKBENCH_FILES.workspace, JSON.stringify({ ...cfg, name: 'outside' }));
    await ctrl.updateWorkspaceConfig({ ...ctrl.requireWorkspace().config, name: 'inside' });
    expect(JSON.parse(await fs.readText(WORKBENCH_FILES.workspace)).name).toBe('outside');
    expect(ctrl.requireWorkspace().config.name).toBe('outside');
  });
});
