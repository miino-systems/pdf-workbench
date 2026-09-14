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

type Column = 'source' | 'output' | 'startPage' | 'skip' | undefined;

const HEADER_NAMES: Record<Exclude<Column, undefined>, RegExp> = {
  source: /^(source|src|file|filename|input|papers?|元ファイル(名)?)$/i,
  output: /^(output|out|stamped|dest|destination|target|出力(ファイル)?(名)?)$/i,
  startPage: /^(start_?page|start|開始(番号|ページ)?)$/i,
  skip: /^(skip|除外)$/i,
};

/**
 * Map a header row to column roles; undefined when the row is not a header
 * (a header names the source column and contains no `.pdf` file name).
 */
function detectHeader(row: readonly string[]): Column[] | undefined {
  const cols = row.map((h): Column => {
    const name = h.trim();
    for (const key of Object.keys(HEADER_NAMES) as Exclude<Column, undefined>[]) {
      if (HEADER_NAMES[key].test(name)) return key;
    }
    return undefined;
  });
  const looksLikeData = row.some((c) => /\.pdf$/i.test(c.trim()));
  return cols.includes('source') && !looksLikeData ? cols : undefined;
}

function truthy(v: string): boolean {
  return /^(1|true|yes|y|skip|x|○|◯)$/i.test(v.trim());
}

/**
 * Parse a CSV (or TSV) mapping source files to stamped output names, in
 * sequence order. A header row is recognised by a cell naming the source
 * column (`source` / `file` / `filename` / `input`), which also lets the
 * columns appear in any order; without a header the columns are positional:
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

  let columns: Column[] = ['source', 'output', undefined];
  let positional = true;
  let first = true;

  rows.forEach((row, i) => {
    const lineNo = i + 1;
    if (row.every((c) => c.trim() === '') || row[0].trim().startsWith('#')) return;
    if (first) {
      first = false;
      const header = detectHeader(row);
      if (header) {
        columns = header;
        positional = false;
        return;
      }
    }

    const cell = (col: Exclude<Column, undefined>): string | undefined => {
      const idx = columns.indexOf(col);
      return idx === -1 ? undefined : row[idx]?.trim();
    };
    const source = cell('source');
    if (!source) {
      warnings.push(`${lineNo} 行目: 元ファイル名がありません（無視）`);
      return;
    }
    const file = toWorkspacePath(source, opts.papersDir);
    if (seen.has(file)) {
      warnings.push(`${lineNo} 行目: ${file} が重複しています（最初のものを使用）`);
      return;
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
  });

  return finish({ config: normalizeSequenceConfig({ order: 'manual', entries }).config, format: 'csv', warnings }, opts);
}

// ----------------------------------------------------------------- JSON

/** Parse a `sequence.json` document (or a bare JSON array of file names). */
export function parseSequenceJson(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const parsed: unknown = JSON.parse(text.replace(BOM, ''));
  const { config, problems } = normalizeSequenceConfig(Array.isArray(parsed) ? { entries: parsed } : parsed);
  config.entries = config.entries.map((e) => ({ ...e, file: toWorkspacePath(e.file, opts.papersDir) }));
  return finish({ config, format: 'json', warnings: problems }, opts);
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
