/**
 * Undo / redo of workspace *configuration* edits (Cmd+Z / Cmd+Shift+Z).
 *
 * Every undoable mutation records a before/after snapshot of the editable
 * `.pdf-workbench/*.json` files (stamps, sequence, workspace, preflight).
 * Undo writes the "before" copy back, redo the "after" copy — so the JSON
 * files stay the source of truth and nothing here needs to know how an edit
 * was made. Generated PDFs, jobs and the history journal are not rolled back.
 *
 * Rapid successive edits of the same target (typing into a field with a
 * debounced save, nudging a position) are merged into a single step.
 */
import type { PreflightConfig, SequenceConfig, StampsConfig, WorkspaceConfig } from '@/core/types';

export interface ConfigSnapshot {
  config: WorkspaceConfig;
  stamps: StampsConfig;
  sequence: SequenceConfig;
  preflight: PreflightConfig;
}

export type ConfigKind = keyof ConfigSnapshot;

export interface UndoEntry {
  /** Human-readable description shown in the toast, e.g. `スタンプを移動（DRAFT）`. */
  label: string;
  before: ConfigSnapshot;
  after: ConfigSnapshot;
  /** Edits with the same key within `MERGE_WINDOW_MS` are merged into one entry. */
  mergeKey?: string;
  at: number;
}

export const MERGE_WINDOW_MS = 1500;
const MAX_ENTRIES = 100;

export class UndoStack {
  private done: UndoEntry[] = [];
  private undone: UndoEntry[] = [];

  push(entry: UndoEntry): void {
    if (sameSnapshot(entry.before, entry.after)) return;
    this.undone = [];
    const last = this.done[this.done.length - 1];
    if (last && entry.mergeKey && last.mergeKey === entry.mergeKey && entry.at - last.at <= MERGE_WINDOW_MS) {
      last.after = entry.after;
      last.at = entry.at;
      last.label = entry.label;
      if (sameSnapshot(last.before, last.after)) this.done.pop();
      return;
    }
    this.done.push(entry);
    if (this.done.length > MAX_ENTRIES) this.done.shift();
  }

  /** Pop the most recent entry to undo (its `before` is what to restore). */
  undo(): UndoEntry | undefined {
    const e = this.done.pop();
    if (e) this.undone.push(e);
    return e;
  }

  /** Pop the most recently undone entry to redo (its `after` is what to restore). */
  redo(): UndoEntry | undefined {
    const e = this.undone.pop();
    if (e) this.done.push(e);
    return e;
  }

  clear(): void {
    this.done = [];
    this.undone = [];
  }

  get nextUndo(): UndoEntry | undefined {
    return this.done[this.done.length - 1];
  }

  get nextRedo(): UndoEntry | undefined {
    return this.undone[this.undone.length - 1];
  }
}

export function sameSnapshot(a: ConfigSnapshot, b: ConfigSnapshot): boolean {
  return changedKinds(a, b).length === 0;
}

/** The config files that differ between two snapshots. */
export function changedKinds(a: ConfigSnapshot, b: ConfigSnapshot): ConfigKind[] {
  return (['config', 'stamps', 'sequence', 'preflight'] as const).filter(
    (k) => JSON.stringify(a[k]) !== JSON.stringify(b[k]),
  );
}

const STAMP_EVENT_LABELS: Record<string, string> = {
  'stamp.enabled': 'スタンプを有効化',
  'stamp.disabled': 'スタンプを無効化',
  'stamp.moved': 'スタンプを移動',
  'stamp.added': 'スタンプを追加',
  'stamp.removed': 'スタンプを削除',
  'stamp.updated': 'スタンプを編集',
};

/** Label for a stamps.json edit, naming the stamp when it can be found in either snapshot. */
export function stampEditLabel(type: string, stampName: string | undefined): string {
  const base = STAMP_EVENT_LABELS[type] ?? 'スタンプを変更';
  return stampName ? `${base}（${stampName}）` : base;
}
