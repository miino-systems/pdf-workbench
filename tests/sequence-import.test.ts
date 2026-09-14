/**
 * Importing a file order from a dropped list / JSON, and the tolerant
 * reading of hand-written sequence.json (missing keys → defaults).
 */
import { describe, expect, it } from 'vitest';
import { WORKBENCH_FILES } from '@/core/types';
import { importSequenceText, normalizeSequenceConfig, parseCsv, parseSequenceCsv, parseSequenceJson } from '@/sequence';
import { AppController } from '@/state/app';
import { generateStampedPdf } from '@/state/generate';
import { importSequenceFromText } from '@/state/sequenceImport';
import { initializeWorkspace, loadWorkspace, WorkspaceFS } from '@/workspace';
import { createMemoryDirectory } from './helpers/memfs';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const OPTS = { papersDir: 'papers', files: ['papers/paper001.pdf', 'papers/paper002.pdf', 'papers/paper003.pdf', 'papers/front matter.pdf'] };

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, CRLF, tabs and a BOM', () => {
    expect(parseCsv('﻿a,"b, ""c""",d\r\n1,2\n', ',')).toEqual([['a', 'b, "c"', 'd'], ['1', '2']]);
    expect(parseCsv('a\tb\n', '\t')).toEqual([['a', 'b']]);
    expect(parseCsv('', ',')).toEqual([]);
  });
});

describe('parseSequenceCsv (source → output mapping)', () => {
  it('positional columns: source, output, optional start page / skip; comments and blanks ignored', () => {
    const text = [
      '﻿# proceedings order',
      '',
      'front matter.pdf,,skip',
      'paper001.pdf,NOLTA2026-A1-01.pdf',
      './papers/paper002.pdf,NOLTA2026-A1-02.pdf,41',
      'papers/paper003.pdf',
    ].join('\r\n');
    const res = parseSequenceCsv(text, OPTS);
    expect(res.format).toBe('csv');
    expect(res.config).toEqual({
      version: 1,
      order: 'manual',
      firstPage: 1,
      startOn: 'any',
      entries: [
        { file: 'papers/front matter.pdf', skip: true },
        { file: 'papers/paper001.pdf', output: 'NOLTA2026-A1-01.pdf' },
        { file: 'papers/paper002.pdf', output: 'NOLTA2026-A1-02.pdf', startPage: 41 },
        { file: 'papers/paper003.pdf' },
      ],
    });
    expect(res.warnings).toEqual([]);
  });

  it('a header row lets the columns appear in any order and be named freely', () => {
    const text = 'output,start_page,skip,filename\nA-01.pdf,,,paper002.pdf\n,7,,paper001.pdf\n,,yes,paper003.pdf\n';
    const res = parseSequenceCsv(text, OPTS);
    expect(res.config.entries).toEqual([
      { file: 'papers/paper002.pdf', output: 'A-01.pdf' },
      { file: 'papers/paper001.pdf', startPage: 7 },
      { file: 'papers/paper003.pdf', skip: true },
    ]);
  });

  it('accepts an exported page-ranges.csv unchanged (page columns ignored) and TSV', () => {
    const exported = 'filename,output,page_start,page_end,page_count\npaper002.pdf,B.pdf,1,3,3\npaper001.pdf,A.pdf,4,5,2\n';
    expect(parseSequenceCsv(exported, OPTS).config.entries).toEqual([
      { file: 'papers/paper002.pdf', output: 'B.pdf' },
      { file: 'papers/paper001.pdf', output: 'A.pdf' },
    ]);
    expect(parseSequenceCsv('paper001.pdf\tA.pdf\n', OPTS).config.entries).toEqual([{ file: 'papers/paper001.pdf', output: 'A.pdf' }]);
  });

  it('warns about duplicates, duplicate outputs, bad third columns, unknown and unlisted files', () => {
    const res = parseSequenceCsv('paper001.pdf,same.pdf\npaper001.pdf\nnope.pdf,same.pdf,0\npaper002.pdf,,later\n', OPTS);
    expect(res.config.entries).toEqual([
      { file: 'papers/paper001.pdf', output: 'same.pdf' },
      { file: 'papers/nope.pdf', output: 'same.pdf' },
      { file: 'papers/paper002.pdf' },
    ]);
    expect(res.warnings).toEqual([
      '2 行目: papers/paper001.pdf が重複しています（最初のものを使用）',
      '3 行目: 開始番号 0 は 1 以上である必要があります（無視）',
      '4 行目: 3 列目 "later" は数字か skip である必要があります（無視）',
      '出力ファイル名 same.pdf が重複しています: papers/paper001.pdf, papers/nope.pdf',
      'papers/ に無いファイル: papers/nope.pdf',
      '一覧に無いファイルは末尾に名前順で付きます: papers/paper003.pdf, papers/front matter.pdf',
    ]);
    expect(parseSequenceCsv('# nothing\n', OPTS).warnings[0]).toBe('ファイルが 1 件も含まれていません');
  });

  it('quoted file names may contain commas', () => {
    const res = parseSequenceCsv('"my, paper.pdf","out, 1.pdf"\n', { papersDir: 'papers' });
    expect(res.config.entries).toEqual([{ file: 'papers/my, paper.pdf', output: 'out, 1.pdf' }]);
  });
});

