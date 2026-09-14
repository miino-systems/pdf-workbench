import { WORKBENCH_FILES } from '@/core/types';
import type { Snapshot } from '@/core/types';
import type { WorkspaceFS } from '@/workspace/fs';
import { formatTs, snapshotFileName } from './timestamp';

/**
 * Point-in-time copies of the 4 config files, stored as individual JSON
 * files under `.pdf-workbench/history/snapshots/`.
 */
export class SnapshotStore {
  private readonly fs: WorkspaceFS;

  constructor(fs: WorkspaceFS) {
    this.fs = fs;
  }

  /** Save a snapshot (timestamped now) and return its workspace-relative path. */
  async save(snapshot: Omit<Snapshot, 'ts'>): Promise<string> {
    const now = new Date();
    const full: Snapshot = { ...snapshot, ts: formatTs(now) };
    const path = `${WORKBENCH_FILES.snapshotsDir}/${snapshotFileName(now)}`;
    await this.fs.writeText(path, `${JSON.stringify(full, null, 2)}\n`);
    return path;
  }

  /** List snapshot file names (not full paths), sorted (chronological, since names are timestamps). */
  async list(): Promise<string[]> {
    const entries = await this.fs.list(WORKBENCH_FILES.snapshotsDir, { extensions: ['.json'] });
    return entries.map((e) => e.name).sort();
  }

  /** Load a snapshot by file name (as returned by `list()`) or full workspace-relative path. */
  async load(name: string): Promise<Snapshot> {
    const path = name.includes('/') ? name : `${WORKBENCH_FILES.snapshotsDir}/${name}`;
    const text = await this.fs.readText(path);
    return JSON.parse(text) as Snapshot;
  }
}
