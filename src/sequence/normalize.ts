/**
 * Tolerant reading of `sequence.json`-shaped data that may have been
 * written by hand or by a script: missing keys get defaults, malformed
 * entries are dropped with a message. Pure.
 */
import type { SequenceConfig, SequenceEntry, SequenceOrder, SequenceOrigin, SequenceStartOn } from '@/core/types';
import { WORKSPACE_FORMAT_VERSION } from '@/core/types';

export interface NormalizedSequence {
  config: SequenceConfig;
  /** Human-readable notes about what was ignored or defaulted. */
  problems: string[];
}

const ORDERS: readonly SequenceOrder[] = ['name', 'manual'];
const START_ONS: readonly SequenceStartOn[] = ['any', 'odd', 'even'];
const ORIGIN_KINDS: readonly SequenceOrigin['kind'][] = ['import', 'manual', 'name'];

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

function nonNegativeInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? Math.trunc(n) : undefined;
}

/** Validate `raw.origin`; an invalid shape is dropped (with a note), never thrown on. */
function normalizeOrigin(raw: unknown, problems: string[]): SequenceOrigin | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    problems.push('origin はオブジェクトである必要があります（無視）');
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  if (!ORIGIN_KINDS.includes(o.kind as SequenceOrigin['kind'])) {
    problems.push(`origin.kind "${String(o.kind)}" は import / manual / name のいずれかである必要があります（origin を無視）`);
    return undefined;
  }
  const origin: SequenceOrigin = { kind: o.kind as SequenceOrigin['kind'] };
  if (o.source !== undefined) {
    if (typeof o.source === 'string') origin.source = o.source;
    else problems.push('origin.source は文字列である必要があります（無視）');
  }
  if (o.format !== undefined) {
    if (o.format === 'csv' || o.format === 'json') origin.format = o.format;
    else problems.push('origin.format は csv / json のいずれかである必要があります（無視）');
  }
  if (o.importedAt !== undefined) {
    if (typeof o.importedAt === 'string') origin.importedAt = o.importedAt;
    else problems.push('origin.importedAt は文字列である必要があります（無視）');
  }
  if (o.editedAt !== undefined) {
    if (typeof o.editedAt === 'string') origin.editedAt = o.editedAt;
    else problems.push('origin.editedAt は文字列である必要があります（無視）');
  }
  if (o.sortKey !== undefined) {
    if (typeof o.sortKey === 'string') origin.sortKey = o.sortKey;
    else problems.push('origin.sortKey は文字列である必要があります（無視）');
  }
  if (o.rows !== undefined) {
    const n = nonNegativeInt(o.rows);
    if (n === undefined) problems.push('origin.rows は 0 以上の整数である必要があります（無視）');
    else origin.rows = n;
  }
  return origin;
}

/**
 * Turn arbitrary parsed JSON into a valid `SequenceConfig`.
 *  - `entries` may be omitted (→ `[]`) or contain plain strings (→ `{ file }`).
 *  - `order` defaults to `manual` when entries are present, else `name`:
 *    a script that only emits a list clearly wants that list's order.
 *  - `firstPage` defaults to 1, `startOn` to `any`, `version` to the current format.
 *  - `origin` is kept when it is a valid `SequenceOrigin` shape, dropped otherwise.
 */
export function normalizeSequenceConfig(input: unknown): NormalizedSequence {
  const problems: string[] = [];
  const raw = (typeof input === 'object' && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    problems.push('sequence.json はオブジェクトである必要があります（既定値を使用）');
  }

  const entries: SequenceEntry[] = [];
  const rawEntries = raw.entries;
  if (rawEntries !== undefined && !Array.isArray(rawEntries)) {
    problems.push('entries は配列である必要があります（無視）');
  } else if (Array.isArray(rawEntries)) {
    rawEntries.forEach((e, i) => {
      if (typeof e === 'string') {
        if (e.trim()) entries.push({ file: e.trim() });
        return;
      }
      if (typeof e !== 'object' || e === null || typeof (e as { file?: unknown }).file !== 'string' || !(e as { file: string }).file.trim()) {
        problems.push(`entries[${i}]: file がありません（無視）`);
        return;
      }
      const obj = e as { file: string; startPage?: unknown; skip?: unknown; output?: unknown };
      const entry: SequenceEntry = { file: obj.file.trim() };
      if (obj.output !== undefined && obj.output !== null && obj.output !== '') {
        if (typeof obj.output === 'string') entry.output = obj.output.trim();
        else problems.push(`entries[${i}] (${entry.file}): output は文字列である必要があります（無視）`);
      }
      if (obj.startPage !== undefined) {
        const n = positiveInt(obj.startPage);
        if (n === undefined) problems.push(`entries[${i}] (${entry.file}): startPage は 1 以上の整数である必要があります（無視）`);
        else entry.startPage = n;
      }
      if (obj.skip !== undefined) {
        if (obj.skip === true || obj.skip === 'true' || obj.skip === 1) entry.skip = true;
        else if (obj.skip !== false && obj.skip !== 'false' && obj.skip !== 0) {
          problems.push(`entries[${i}] (${entry.file}): skip は true/false である必要があります（無視）`);
        }
      }
      entries.push(entry);
    });
  }

  let order: SequenceOrder = entries.length > 0 ? 'manual' : 'name';
  if (raw.order !== undefined) {
    if (ORDERS.includes(raw.order as SequenceOrder)) order = raw.order as SequenceOrder;
    else problems.push(`order "${String(raw.order)}" は name / manual のいずれかである必要があります（${order} を使用）`);
  }

  let startOn: SequenceStartOn = 'any';
  if (raw.startOn !== undefined) {
    if (START_ONS.includes(raw.startOn as SequenceStartOn)) startOn = raw.startOn as SequenceStartOn;
    else problems.push(`startOn "${String(raw.startOn)}" は any / odd / even のいずれかである必要があります（any を使用）`);
  }

  let firstPage = 1;
  if (raw.firstPage !== undefined) {
    const n = positiveInt(raw.firstPage);
    if (n === undefined) problems.push('firstPage は 1 以上の整数である必要があります（1 を使用）');
    else firstPage = n;
  }

  const origin = normalizeOrigin(raw.origin, problems);

  return {
    config: { version: WORKSPACE_FORMAT_VERSION, order, firstPage, startOn, entries, ...(origin ? { origin } : {}) },
    problems,
  };
}
