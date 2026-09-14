/**
 * `sequence/`: continuous page numbering across source PDFs — ordering,
 * pins / skips / alignment, editing helpers and the CSV / JSON export.
 */
import { describe, expect, it } from 'vitest';
import type { SequenceConfig } from '@/core/types';
import {
  compareFileNames,
  formatPageRangesJson,
  formatPageRangesTable,
  materializeOrder,
  moveFile,
  naturalCompare,
  orderFiles,
  pageRangeRows,
  removeEntry,
  removeMissingEntries,
  resolveSequence,
  setFileOverrides,
  useNameOrder,
} from '@/sequence';
import { createDefaultSequenceConfig } from '@/workspace';

const FILES = [
  { path: 'papers/paper10.pdf', pageCount: 1 },
  { path: 'papers/paper2.pdf', pageCount: 3 },
  { path: 'papers/paper1.pdf', pageCount: 2 },
];
const PATHS = FILES.map((f) => f.path);

function cfg(patch: Partial<SequenceConfig> = {}): SequenceConfig {
  return { ...createDefaultSequenceConfig(), ...patch };
}

function ranges(seq: ReturnType<typeof resolveSequence>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const i of seq.items) {
    out[i.file.replace('papers/', '')] =
      i.skipped ? 'skip' : i.pageStart === undefined ? '-' : `${i.pageStart}-${i.pageEnd}`;
  }
  return out;
}

describe('naturalCompare / compareFileNames', () => {
  it('sorts embedded numbers numerically and is deterministic', () => {
    expect(['b10', 'b2', 'a', 'B1'].sort(naturalCompare)).toEqual(['a', 'B1', 'b2', 'b10']);
    expect(['x', 'X'].sort(naturalCompare)).toEqual(['X', 'x']);
    expect(compareFileNames('papers/paper10.pdf', 'papers/paper2.pdf')).toBeGreaterThan(0);
  });
});

describe('orderFiles', () => {
  it('name mode: every file in natural order, missing entries appended and flagged', () => {
    const c = cfg({ entries: [{ file: 'papers/gone.pdf', skip: true }, { file: 'papers/paper2.pdf', startPage: 9 }] });
    expect(orderFiles(c, PATHS)).toEqual([
      { file: 'papers/paper1.pdf', listed: false, missing: false },
      { file: 'papers/paper2.pdf', listed: true, missing: false },
      { file: 'papers/paper10.pdf', listed: false, missing: false },
      { file: 'papers/gone.pdf', listed: true, missing: true },
    ]);
  });

  it('manual mode: listed order first (duplicates collapsed), then unlisted files by name', () => {
    const c = cfg({
      order: 'manual',
      entries: [{ file: 'papers/paper10.pdf' }, { file: 'papers/gone.pdf' }, { file: 'papers/paper10.pdf' }],
    });
    expect(orderFiles(c, PATHS).map((o) => [o.file, o.listed, o.missing])).toEqual([
      ['papers/paper10.pdf', true, false],
      ['papers/gone.pdf', true, true],
      ['papers/paper1.pdf', false, false],
      ['papers/paper2.pdf', false, false],
    ]);
  });
});

