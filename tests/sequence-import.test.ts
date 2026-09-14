/**
 * Importing a file order from a dropped list / JSON, and the tolerant
 * reading of hand-written sequence.json (missing keys → defaults).
 */
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { importSequenceText, normalizeSequenceConfig, parseSequenceJson, parseSequenceList } from '@/sequence';
import { AppController } from '@/state/app';
import { importSequenceFromText } from '@/state/sequenceImport';
import { initializeWorkspace, loadWorkspace, WorkspaceFS } from '@/workspace';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const OPTS = { papersDir: 'papers', files: ['papers/paper001.pdf', 'papers/paper002.pdf', 'papers/paper003.pdf', 'papers/front matter.pdf'] };

describe('parseSequenceList (one file per line)', () => {
  it('reads names, pins, skips and comments; bare names get the papers/ prefix', () => {
    const text = [
      '﻿# proceedings order',
      '',
      'front matter.pdf skip',
      'paper001.pdf',
      './papers/paper002.pdf\t41',
      'papers/paper003.pdf',
    ].join('\r\n');
    const res = parseSequenceList(text, OPTS);
    expect(res.format).toBe('list');
    expect(res.config).toEqual({
      version: 1,
      order: 'manual',
      firstPage: 1,
      startOn: 'any',
      entries: [
        { file: 'papers/front matter.pdf', skip: true },
        { file: 'papers/paper001.pdf' },
        { file: 'papers/paper002.pdf', startPage: 41 },
        { file: 'papers/paper003.pdf' },
      ],
    });
    expect(res.warnings).toEqual([]);
  });

  it('warns about duplicates, unknown files, unlisted files and an empty list', () => {
    const res = parseSequenceList('paper001.pdf\npaper001.pdf\nnope.pdf 0\n', OPTS);
    expect(res.config.entries).toEqual([{ file: 'papers/paper001.pdf' }, { file: 'papers/nope.pdf' }]);
    expect(res.warnings).toEqual([
      '2 行目: papers/paper001.pdf が重複しています（最初のものを使用）',
      '3 行目: 開始番号 0 は 1 以上である必要があります（無視）',
      'papers/ に無いファイル: papers/nope.pdf',
      '一覧に無いファイルは末尾に名前順で付きます: papers/paper002.pdf, papers/paper003.pdf, papers/front matter.pdf',
    ]);
    expect(parseSequenceList('# nothing\n', OPTS).warnings[0]).toBe('ファイルが 1 件も含まれていません');
  });

  it('a trailing word that is neither a number nor skip is part of the file name', () => {
    const res = parseSequenceList('my paper final.pdf\n', { papersDir: 'papers' });
    expect(res.config.entries).toEqual([{ file: 'papers/my paper final.pdf' }]);
  });
});

describe('parseSequenceJson / normalizeSequenceConfig', () => {
  it('fills defaults: entries-only JSON becomes a manual order', () => {
    const res = parseSequenceJson('{"entries":[{"file":"paper002.pdf"},"paper001.pdf"]}', OPTS);
    expect(res.format).toBe('json');
    expect(res.config).toEqual({
      version: 1,
      order: 'manual',
      firstPage: 1,
      startOn: 'any',
      entries: [{ file: 'papers/paper002.pdf' }, { file: 'papers/paper001.pdf' }],
    });
  });

  it('accepts a bare JSON array of names and keeps explicit settings', () => {
    expect(parseSequenceJson('["paper003.pdf","paper001.pdf"]', OPTS).config.entries.map((e) => e.file)).toEqual([
      'papers/paper003.pdf',
      'papers/paper001.pdf',
    ]);
    const full = parseSequenceJson('{"order":"name","firstPage":"7","startOn":"odd","entries":[{"file":"paper001.pdf","startPage":"3","skip":"false"}]}', OPTS);
    expect(full.config).toMatchObject({ order: 'name', firstPage: 7, startOn: 'odd', entries: [{ file: 'papers/paper001.pdf', startPage: 3 }] });
  });

  it('reports and drops malformed values instead of failing', () => {
    const { config, problems } = normalizeSequenceConfig({
      order: 'random',
      firstPage: -2,
      startOn: 'recto',
      entries: [{ nope: 1 }, { file: 'a.pdf', startPage: 'x', skip: 'maybe' }, 42],
    });
    expect(config).toEqual({ version: 1, order: 'manual', firstPage: 1, startOn: 'any', entries: [{ file: 'a.pdf' }] });
    expect(problems).toHaveLength(7); // 2 bad entries, startPage, skip, order, startOn, firstPage
    expect(normalizeSequenceConfig(null).config.order).toBe('name');
    expect(normalizeSequenceConfig([]).problems[0]).toContain('オブジェクト');
  });

  it('importSequenceText picks the format from the first character and rejects broken JSON', () => {
    expect(importSequenceText('  {"entries":[]}', OPTS).format).toBe('json');
    expect(importSequenceText('paper001.pdf', OPTS).format).toBe('list');
    expect(() => importSequenceText('{not json', OPTS)).toThrow();
  });
});

describe('sequence.json written by a script', () => {
  it('loadWorkspace fills missing keys and surfaces malformed entries as warnings', async () => {
    const fs = new WorkspaceFS(createMemoryDirectory('ws'));
    await initializeWorkspace(fs);
    await fs.writeText(WORKBENCH_FILES.sequence, '{"entries":[{"file":"papers/b.pdf"},{"file":"papers/a.pdf"},{"oops":true}]}\n');
    const state = await loadWorkspace(fs);
    expect(state.sequence).toEqual({
      version: 1,
      order: 'manual',
      firstPage: 1,
      startOn: 'any',
      entries: [{ file: 'papers/b.pdf' }, { file: 'papers/a.pdf' }],
    });
    expect(state.warnings).toEqual(['.pdf-workbench/sequence.json: entries[2]: file がありません（無視）']);
  });

  it('a dropped list replaces the order, is logged, and re-resolves the ranges', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('drop'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    const a4: [number, number] = [595.28, 841.89];
    await ws.fs.writeBytes('papers/paper1.pdf', await buildFixturePdf([{ size: a4 }, { size: a4 }]));
    await ws.fs.writeBytes('papers/paper2.pdf', await buildFixturePdf([{ size: a4 }]));
    await ws.fs.writeBytes('papers/paper3.pdf', await buildFixturePdf([{ size: a4 }, { size: a4 }, { size: a4 }]));
    await ctrl.refreshFiles();

    const res = await importSequenceFromText(ctrl, 'paper3.pdf\npaper1.pdf skip\npaper2.pdf 10\n', 'order.txt');
    expect(res.warnings).toEqual([]);
    expect(ctrl.requireWorkspace().sequence.order).toBe('manual');
    expect(JSON.parse(await ws.fs.readText(WORKBENCH_FILES.sequence)).entries).toEqual([
      { file: 'papers/paper3.pdf' },
      { file: 'papers/paper1.pdf', skip: true },
      { file: 'papers/paper2.pdf', startPage: 10 },
    ]);
    const items = ctrl.state.sequence!.items.map((i) => [i.file, i.skipped ? 'skip' : `${i.pageStart}-${i.pageEnd}`]);
    expect(items).toEqual([
      ['papers/paper3.pdf', '1-3'],
      ['papers/paper1.pdf', 'skip'],
      ['papers/paper2.pdf', '10-10'],
    ]);
    expect(ctrl.state.events.at(-1)).toMatchObject({ type: 'sequence.updated', action: 'import', source: 'order.txt', format: 'list', entries: 3 });
  });
});
