/**
 * Pure editing helpers for `SequenceConfig`. Every function returns a new
 * config (the input is never mutated) so callers can hand the result to
 * `AppController.updateSequence` and let it persist + log the change.
 */
import type { SequenceConfig, SequenceEntry } from '@/core/types';
import { orderFiles } from './resolve';

function clone(config: SequenceConfig): SequenceConfig {
  return {
    ...config,
    entries: config.entries.map((e) => ({ ...e })),
  };
}

function hasOverrides(entry: SequenceEntry): boolean {
  return entry.startPage !== undefined || entry.skip === true;
}

function entriesInOrder(config: SequenceConfig, files: readonly string[], keepMissing: boolean): SequenceEntry[] {
  const entries: SequenceEntry[] = [];
  for (const { file, missing } of orderFiles(config, files)) {
    if (missing && !keepMissing) continue;
    const existing = config.entries.find((e) => e.file === file);
    entries.push(existing ? { ...existing } : { file });
  }
  return entries;
}

/**
 * Freeze the current effective order into `entries` and switch to
 * `order: 'manual'`. Existing overrides are kept; entries whose file is
 * missing are dropped.
 */
export function materializeOrder(config: SequenceConfig, files: readonly string[]): SequenceConfig {
  return { ...clone(config), order: 'manual', entries: entriesInOrder(config, files, false) };
}

/**
 * Return to natural name order. Per-file overrides (pins / skips) survive
 * as entries; plain ordering entries are dropped.
 */
export function useNameOrder(config: SequenceConfig): SequenceConfig {
  const next = clone(config);
  return { ...next, order: 'name', entries: next.entries.filter(hasOverrides) };
}

/**
 * Move `file` by `delta` positions (negative = earlier) in the effective
 * order. In `name` mode the order is materialized first, so the first move
 * switches the workspace to manual ordering. Out-of-range moves clamp.
 */
export function moveFile(config: SequenceConfig, files: readonly string[], file: string, delta: number): SequenceConfig {
  const next: SequenceConfig = { ...clone(config), order: 'manual', entries: entriesInOrder(config, files, true) };
  const from = next.entries.findIndex((e) => e.file === file);
  if (from === -1) return next;
  const to = Math.min(next.entries.length - 1, Math.max(0, from + delta));
  if (to === from) return next;
  const [entry] = next.entries.splice(from, 1);
  next.entries.splice(to, 0, entry);
  return next;
}

/**
 * Set / clear the per-file overrides. In `name` mode an entry that ends up
 * with no overrides is removed (the entry list then stays empty for the
 * common "just number everything by name" case); in `manual` mode the
 * entry is kept because it also carries the position.
 */
export function setFileOverrides(
  config: SequenceConfig,
  file: string,
  patch: { startPage?: number | undefined; skip?: boolean },
): SequenceConfig {
  const next = clone(config);
  let entry = next.entries.find((e) => e.file === file);
  if (!entry) {
    entry = { file };
    next.entries.push(entry);
  }
  if ('startPage' in patch) {
    const n = patch.startPage;
    if (n === undefined || !Number.isFinite(n) || n < 1) delete entry.startPage;
    else entry.startPage = Math.trunc(n);
  }
  if ('skip' in patch) {
    if (patch.skip) entry.skip = true;
    else delete entry.skip;
  }
  if (next.order === 'name' && !hasOverrides(entry)) {
    next.entries = next.entries.filter((e) => e !== entry);
  }
  return next;
}

/** Drop entries whose file is not in `files`. */
export function removeMissingEntries(config: SequenceConfig, files: readonly string[]): SequenceConfig {
  const present = new Set(files);
  const next = clone(config);
  return { ...next, entries: next.entries.filter((e) => present.has(e.file)) };
}

/** Remove one entry (its overrides and, in manual mode, its position). */
export function removeEntry(config: SequenceConfig, file: string): SequenceConfig {
  const next = clone(config);
  return { ...next, entries: next.entries.filter((e) => e.file !== file) };
}
