/** Own (dragged) positions vs the definition's defaultPosition, and what the history records. */
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { AppController } from '@/state/app';
import { effectivePosition } from '@/stamps';
import { createMemoryDirectory } from './helpers/memfs';

describe('placement positions', () => {
  it('records where a stamp moved from, and can go back to the default position', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('ws'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    const inst = ws.stamps.instances[0];
    const def = ws.stamps.definitions.find((d) => d.id === inst.stampId)!;
    const start = effectivePosition(def, inst);
    expect(inst.position).toBeUndefined();

    await ctrl.setInstancePosition(inst.id, { anchor: 'top-right', offsetX: 12.345, offsetY: 7 });
    await ctrl.setInstancePosition(inst.id, { anchor: 'top-right', offsetX: 20, offsetY: 7 });
    expect(ctrl.requireWorkspace().stamps.instances[0].position?.offsetX).toBe(20);

    await ctrl.resetInstancePosition(inst.id);
    const after = ctrl.requireWorkspace().stamps.instances[0];
    expect(after.position).toBeUndefined();
    expect(effectivePosition(def, after)).toEqual(start);

    const moves = (await ws.fs.readText(WORKBENCH_FILES.events))
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .filter((e) => e.type === 'stamp.moved');
    expect(moves[0].from).toEqual({ anchor: start.anchor, x: start.offsetX, y: start.offsetY, own: false });
    expect(moves[0]).toMatchObject({ anchor: 'top-right', x: 12.35, y: 7 });
    expect(moves[1].from).toEqual({ anchor: 'top-right', x: 12.35, y: 7, own: true });
    expect(moves[2]).toMatchObject({ reset: true, from: { anchor: 'top-right', x: 20, y: 7, own: true } });
  });
});
