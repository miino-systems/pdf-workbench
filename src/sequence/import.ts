/**
 * Importing a file order from a file a user drops onto the app: a CSV
 * mapping source file names to stamped output names (produced by any
 * script from the original spreadsheet), or a `sequence.json`-shaped JSON
 * document. Pure; the UI reads the dropped file and hands the text here.
 */
import type { SequenceConfig, SequenceEntry } from '@/core/types';
import { normalizeSequenceConfig } from './normalize';

export interface ImportSequenceOptions {
  /** Directory of the source PDFs, e.g. `papers` (prepended to bare file names). */
  papersDir: string;
  /** Existing source paths, to warn about names that match nothing. */
  files?: readonly string[];
}

export interface ImportedSequence {
  config: SequenceConfig;
  /** How the text was interpreted. */
  format: 'csv' | 'json';
  warnings: string[];
  /**
   * Raw cells of the header row that was recognised (by name or by shape)
   * and excluded from `config.entries`; undefined when no row was treated
   * as a header (CSV, positional) or for a JSON import.
   */
  header?: string[];
  /**
   * Column roles used to read the CSV, one per `header` cell (only set
   * alongside `header`). `undefined` for a column that was not a
   * recognised or guessed source/output/startPage/skip column.
   */
  columns?: Column[];
  /** Number of entries actually imported (after dropping the header row, duplicates, ...). */
  rows: number;
  /**
   * Name of the column the source rows appeared to be ordered by (e.g.
   * `Session Code`, `time`), when the header suggests one. Rows are never
   * reordered by it — it is reported only, for `SequenceOrigin.sortKey`.
   */
  sortKey?: string;
}

const BOM = /^﻿/;

/** `papers/x.pdf` for `x.pdf`, `./papers/x.pdf`, `papers/x.pdf`. */
function toWorkspacePath(name: string, papersDir: string): string {
  let p = name.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  const dir = papersDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (dir && !p.startsWith(`${dir}/`) && !p.includes('/')) p = `${dir}/${p}`;
  return p;
}

// ------------------------------------------------------------------ CSV

/** Split RFC 4180 CSV text into rows of fields. `delimiter` is `,` or `\t`. */
export function parseCsv(text: string, delimiter: ',' | '\t'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  let i = 0;
  const src = text.replace(BOM, '');
  while (i < src.length) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      field += c;
      i += 1;
      continue;
    }
    if (c === '"') {
      quoted = true;
      i += 1;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = '';
      i += 1;
      continue;
    }
    if (c === '\n' || c === '\r') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      if (c === '\r' && src[i + 1] === '\n') i += 1;
      i += 1;
      continue;
    }
    field += c;
    i += 1;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Tab when the first non-empty line has tabs and no commas; comma otherwise. */
function detectDelimiter(text: string): ',' | '\t' {
  const first = text.replace(BOM, '').split(/\r?\n/).find((l) => l.trim() !== '') ?? '';
  return first.includes('\t') && !first.includes(',') ? '\t' : ',';
}

export type Column = 'source' | 'output' | 'startPage' | 'skip' | undefined;

const HEADER_NAMES: Record<Exclude<Column, undefined>, RegExp> = {
  source: /^(source|src|file|filename|input|papers?|old|old_?name|from|original|旧|旧ファイル(名)?|元ファイル(名)?)$/i,
  output: /^(output|out|stamped|dest|destination|target|new|new_?name|to|renamed|pdf|新|新ファイル(名)?|出力(ファイル)?(名)?)$/i,
  startPage: /^(start_?page|start|開始(番号|ページ)?)$/i,
  skip: /^(skip|除外)$/i,
};

/** A column name that looks like it drove the row order (reported, never sorted by). */
const SORT_KEY_NAMES = /^(session(_?\s?code)?|time|order|seq(uence)?(_?no)?|no\.?|番号|順番|時刻|セッション)$/i;

function looksLikePdfRow(row: readonly string[]): boolean {
  return row.some((c) => /\.pdf$/i.test(c.trim()));
}

