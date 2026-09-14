import { WORKBENCH_FILES } from '@/core/types';
import type { HistoryEvent } from '@/core/types';
import { canonicalJson, sha256Text } from '@/crypto';
import type { WorkspaceFS } from '@/workspace/fs';
import { formatTs } from './timestamp';

/** Hash used as `prevHash` for the first event in a chain. */
export const GENESIS_HASH = `sha256:${'0'.repeat(64)}`;

/** An event as appended, before `ts`/`hash`/`prevHash` are filled in. */
export type HistoryEventInput = Omit<HistoryEvent, 'ts' | 'hash' | 'prevHash'> & { ts?: string };

/** Parse `.pdf-workbench/history/events.jsonl`, skipping blank/corrupt lines. */
function parseEventLines(text: string): HistoryEvent[] {
  const events: HistoryEvent[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as HistoryEvent);
    } catch {
      // Corrupt line (e.g. truncated write): skip rather than fail the whole read.
    }
  }
  return events;
}

/**
 * Append-only event log backed by `.pdf-workbench/history/events.jsonl`
 * (one JSON object per line). Optionally maintains a SHA-256 hash chain so
 * tampering with past events can be detected via `verifyChain()`.
 */
export class HistoryJournal {
  private readonly fs: WorkspaceFS;
  private readonly hashChain: boolean;
  /** Cache of the last event's hash, so `append` doesn't reread the whole file each time. */
  private lastHash: string | undefined;

  constructor(fs: WorkspaceFS, opts?: { hashChain?: boolean }) {
    this.fs = fs;
    this.hashChain = opts?.hashChain ?? false;
  }

  /** Lazily determine the hash of the most recently appended event (reads the file once). */
  private async getLastHash(): Promise<string> {
    if (this.lastHash !== undefined) return this.lastHash;
    const events = await this.readAll();
    const last = events[events.length - 1];
    this.lastHash = (last?.hash as string | undefined) ?? GENESIS_HASH;
    return this.lastHash;
  }

  /**
   * Append one event. `ts` defaults to `formatTs()` (now). When the journal
   * was constructed with `hashChain: true`, `prevHash`/`hash` are computed
   * and attached; otherwise the event is written as-is.
   */
  async append(event: HistoryEventInput): Promise<HistoryEvent> {
    const { ts: providedTs, ...payload } = event;
    const ts = providedTs ?? formatTs();
    let record = { ...payload, ts } as HistoryEvent;

    if (this.hashChain) {
      const prevHash = await this.getLastHash();
      // hash = sha256(prevHash + canonicalJson(event without `hash`)) — the
      // hashed payload includes `prevHash` itself, matching verifyChain().
      const withPrevHash = { ...record, prevHash };
      const hash = await sha256Text(prevHash + canonicalJson(withPrevHash));
      record = { ...withPrevHash, hash };
    }

    await this.fs.appendText(WORKBENCH_FILES.events, `${JSON.stringify(record)}\n`);

    if (this.hashChain) {
      this.lastHash = record.hash;
    }
    return record;
  }

  /** Read every event in the journal, in append order. Missing file -> `[]`. */
  async readAll(): Promise<HistoryEvent[]> {
    if (!(await this.fs.exists(WORKBENCH_FILES.events))) return [];
    const text = await this.fs.readText(WORKBENCH_FILES.events);
    return parseEventLines(text);
  }

  /**
   * Recompute the hash chain over all events and compare against the stored
   * `prevHash`/`hash` fields. Events written without a hash (e.g. while
   * `hashChain` was disabled) are skipped rather than treated as broken.
   */
  async verifyChain(): Promise<{ ok: boolean; brokenAt?: number }> {
    const events = await this.readAll();
    let prev = GENESIS_HASH;
    for (let i = 0; i < events.length; i++) {
      const event = events[i];
      if (event.hash === undefined || event.prevHash === undefined) {
        continue;
      }
      if (event.prevHash !== prev) {
        return { ok: false, brokenAt: i };
      }
      const { hash, ...withoutHash } = event;
      const expected = await sha256Text(event.prevHash + canonicalJson(withoutHash));
      if (expected !== hash) {
        return { ok: false, brokenAt: i };
      }
      prev = hash;
    }
    return { ok: true };
  }
}