describe('resolveSequence', () => {
  it('numbers files continuously in name order from firstPage', () => {
    const seq = resolveSequence(cfg(), FILES);
    expect(ranges(seq)).toEqual({ 'paper1.pdf': '1-2', 'paper2.pdf': '3-5', 'paper10.pdf': '6-6' });
    expect(seq.lastPage).toBe(6);
    expect(seq.numberedPages).toBe(6);
    expect(seq.warnings).toEqual([]);
    expect(seq.items.map((i) => i.index)).toEqual([0, 1, 2]);
  });

  it('honours firstPage and manual order', () => {
    const c = cfg({ order: 'manual', firstPage: 101, entries: [{ file: 'papers/paper2.pdf' }] });
    expect(ranges(resolveSequence(c, FILES))).toEqual({ 'paper2.pdf': '101-103', 'paper1.pdf': '104-105', 'paper10.pdf': '106-106' });
  });

  it('startOn: odd/even align each automatic start, but pins are taken literally', () => {
    expect(ranges(resolveSequence(cfg({ startOn: 'odd' }), FILES))).toEqual({
      'paper1.pdf': '1-2',
      'paper2.pdf': '3-5',
      'paper10.pdf': '7-7',
    });
    expect(ranges(resolveSequence(cfg({ startOn: 'even', firstPage: 1 }), FILES))).toEqual({
      'paper1.pdf': '2-3',
      'paper2.pdf': '4-6',
      'paper10.pdf': '8-8',
    });
    const pinned = cfg({ startOn: 'odd', entries: [{ file: 'papers/paper10.pdf', startPage: 6 }] });
    expect(ranges(resolveSequence(pinned, FILES))['paper10.pdf']).toBe('6-6');
    expect(resolveSequence(pinned, FILES).items.find((i) => i.file.endsWith('paper10.pdf'))?.pinned).toBe(true);
  });

  it('startPage pins re-anchor the chain (gaps and restarts) and skip removes a file from it', () => {
    const c = cfg({ entries: [{ file: 'papers/paper1.pdf', skip: true }, { file: 'papers/paper2.pdf', startPage: 11 }] });
    const seq = resolveSequence(c, FILES);
    expect(ranges(seq)).toEqual({ 'paper1.pdf': 'skip', 'paper2.pdf': '11-13', 'paper10.pdf': '14-14' });
    expect(seq.numberedPages).toBe(4);
    // A pin on a skipped file is ignored (skip wins).
    const both = cfg({ entries: [{ file: 'papers/paper1.pdf', skip: true, startPage: 50 }] });
    expect(ranges(resolveSequence(both, FILES))).toEqual({ 'paper1.pdf': 'skip', 'paper2.pdf': '1-3', 'paper10.pdf': '4-4' });
  });

  it('an unreadable file breaks the chain until a pin re-anchors it; missing entries only warn', () => {
    const files = [
      { path: 'papers/paper1.pdf', pageCount: 2 },
      { path: 'papers/paper2.pdf' }, // unreadable
      { path: 'papers/paper3.pdf', pageCount: 1 },
      { path: 'papers/paper4.pdf', pageCount: 1 },
    ];
    const c = cfg({ entries: [{ file: 'papers/paper4.pdf', startPage: 40 }, { file: 'papers/gone.pdf' }] });
    const seq = resolveSequence(c, files);
    expect(ranges(seq)).toEqual({
      'paper1.pdf': '1-2',
      'paper2.pdf': '-',
      'paper3.pdf': '-',
      'paper4.pdf': '40-40',
      'gone.pdf': '-',
    });
    expect(seq.warnings.some((w) => w.includes('paper2.pdf'))).toBe(true);
    expect(seq.warnings.some((w) => w.includes('gone.pdf'))).toBe(true);
    expect(seq.items.find((i) => i.file.endsWith('gone.pdf'))?.missing).toBe(true);
    expect(seq.lastPage).toBe(40);
  });

  it('an empty PDF gets no range and does not advance the cursor', () => {
    const seq = resolveSequence(cfg(), [
      { path: 'papers/a.pdf', pageCount: 0 },
      { path: 'papers/b.pdf', pageCount: 2 },
    ]);
    expect(ranges(seq)).toEqual({ 'a.pdf': '-', 'b.pdf': '1-2' });
    expect(seq.warnings).toHaveLength(1);
  });

  it('handles no files at all', () => {
    const seq = resolveSequence(cfg(), []);
    expect(seq.items).toEqual([]);
    expect(seq.lastPage).toBeUndefined();
    expect(seq.numberedPages).toBe(0);
  });
});

describe('editing helpers (pure)', () => {
  it('materializeOrder freezes the effective order into manual entries, keeping overrides, dropping missing', () => {
    const c = cfg({ entries: [{ file: 'papers/paper2.pdf', startPage: 9 }, { file: 'papers/gone.pdf' }] });
    const m = materializeOrder(c, PATHS);
    expect(m.order).toBe('manual');
    expect(m.entries).toEqual([{ file: 'papers/paper1.pdf' }, { file: 'papers/paper2.pdf', startPage: 9 }, { file: 'papers/paper10.pdf' }]);
    expect(c.entries).toHaveLength(2); // input untouched
  });

  it('useNameOrder keeps only entries that carry overrides', () => {
    const m = materializeOrder(cfg({ entries: [{ file: 'papers/paper2.pdf', skip: true }] }), PATHS);
    const n = useNameOrder(m);
    expect(n.order).toBe('name');
    expect(n.entries).toEqual([{ file: 'papers/paper2.pdf', skip: true }]);
  });

  it('moveFile switches to manual on first use, clamps, and keeps missing entries in place', () => {
    const moved = moveFile(cfg(), PATHS, 'papers/paper10.pdf', -1);
    expect(moved.order).toBe('manual');
    expect(moved.entries.map((e) => e.file)).toEqual(['papers/paper1.pdf', 'papers/paper10.pdf', 'papers/paper2.pdf']);
    expect(resolveSequence(moved, FILES).items.map((i) => i.file)).toEqual(moved.entries.map((e) => e.file));

    const top = moveFile(moved, PATHS, 'papers/paper1.pdf', -5);
    expect(top.entries[0].file).toBe('papers/paper1.pdf');
    const bottom = moveFile(moved, PATHS, 'papers/paper1.pdf', 99);
    expect(bottom.entries.at(-1)?.file).toBe('papers/paper1.pdf');

    const withMissing = cfg({ order: 'manual', entries: [{ file: 'papers/gone.pdf' }, { file: 'papers/paper2.pdf' }] });
    const m2 = moveFile(withMissing, PATHS, 'papers/paper2.pdf', -1);
    expect(m2.entries.map((e) => e.file)).toEqual(['papers/paper2.pdf', 'papers/gone.pdf', 'papers/paper1.pdf', 'papers/paper10.pdf']);
    expect(moveFile(withMissing, PATHS, 'papers/nope.pdf', 1).entries.map((e) => e.file)).toEqual([
      'papers/gone.pdf',
      'papers/paper2.pdf',
      'papers/paper1.pdf',
      'papers/paper10.pdf',
    ]);
  });

  it('setFileOverrides upserts pins/skips and prunes empty entries in name mode only', () => {
    let c = setFileOverrides(cfg(), 'papers/paper2.pdf', { startPage: 7.9 });
    expect(c.entries).toEqual([{ file: 'papers/paper2.pdf', startPage: 7 }]);
    c = setFileOverrides(c, 'papers/paper2.pdf', { skip: true });
    expect(c.entries).toEqual([{ file: 'papers/paper2.pdf', startPage: 7, skip: true }]);
    c = setFileOverrides(c, 'papers/paper2.pdf', { startPage: undefined, skip: false });
    expect(c.entries).toEqual([]);
    // invalid pins are treated as "clear"
    expect(setFileOverrides(cfg(), 'papers/x.pdf', { startPage: 0 }).entries).toEqual([]);
    expect(setFileOverrides(cfg(), 'papers/x.pdf', { startPage: Number.NaN }).entries).toEqual([]);

    const manual = materializeOrder(cfg(), PATHS);
    const m = setFileOverrides(setFileOverrides(manual, 'papers/paper1.pdf', { skip: true }), 'papers/paper1.pdf', { skip: false });
    expect(m.entries.map((e) => e.file)).toEqual(['papers/paper1.pdf', 'papers/paper2.pdf', 'papers/paper10.pdf']);
    expect(m.entries[0]).toEqual({ file: 'papers/paper1.pdf' });
  });

  it('removeMissingEntries / removeEntry', () => {
    const c = cfg({ order: 'manual', entries: [{ file: 'papers/gone.pdf' }, { file: 'papers/paper2.pdf' }] });
    expect(removeMissingEntries(c, PATHS).entries).toEqual([{ file: 'papers/paper2.pdf' }]);
    expect(removeEntry(c, 'papers/paper2.pdf').entries).toEqual([{ file: 'papers/gone.pdf' }]);
  });
});