describe('parseSequenceJson / normalizeSequenceConfig', () => {
  it('fills defaults: entries-only JSON becomes a manual order', () => {
    const res = parseSequenceJson('{"entries":[{"file":"paper002.pdf","output":"B.pdf"},"paper001.pdf"]}', OPTS);
    expect(res.format).toBe('json');
    expect(res.config).toEqual({
      version: 1,
      order: 'manual',
      firstPage: 1,
      startOn: 'any',
      entries: [{ file: 'papers/paper002.pdf', output: 'B.pdf' }, { file: 'papers/paper001.pdf' }],
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
      entries: [{ nope: 1 }, { file: 'a.pdf', startPage: 'x', skip: 'maybe', output: 5 }, 42],
    });
    expect(config).toEqual({ version: 1, order: 'manual', firstPage: 1, startOn: 'any', entries: [{ file: 'a.pdf' }] });
    expect(problems).toHaveLength(8); // 2 bad entries, output, startPage, skip, order, startOn, firstPage
    expect(normalizeSequenceConfig(null).config.order).toBe('name');
    expect(normalizeSequenceConfig([]).problems[0]).toContain('オブジェクト');
  });

  it('importSequenceText picks the format from the first character and rejects broken JSON', () => {
    expect(importSequenceText('  {"entries":[]}', OPTS).format).toBe('json');
    expect(importSequenceText('paper001.pdf,A.pdf', OPTS).format).toBe('csv');
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

  it('a dropped CSV replaces the order and output names, is logged, and re-resolves the ranges', async () => {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('drop'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    const a4: [number, number] = [595.28, 841.89];
    await ws.fs.writeBytes('papers/paper1.pdf', await buildFixturePdf([{ size: a4 }, { size: a4 }]));
    await ws.fs.writeBytes('papers/paper2.pdf', await buildFixturePdf([{ size: a4 }]));
    await ws.fs.writeBytes('papers/paper3.pdf', await buildFixturePdf([{ size: a4 }, { size: a4 }, { size: a4 }]));
    await ctrl.updateStamps((cfg) => {
      for (const i of cfg.instances) i.enabled = i.stampId === 'page-number';
    });
    await ctrl.refreshFiles();

    const res = await importSequenceFromText(
      ctrl,
      'source,output,start_page,skip\npaper3.pdf,NOLTA-01.pdf,,\npaper1.pdf,,,skip\npaper2.pdf,sub/NOLTA-02,10,\n',
      'order.csv',
    );
    expect(res.warnings).toEqual([]);
    expect(ctrl.requireWorkspace().sequence.order).toBe('manual');
    expect(JSON.parse(await ws.fs.readText(WORKBENCH_FILES.sequence)).entries).toEqual([
      { file: 'papers/paper3.pdf', output: 'NOLTA-01.pdf' },
      { file: 'papers/paper1.pdf', skip: true },
      { file: 'papers/paper2.pdf', output: 'sub/NOLTA-02', startPage: 10 },
    ]);
    // Output names are honoured by generation (and `.pdf` is appended when missing).
    expect(ctrl.outputPathFor('papers/paper3.pdf')).toBe('output/NOLTA-01.pdf');
    expect(ctrl.outputPathFor('papers/paper2.pdf')).toBe('output/sub/NOLTA-02.pdf');
    expect(ctrl.outputPathFor('papers/paper1.pdf')).toBe('output/paper1_stamped.pdf');
    const gen = await generateStampedPdf(ctrl, 'papers/paper3.pdf');
    expect(gen?.output).toBe('output/NOLTA-01.pdf');
    expect(gen?.job.output).toBe('output/NOLTA-01.pdf');
    expect(await ws.fs.exists('output/NOLTA-01.pdf')).toBe(true);
    expect(await ws.fs.exists('output/paper3_stamped.pdf')).toBe(false);
    const items = ctrl.state.sequence!.items.map((i) => [i.file, i.skipped ? 'skip' : `${i.pageStart}-${i.pageEnd}`]);
    expect(items).toEqual([
      ['papers/paper3.pdf', '1-3'],
      ['papers/paper1.pdf', 'skip'],
      ['papers/paper2.pdf', '10-10'],
    ]);
    expect(ctrl.state.events.filter((e) => e.type === 'sequence.updated').at(-1)).toMatchObject({
      action: 'import',
      source: 'order.csv',
      format: 'csv',
      entries: 3,
    });
  });
});