/**
 * Decide whether `rows[0]` is a header and, if so, which column holds what.
 * Three strategies, tried in order:
 *  1. Name matching against `HEADER_NAMES` (source/output/... in any known
 *     language or alias) — as long as the row itself is not data (no
 *     `.pdf` cell), so a header naming just its source column still counts.
 *  2. Structural guessing, for a header whose column names we don't
 *     recognise at all: when `rows[0]` isn't itself a data row but a
 *     following row is, the first column whose data cells all end in
 *     `.pdf` is `source`, a second such column `output`. This is what
 *     catches an unrecognised header exported from an arbitrary
 *     spreadsheet (e.g. with an unrelated "Session Code" column) instead
 *     of silently importing it as an extra, bogus entry.
 *  3. Otherwise there is no header at all: columns are positional
 *     (`source, output[, start_page|skip]`).
 */
function detectColumns(rows: readonly (readonly string[])[]): { header: string[] | undefined; columns: Column[]; positional: boolean } {
  const positional: { header: string[] | undefined; columns: Column[]; positional: boolean } = {
    header: undefined,
    columns: ['source', 'output', undefined],
    positional: true,
  };
  if (rows.length === 0) return positional;
  const first = rows[0];
  const dataRows = rows.slice(1);

  const named = first.map((h): Column => {
    const name = h.trim();
    for (const key of Object.keys(HEADER_NAMES) as Exclude<Column, undefined>[]) {
      if (HEADER_NAMES[key].test(name)) return key;
    }
    return undefined;
  });
  if (named.includes('source') && !looksLikePdfRow(first)) {
    return { header: [...first], columns: named, positional: false };
  }

  if (!looksLikePdfRow(first) && dataRows.some(looksLikePdfRow)) {
    const guessed: Column[] = first.map(() => undefined);
    let gotSource = false;
    let gotOutput = false;
    for (let col = 0; col < first.length && !(gotSource && gotOutput); col++) {
      const values = dataRows.map((r) => (r[col] ?? '').trim()).filter((v) => v !== '');
      if (values.length === 0 || !values.every((v) => /\.pdf$/i.test(v))) continue;
      if (!gotSource) {
        guessed[col] = 'source';
        gotSource = true;
      } else if (!gotOutput) {
        guessed[col] = 'output';
        gotOutput = true;
      }
    }
    if (gotSource) return { header: [...first], columns: guessed, positional: false };
  }

  return positional;
}

/** The name of the header cell that looks like a sort key, if any (reporting only). */
function guessSortKey(header: string[] | undefined, columns: readonly Column[]): string | undefined {
  if (!header) return undefined;
  for (let i = 0; i < header.length; i++) {
    if (columns[i] !== undefined) continue; // already a recognised source/output/.../column
    const name = header[i].trim();
    if (SORT_KEY_NAMES.test(name)) return name;
  }
  return undefined;
}

function truthy(v: string): boolean {
  return /^(1|true|yes|y|skip|x|○|◯)$/i.test(v.trim());
}

/**
 * Parse a CSV (or TSV) mapping source files to stamped output names, in
 * sequence order. A header row is recognised by a cell naming the source
 * column (`source` / `file` / `filename` / `input` / `old_name` / ... —
 * see `HEADER_NAMES`), which also lets the columns appear in any order; a
 * header whose names we don't recognise at all is still detected and
 * skipped by shape (see `detectColumns`) instead of being imported as a
 * bogus extra entry. Without a header the columns are positional:
 *
 *     source,output[,start_page|skip]
 *     paper001.pdf,NOLTA2026-A1-01.pdf
 *     paper002.pdf,NOLTA2026-A1-02.pdf,41
 *     front-matter.pdf,,skip
 *
 * Blank lines and lines starting with `#` are ignored. Only the source
 * column is required; an empty output keeps the default `<name><suffix>.pdf`.
 * The page columns of an exported `page-ranges.csv` are ignored, so that
 * file can be dropped back in unchanged.
 */
