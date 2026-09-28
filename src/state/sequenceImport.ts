/**
 * "Import file order": a list (one file per line) or a sequence.json
 * dropped onto the Sequence tab replaces `.pdf-workbench/sequence.json`.
 * The dropped file itself is never stored; sequence.json stays the source
 * of truth.
 */
import { importSequenceText, type ImportedSequence } from '@/sequence';
import { formatTs } from '@/history/timestamp';
import type { AppController } from './app';

export interface SequenceImportResult extends ImportedSequence {
  /** Name of the dropped file, for the log/toast. */
  source: string;
}

/** Parse `text` against the open workspace and persist it as the new sequence. */
export async function importSequenceFromText(ctrl: AppController, text: string, source: string): Promise<SequenceImportResult> {
  const ws = ctrl.requireWorkspace();
  const result = importSequenceText(text, {
    papersDir: ws.config.directories.papers,
    files: ctrl.state.files.map((f) => f.path),
  });
  // Record where this order came from, so the Sequence tab can show it
  // long after the drop (see `SequenceOrigin`). `sortKey` falls back to
  // 'file order' when the source has no column that looks like one: the
  // rows' own order is what was actually used, never re-sorted.
  result.config.origin = {
    kind: 'import',
    source,
    format: result.format,
    importedAt: formatTs(),
    sortKey: result.sortKey ?? 'file order',
    rows: result.rows,
  };
  await ctrl.updateSequence(result.config, {
    action: 'import',
    source,
    format: result.format,
    headerSkipped: result.header !== undefined,
    rows: result.rows,
  });
  return { ...result, source };
}

/** Read a dropped/picked `File` (UTF-8 text) and import it. */
export async function importSequenceFile(ctrl: AppController, file: File): Promise<SequenceImportResult> {
  return importSequenceFromText(ctrl, await file.text(), file.name);
}
