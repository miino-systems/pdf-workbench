import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { WorkspaceFS } from '@/workspace/fs';
import { EVENT_TYPES, formatTs, GENESIS_HASH, HistoryJournal, SnapshotStore, snapshotFileName } from '@/history';
import { createMemoryDirectory } from './helpers/memfs';

function makeFs(): WorkspaceFS {
  return new WorkspaceFS(createMemoryDirectory('ws'));
}

describe('formatTs', () => {
  it('formats with local offset and seconds precision', () => {
    const date = new Date(2026, 8, 14, 10, 30, 12); // month is 0-based: 8 = September
    const ts = formatTs(date);
    expect(ts).toMatch(/^2026-09-14T10:30:12[+-]\d{2}:\d{2}$/);
  });

  it('renders a zero UTC offset as +00:00, not Z', () => {
    const date = new Date(2026, 8, 14, 10, 30, 12);
    const originalOffset = date.getTimezoneOffset;
    date.getTimezoneOffset = () => 0;
    try {
      expect(formatTs(date)).toBe('2026-09-14T10:30:12+00:00');
    } finally {
      date.getTimezoneOffset = originalOffset;
    }
  });
});

describe('snapshotFileName', () => {
  it('formats as YYYYMMDDTHHMMSS.json in local time', () => {
    const date = new Date(2026, 8, 14, 10, 30, 12);
    expect(snapshotFileName(date)).toBe('20260914T103012.json');
  });
});

describe('HistoryJournal (no hash chain)', () => {
  it('appends events as JSON lines and reads them back', async () => {
    const fs = makeFs();
    const journal = new HistoryJournal(fs);

    await journal.append({ type: EVENT_TYPES.workspaceOpened });
    await journal.append({ type: EVENT_TYPES.stampEnabled, stampId: 's1' });

    const text = await fs.readText(WORKBENCH_FILES.events);
    const lines = text.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(() => JSON.parse(lines[0])).not.toThrow();

    const events = await journal.readAll();
    expect(events).toHaveLength(2);
    expect(events[0].type).toBe(EVENT_TYPES.workspaceOpened);
    expect(events[1].type).toBe(EVENT_TYPES.stampEnabled);
    expect(events[1].stampId).toBe('s1');
    // No hash chain fields when disabled.
    expect(events[0].hash).toBeUndefined();
    expect(events[0].prevHash).toBeUndefined();
  });

  it('readAll() returns [] when the journal file does not exist yet', async () => {
    const fs = makeFs();
    const journal = new HistoryJournal(fs);
    expect(await journal.readAll()).toEqual([]);
  });

  it('readAll() tolerates blank and corrupt lines', async () => {
    const fs = makeFs();
    await fs.writeText(WORKBENCH_FILES.events, '{"type":"a","ts":"t1"}\n\n not json at all\n{"type":"b","ts":"t2"}\n');
    const journal = new HistoryJournal(fs);
    const events = await journal.readAll();
    expect(events.map((e) => e.type)).toEqual(['a', 'b']);
  });

  it('append() uses a caller-provided ts when given', async () => {
    const fs = makeFs();
    const journal = new HistoryJournal(fs);
    const event = await journal.append({ type: EVENT_TYPES.pdfGenerated, ts: '2020-01-01T00:00:00+00:00' });
    expect(event.ts).toBe('2020-01-01T00:00:00+00:00');
  });
});

describe('HistoryJournal (hash chain)', () => {
  it('chains events with prevHash/hash and verifyChain() passes', async () => {
    const fs = makeFs();
    const journal = new HistoryJournal(fs, { hashChain: true });

    const e1 = await journal.append({ type: EVENT_TYPES.workspaceOpened });
    expect(e1.prevHash).toBe(GENESIS_HASH);
    expect(e1.hash).toBeDefined();

    const e2 = await journal.append({ type: EVENT_TYPES.stampEnabled, stampId: 's1' });
    expect(e2.prevHash).toBe(e1.hash);
    expect(e2.hash).toBeDefined();
    expect(e2.hash).not.toBe(e1.hash);

    const result = await journal.verifyChain();
    expect(result).toEqual({ ok: true });
  });

  it('detects tampering with a past event', async () => {
    const fs = makeFs();
    const journal = new HistoryJournal(fs, { hashChain: true });
    await journal.append({ type: EVENT_TYPES.workspaceOpened });
    await journal.append({ type: EVENT_TYPES.stampEnabled, stampId: 's1' });
    await journal.append({ type: EVENT_TYPES.stampDisabled, stampId: 's1' });

    // Tamper with the middle event's payload without touching its hash.
    const text = await fs.readText(WORKBENCH_FILES.events);
    const lines = text.trim().split('\n');
    const tampered = JSON.parse(lines[1]);
    tampered.stampId = 'TAMPERED';
    lines[1] = JSON.stringify(tampered);
    await fs.writeText(WORKBENCH_FILES.events, `${lines.join('\n')}\n`);

    const result = await journal.verifyChain();
    expect(result.ok).toBe(false);
    expect(result.brokenAt).toBe(1);
  });

  it('a fresh journal instance recomputes lastHash lazily from disk', async () => {
    const fs = makeFs();
    const first = new HistoryJournal(fs, { hashChain: true });
    const e1 = await first.append({ type: EVENT_TYPES.workspaceOpened });

    // Simulate reopening the workspace: new journal instance, same fs.
    const second = new HistoryJournal(fs, { hashChain: true });
    const e2 = await second.append({ type: EVENT_TYPES.workspaceInitialized });
    expect(e2.prevHash).toBe(e1.hash);

    const result = await second.verifyChain();
    expect(result.ok).toBe(true);
  });
});

describe('SnapshotStore', () => {
  it('saves a snapshot and lists / loads it back', async () => {
    const fs = makeFs();
    const store = new SnapshotStore(fs);
    const snapshot = {
      reason: 'manual',
      workspace: { version: 1, name: 'ws', createdAt: '2026-01-01T00:00:00+00:00', directories: { papers: 'papers', output: 'output', preview: 'preview', assets: 'assets', fonts: 'fonts' }, output: { suffix: '_stamped' }, history: { hashChain: false } },
      stamps: { version: 1, definitions: [], instances: [] },
      preflight: { version: 1, id: 'default' },
      jobs: { version: 1, jobs: [] },
    };

    const path = await store.save(snapshot);
    expect(path).toMatch(/^\.pdf-workbench\/history\/snapshots\/\d{8}T\d{6}\.json$/);

    const names = await store.list();
    expect(names).toHaveLength(1);

    const loaded = await store.load(names[0]);
    expect(loaded.reason).toBe('manual');
    expect(loaded.ts).toBeDefined();
  });
});