describe('page range export', () => {
  it('produces one row per existing file, skipped rows with empty page columns, missing files omitted', () => {
    const c = cfg({ entries: [{ file: 'papers/paper1.pdf', skip: true }, { file: 'papers/gone.pdf' }] });
    const rows = pageRangeRows(resolveSequence(c, FILES), { outputFor: (p) => p.replace('papers/', '').replace('.pdf', '_stamped.pdf') });
    expect(rows).toEqual([
      { filename: 'paper1.pdf', path: 'papers/paper1.pdf', output: 'paper1_stamped.pdf', page_count: 2, skipped: true },
      { filename: 'paper2.pdf', path: 'papers/paper2.pdf', output: 'paper2_stamped.pdf', page_start: 1, page_end: 3, page_count: 3, skipped: false },
      { filename: 'paper10.pdf', path: 'papers/paper10.pdf', output: 'paper10_stamped.pdf', page_start: 4, page_end: 4, page_count: 1, skipped: false },
    ]);
    expect(formatPageRangesTable(rows)).toBe(
      'filename,page_start,page_end,page_count\n' + 'paper1.pdf,,,2\n' + 'paper2.pdf,1,3,3\n' + 'paper10.pdf,4,4,1\n',
    );
    expect(formatPageRangesTable(rows, '\t').split('\n')[1]).toBe('paper1.pdf\t\t\t2');
  });

  it('quotes CSV fields containing the delimiter or quotes (RFC 4180)', () => {
    const rows = pageRangeRows(
      resolveSequence(cfg(), [
        { path: 'papers/a, "b".pdf', pageCount: 1 },
        { path: 'papers/c,d.pdf', pageCount: 1 },
        { path: 'papers/plain.pdf', pageCount: 1 },
      ]),
    );
    const csv = formatPageRangesTable(rows);
    expect(csv).toContain('"a, ""b"".pdf",1,1,1\n');
    expect(csv).toContain('"c,d.pdf",2,2,1\n');
    expect(csv).toContain('plain.pdf,3,3,1\n');
    // A comma is not special in TSV output (a double quote still is).
    const tsv = formatPageRangesTable(rows, '\t');
    expect(tsv).toContain('c,d.pdf\t2\t2\t1\n');
    expect(tsv).toContain('"a, ""b"".pdf"\t1\t1\t1\n');
  });

  it('JSON export carries the rows plus header metadata', () => {
    const rows = pageRangeRows(resolveSequence(cfg(), FILES));
    const doc = JSON.parse(formatPageRangesJson(rows, { generatedAt: '2026-09-14T00:00:00.000Z', firstPage: 1, lastPage: 6 }));
    expect(doc.generatedAt).toBe('2026-09-14T00:00:00.000Z');
    expect(doc.lastPage).toBe(6);
    expect(doc.files).toHaveLength(3);
    expect(doc.files[1]).toMatchObject({ filename: 'paper2.pdf', page_start: 3, page_end: 5 });
  });
});