export function parseSequenceCsv(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const warnings: string[] = [];
  const entries: SequenceEntry[] = [];
  const seen = new Set<string>();
  const delimiter = detectDelimiter(text);
  const rows = parseCsv(text, delimiter);

  // Comments/blank lines don't count towards "the first row" for header
  // detection, but line numbers in warnings still refer to the raw text.
  const dataRows: { row: string[]; lineNo: number }[] = [];
  rows.forEach((row, i) => {
    if (row.every((c) => c.trim() === '') || row[0].trim().startsWith('#')) return;
    dataRows.push({ row, lineNo: i + 1 });
  });

  const detected = detectColumns(dataRows.map((r) => r.row));
  const { columns, positional } = detected;
  const body = detected.header ? dataRows.slice(1) : dataRows;

  for (const { row, lineNo } of body) {
    const cell = (col: Exclude<Column, undefined>): string | undefined => {
      const idx = columns.indexOf(col);
      return idx === -1 ? undefined : row[idx]?.trim();
    };
    const source = cell('source');
    if (!source) {
      warnings.push(`${lineNo} 行目: 元ファイル名がありません（無視）`);
      continue;
    }
    const file = toWorkspacePath(source, opts.papersDir);
    if (seen.has(file)) {
      warnings.push(`${lineNo} 行目: ${file} が重複しています（最初のものを使用）`);
      continue;
    }
    seen.add(file);
    const entry: SequenceEntry = { file };

    const output = cell('output');
    if (output) entry.output = output;

    // Positional third column: a start page number or `skip`.
    const extra = positional ? row[2]?.trim() : undefined;
    const startRaw = cell('startPage') ?? (extra && /^\d+$/.test(extra) ? extra : undefined);
    const skipRaw = cell('skip') ?? (extra && !/^\d+$/.test(extra) ? extra : undefined);
    if (startRaw) {
      const n = parseInt(startRaw, 10);
      if (Number.isFinite(n) && n >= 1) entry.startPage = n;
      else warnings.push(`${lineNo} 行目: 開始番号 ${startRaw} は 1 以上である必要があります（無視）`);
    }
    if (skipRaw && truthy(skipRaw)) entry.skip = true;
    else if (skipRaw && positional) warnings.push(`${lineNo} 行目: 3 列目 "${skipRaw}" は数字か skip である必要があります（無視）`);

    entries.push(entry);
  }

  const config = normalizeSequenceConfig({ order: 'manual', entries }).config;
  return finish(
    {
      config,
      format: 'csv',
      warnings,
      header: detected.header,
      columns: detected.header ? columns : undefined,
      rows: entries.length,
      sortKey: guessSortKey(detected.header, columns),
    },
    opts,
  );
}

// ----------------------------------------------------------------- JSON

/** Parse a `sequence.json` document (or a bare JSON array of file names). */
export function parseSequenceJson(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const parsed: unknown = JSON.parse(text.replace(BOM, ''));
  const { config, problems } = normalizeSequenceConfig(Array.isArray(parsed) ? { entries: parsed } : parsed);
  config.entries = config.entries.map((e) => ({ ...e, file: toWorkspacePath(e.file, opts.papersDir) }));
  return finish({ config, format: 'json', warnings: problems, rows: config.entries.length }, opts);
}

/**
 * Import text of either kind: JSON when it starts with `{` or `[`, CSV
 * otherwise. Throws on syntactically invalid JSON.
 */
export function importSequenceText(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const head = text.replace(BOM, '').trimStart();
  return head.startsWith('{') || head.startsWith('[') ? parseSequenceJson(text, opts) : parseSequenceCsv(text, opts);
}

function finish(result: ImportedSequence, opts: ImportSequenceOptions): ImportedSequence {
  if (result.config.entries.length === 0) result.warnings.push('ファイルが 1 件も含まれていません');
  const outputs = new Map<string, string[]>();
  for (const e of result.config.entries) {
    if (!e.output) continue;
    const key = e.output.toLowerCase();
    outputs.set(key, [...(outputs.get(key) ?? []), e.file]);
  }
  for (const [out, owners] of outputs) {
    if (owners.length > 1) result.warnings.push(`出力ファイル名 ${out} が重複しています: ${owners.join(', ')}`);
  }
  if (opts.files) {
    const present = new Set(opts.files);
    const missing = result.config.entries.filter((e) => !present.has(e.file)).map((e) => e.file);
    if (missing.length) {
      result.warnings.push(`${opts.papersDir}/ に無いファイル: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? ` 他 ${missing.length - 5} 件` : ''}`);
    }
    const listed = new Set(result.config.entries.map((e) => e.file));
    const unlisted = opts.files.filter((f) => !listed.has(f));
    if (unlisted.length) {
      result.warnings.push(`一覧に無いファイルは末尾に名前順で付きます: ${unlisted.slice(0, 5).join(', ')}${unlisted.length > 5 ? ` 他 ${unlisted.length - 5} 件` : ''}`);
    }
  }
  return result;
}
