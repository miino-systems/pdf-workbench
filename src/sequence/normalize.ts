/**
 * Tolerant reading of `sequence.json`-shaped data that may have been
 * written by hand or by a script: missing keys get defaults, malformed
 * entries are dropped with a message. Pure.
 */
import type { SequenceConfig, SequenceEntry, SequenceOrder, SequenceStartOn } from '@/core/types';
import { WORKSPACE_FORMAT_VERSION } from '@/core/types';

export interface NormalizedSequence {
  config: SequenceConfig;
  /** Human-readable notes about what was ignored or defaulted. */
  problems: string[];
}

const ORDERS: readonly SequenceOrder[] = ['name', 'manual'];
const START_ONS: readonly SequenceStartOn[] = ['any', 'odd', 'even'];

function positiveInt(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 1 ? Math.trunc(n) : undefined;
}

/**
 * Turn arbitrary parsed JSON into a valid `SequenceConfig`.
 *  - `entries` may be omitted (→ `[]`) or contain plain strings (→ `{ file }`).
 *  - `order` defaults to `manual` when entries are present, else `name`:
 *    a script that only emits a list clearly wants that list's order.
 *  - `firstPage` defaults to 1, `startOn` to `any`, `version` to the current format.
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
      const obj = e as { file: string; startPage?: unknown; skip?: unknown };
      const entry: SequenceEntry = { file: obj.file.trim() };
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

  return {
    config: { version: WORKSPACE_FORMAT_VERSION, order, firstPage, startOn, entries },
    problems,
  };
}
