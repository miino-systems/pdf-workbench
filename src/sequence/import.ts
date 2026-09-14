/**
 * Importing a file order from text a user drops onto the app: either a
 * plain list (one file per line) produced by any script, or a
 * `sequence.json`-shaped JSON document. Pure; the UI reads the dropped
 * file and hands the text here.
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
  format: 'list' | 'json';
  warnings: string[];
}

/** `papers/x.pdf` for `x.pdf`, `./papers/x.pdf`, `papers/x.pdf`. */
function toWorkspacePath(name: string, papersDir: string): string {
  let p = name.trim().replace(/\\/g, '/');
  if (p.startsWith('./')) p = p.slice(2);
  const dir = papersDir.replace(/^\.\//, '').replace(/\/+$/, '');
  if (dir && !p.startsWith(`${dir}/`) && !p.includes('/')) p = `${dir}/${p}`;
  return p;
}

/**
 * Parse a plain list. One file per line; blank lines and `#` comments are
 * ignored. An optional last token, separated by whitespace, is either
 * `skip` or a start page number (so file names may contain spaces):
 *
 *     # proceedings order
 *     front-matter.pdf skip
 *     paper001.pdf
 *     paper003.pdf 41
 */
export function parseSequenceList(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const warnings: string[] = [];
  const entries: SequenceEntry[] = [];
  const seen = new Set<string>();

  text.split(/\r?\n/).forEach((rawLine, i) => {
    const line = rawLine.replace(/^﻿/, '').trim();
    if (!line || line.startsWith('#')) return;
    const lineNo = i + 1;

    let name = line;
    let option: string | undefined;
    const m = /^(.*\S)\s+(\S+)$/.exec(line);
    if (m && (/^\d+$/.test(m[2]) || m[2].toLowerCase() === 'skip')) {
      name = m[1];
      option = m[2];
    }
    const file = toWorkspacePath(name, opts.papersDir);
    if (seen.has(file)) {
      warnings.push(`${lineNo} 行目: ${file} が重複しています（最初のものを使用）`);
      return;
    }
    seen.add(file);
    const entry: SequenceEntry = { file };
    if (option !== undefined) {
      if (option.toLowerCase() === 'skip') entry.skip = true;
      else {
        const n = parseInt(option, 10);
        if (n >= 1) entry.startPage = n;
        else warnings.push(`${lineNo} 行目: 開始番号 ${option} は 1 以上である必要があります（無視）`);
      }
    }
    entries.push(entry);
  });

  return finish({ config: { ...normalizeSequenceConfig({ order: 'manual', entries }).config }, format: 'list', warnings }, opts);
}

/** Parse a `sequence.json` document (or a bare JSON array of file names). */
export function parseSequenceJson(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const parsed: unknown = JSON.parse(text.replace(/^﻿/, ''));
  const { config, problems } = normalizeSequenceConfig(Array.isArray(parsed) ? { entries: parsed } : parsed);
  config.entries = config.entries.map((e) => ({ ...e, file: toWorkspacePath(e.file, opts.papersDir) }));
  return finish({ config, format: 'json', warnings: problems }, opts);
}

/**
 * Import text of either kind: JSON when it starts with `{` or `[`, a plain
 * list otherwise. Throws on syntactically invalid JSON.
 */
export function importSequenceText(text: string, opts: ImportSequenceOptions): ImportedSequence {
  const head = text.replace(/^﻿/, '').trimStart();
  return head.startsWith('{') || head.startsWith('[') ? parseSequenceJson(text, opts) : parseSequenceList(text, opts);
}

function finish(result: ImportedSequence, opts: ImportSequenceOptions): ImportedSequence {
  if (result.config.entries.length === 0) result.warnings.push('ファイルが 1 件も含まれていません');
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
