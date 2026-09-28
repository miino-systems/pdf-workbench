/**
 * Text rules: regexes a page set must contain (`require`) or must not
 * contain (`forbid`), from preflight.json — nothing venue-specific in code.
 */
import { describe, expect, it } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import type { PreflightConfig, PreflightTextRule } from '@/core/types';
import { annotatePreflightPdf, compileTextRules, describePreflightCode, pageTextForRules, runPreflight } from '@/preflight';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4: [number, number] = [595.28, 841.89];

function config(textRules: PreflightTextRule[]): PreflightConfig {
  return { version: 1, id: 'rules', textRules };
}

async function check(pages: string[][], textRules: PreflightTextRule[]) {
  const bytes = await buildFixturePdf(pages.map((lines) => ({ size: A4, texts: lines.map((text, i) => ({ text, x: 72, y: 700 - i * 20, size: 10 })) })));
  return { bytes, report: await runPreflight(bytes, config(textRules), { file: 'papers/a.pdf', sha256: 'sha256:x' }) };
}

const ORCID: PreflightTextRule = { id: 'orcid', pages: { kind: 'first' }, require: 'ORCID\\s*iDs?', message: 'ORCID 欄がありません' };

describe('pageTextForRules', () => {
  it('joins lines with one space and touching pieces of a line directly', () => {
    const runs = [
      { str: 'ORCID', x: 50, y: 100, width: 30, height: 10 },
      { str: 'iDs', x: 80.5, y: 100, width: 15, height: 10 }, // touching: same word split in two runs
      { str: 'Yuta   Moritake:', x: 100, y: 100, width: 60, height: 10 },
      { str: '0009-0009-5143-1389', x: 50, y: 88, width: 90, height: 10 },
    ];
    expect(pageTextForRules(runs).text).toBe('ORCIDiDs Yuta Moritake: 0009-0009-5143-1389');
  });
});

describe('require', () => {
  it('passes when a selected page matches, and reports on the first selected page otherwise', async () => {
    const ok = await check([['Title', 'ORCID iDs  Kent Tani: 0009-0004-8792-013X'], ['Body']], [ORCID]);
    expect(ok.report.result).toBe('ok');

    const missing = await check([['Title', 'Abstract'], ['ORCID iDs on the wrong page']], [ORCID]);
    expect(missing.report.result).toBe('warning');
    expect(missing.report.pages[0].warnings).toEqual(['TEXT_REQUIRED:orcid']);
    expect(missing.report.pages[1].warnings).toEqual([]);
    expect(missing.report.pages[0].findings).toEqual([{ code: 'TEXT_REQUIRED:orcid', source: 'text' }]);
  });

  it('matches across line breaks, honours flags, and error severity makes the result an error', async () => {
    const rule: PreflightTextRule = { id: 'kw', require: 'keywords:\\s+\\w+', flags: 'i', severity: 'error' };
    expect((await check([['Keywords:', 'FeFET, neuron']], [rule])).report.result).toBe('ok');
    const bad = await check([['Abstract only']], [rule]);
    expect(bad.report.result).toBe('error');
    expect(bad.report.pages[0].errors).toEqual(['TEXT_REQUIRED:kw']);
  });

  it('checks every page when no pages are given, and skips a selector that picks no page', async () => {
    expect((await check([['a'], ['ORCID iD']], [{ ...ORCID, pages: undefined }])).report.result).toBe('ok');
    const r = await check([['a']], [{ ...ORCID, pages: { kind: 'list', pages: [5] } }]);
    expect(r.report.result).toBe('ok');
  });
});

describe('forbid', () => {
  it('reports and locates each match on the selected pages', async () => {
    const rule: PreflightTextRule = { id: 'pagenum', forbid: 'Page \\d+ of \\d+', message: 'ページ番号を入れないでください' };
    const { bytes, report } = await check([['Body', 'Page 1 of 2'], ['Body', 'Page 2 of 2']], [rule]);
    expect(report.result).toBe('warning');
    for (const p of report.pages) {
      expect(p.warnings).toEqual(['TEXT_FORBIDDEN:pagenum']);
      const f = p.findings!.find((x) => x.code === 'TEXT_FORBIDDEN:pagenum')!;
      expect(f.text).toBe(p.page === 1 ? 'Page 1 of 2' : 'Page 2 of 2');
      expect(f.rect!.x).toBe(72);
      expect(f.rect!.y).toBeCloseTo(680);
    }

    // The review copy boxes it and uses the rule's message.
    const copy = await PDFDocument.load(await annotatePreflightPdf(bytes, report, config([rule])));
    const contents = copy
      .getPage(0)
      .node.Annots()!
      .asArray()
      .map((ref) => String(copy.context.lookup(ref)!.toString()));
    expect(contents.join('\n')).toContain('Square');
    expect(describePreflightCode('TEXT_FORBIDDEN:pagenum', config([rule]))).toBe('ページ番号を入れないでください');
  });

  it('only looks at the selected pages', async () => {
    const rule: PreflightTextRule = { id: 'x', forbid: 'DRAFT', pages: { kind: 'range', from: 2, to: 2 } };
    const { report } = await check([['DRAFT'], ['fine']], [rule]);
    expect(report.result).toBe('ok');
  });
});

describe('invalid rules', () => {
  it('are not run and show up as a document-level warning', async () => {
    expect(compileTextRules([{ id: 'bad', require: '(' }]).invalid.map((r) => r.id)).toEqual(['bad']);
    const { report } = await check([['text']], [{ id: 'bad', require: '(' }, ORCID]);
    expect(report.documentWarnings).toEqual(['TEXT_RULE_INVALID:bad']);
    expect(report.pages[0].warnings).toEqual(['TEXT_REQUIRED:orcid']);
    expect(describePreflightCode('TEXT_RULE_INVALID:bad')).toContain('bad');
    expect(describePreflightCode('TEXT_REQUIRED:orcid')).toContain('orcid');
  });
});
