/**
 * Signs of broken display: text drawn over other text (TEXT_OVERLAP), and
 * fonts a viewer has to substitute (FONT_NOT_EMBEDDED) or that are Type 3.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import fontkit from '@pdf-lib/fontkit';
import { PDFDocument, PDFName, StandardFonts, degrees } from 'pdf-lib';
import type { PreflightConfig } from '@/core/types';
import { findTextOverlaps, runPreflight, type PageTextBox } from '@/preflight';
import { readFontEmbedding } from '@/pdf/reader/fonts';
import { buildFixturePdf } from './helpers/pdf-fixtures';

const A4: [number, number] = [595.28, 841.89];
const run = (str: string, x: number, y: number, width: number, height = 10) => ({ str, x, y, width, height });

function config(checks: PreflightConfig['checks']): PreflightConfig {
  return { version: 1, id: 't', checks };
}

describe('findTextOverlaps', () => {
  it('finds different text drawn over each other', () => {
    // A logo that fell back to the text "orcid", now on top of the iD.
    const found = findTextOverlaps([run('ORCID iDs Yuta Moritake:', 50, 100, 110), run('orcid', 162, 100, 25), run('0009-0009-5143-1389', 165, 100, 90)]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ code: 'TEXT_OVERLAP', source: 'text', text: 'orcid / 0009-0009-5143-1389' });
    expect(found[0].rect).toEqual({ x: 162, y: 100, width: 25, height: 10 });
  });

  it('leaves normal typesetting alone', () => {
    expect(
      findTextOverlaps([
        run('First line of text', 50, 100, 120, 11), // next line 10pt lower: only touches
        run('Second line of text', 50, 90, 120, 11),
        run('word', 50, 70, 30),
        run('next', 79.5, 70, 30), // kerning: 0.5pt
        run('x', 50, 50, 5),
        run('^', 50, 53, 5), // accent over a symbol
        run('Bold', 50, 30, 30),
        run('Bold', 50.4, 30, 30), // faked bold
      ]),
    ).toEqual([]);
  });

  it('leaves superscripts, subscripts and tick labels over an axis title alone', () => {
    expect(
      findTextOverlaps([
        run('W s(t)]', 100, 100, 40, 10),
        run('in', 108, 104, 6, 7), // W^in: raised 4 pt
        run('dyn', 120, 200, 10, 9), // W_ij^dyn: stacked, 3 pt apart
        run('ij', 120, 197, 6, 9),
        run('10', 100, 300, 10, 14), // tick label …
        run('Perturbation strength', 80, 295, 100, 14), // … over the axis title, 5 pt lower
      ]),
    ).toEqual([]);
  });

  it('compares rotated text in its own direction only', () => {
    const vertical = (str: string, x: number, y: number, length: number) => ({
      ...run(str, x - 10, y, 10, length), // the box around it
      run: { x, y, angle: Math.PI / 2, length, size: 10 },
    });
    // A vertical axis label crossing horizontal tick labels: not a clash.
    expect(findTextOverlaps([vertical('from perturbed initial solutions', 60, 100, 150), run('C104', 45, 120, 25)])).toEqual([]);
    // Two vertical runs on the same baseline, drawn over each other: a clash.
    const found = findTextOverlaps([vertical('Average number', 60, 100, 80), vertical('of selections', 60, 150, 70)]);
    expect(found).toHaveLength(1);
    expect(found[0].text).toBe('Average number / of selections');
  });
});

describe('runPreflight: rotated text', () => {
  it('boxes a vertical label by its real extent and does not report it over horizontal text', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage(A4);
    page.drawText('Average number of selections', { x: 100, y: 300, size: 10, font, rotate: degrees(90) });
    page.drawText('C104 C204 R104', { x: 80, y: 340, size: 10, font });
    let items: PageTextBox[] = [];
    const report = await runPreflight(
      await doc.save(),
      { ...config({ textOverlap: true, marginText: true }), margins: { top: 10, bottom: 10, left: 10, right: 10, unit: 'mm' } },
      { file: 'a.pdf', sha256: 'x', onPageText: (_, found) => (items = found) },
    );
    expect(report.result).toBe('ok');
    const label = items.find((t) => t.str.startsWith('Average'))!;
    expect(label.x).toBeCloseTo(90, 0); // extends 10 pt to the left of its baseline
    expect(label.width).toBeCloseTo(10, 0);
    expect(label.height).toBeGreaterThan(100);
    expect(label.run?.angle).toBeCloseTo(Math.PI / 2);
    expect(items.find((t) => t.str.startsWith('C104'))!.run).toBeUndefined();
  });
});

describe('runPreflight: textOverlap', () => {
  it('reports and locates overlapping text only when enabled', async () => {
    const bytes = await buildFixturePdf([
      { size: A4, texts: [{ text: 'Header', x: 72, y: 760 }, { text: 'Overlapped', x: 100, y: 500 }, { text: 'Clashing', x: 110, y: 501 }] },
    ]);
    const on = await runPreflight(bytes, config({ textOverlap: true }), { file: 'a.pdf', sha256: 'x' });
    expect(on.result).toBe('warning');
    expect(on.pages[0].warnings).toEqual(['TEXT_OVERLAP']);
    expect(on.pages[0].findings?.[0].rect?.x).toBe(110);
    const off = await runPreflight(bytes, config({}), { file: 'a.pdf', sha256: 'x' });
    expect(off.result).toBe('ok');
  });
});

/** A PDF using an embedded TrueType font, a standard (non-embedded) font, and a Type 3 font. */
async function fontsPdf(opts: { standard?: boolean; type3?: boolean; pages?: number }): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const embedded = await doc.embedFont(new Uint8Array(readFileSync(path.resolve(__dirname, 'fixtures/ipag-subset.ttf'))));
  const helvetica = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (opts.pages ?? 1); i++) {
    const page = doc.addPage(A4);
    page.drawText('abc', { x: 72, y: 700, size: 12, font: embedded });
    if (opts.standard) page.drawText('Standard font', { x: 72, y: 680, size: 12, font: helvetica });
    if (opts.type3) {
      const glyph = doc.context.stream('1000 0 0 0 750 750 d1 0 0 750 750 re f');
      const t3 = doc.context.register(
        doc.context.obj({
          Type: 'Font',
          Subtype: 'Type3',
          Name: 'T3',
          FontBBox: [0, 0, 750, 750],
          FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
          CharProcs: { square: doc.context.register(glyph) },
          Encoding: { Type: 'Encoding', Differences: [97, PDFName.of('square')] },
          FirstChar: 97,
          LastChar: 97,
          Widths: [1000],
        }),
      );
      const fonts = page.node.Resources()!.lookup(PDFName.of('Font')) as ReturnType<typeof doc.context.obj>;
      (fonts as unknown as { set(k: PDFName, v: unknown): void }).set(PDFName.of('T3'), t3);
      const content = doc.context.stream('BT /T3 12 Tf 72 660 Td (aaa) Tj ET');
      const contents = page.node.Contents();
      (contents as unknown as { push(v: unknown): void }).push(doc.context.register(content));
    }
  }
  return doc.save();
}

describe('runPreflight: fonts', () => {
  it('reports a non-embedded font once, on the first page that uses it', async () => {
    const report = await runPreflight(await fontsPdf({ standard: true, pages: 2 }), config({ fonts: true }), { file: 'a.pdf', sha256: 'x' });
    expect(report.result).toBe('warning');
    expect(report.pages[0].warnings).toEqual(['FONT_NOT_EMBEDDED']);
    expect(report.pages[0].findings).toEqual([{ code: 'FONT_NOT_EMBEDDED', source: 'page', text: 'Helvetica' }]);
    expect(report.pages[1].warnings).toEqual([]);

    // The review copy's sticky note names the font.
    const { annotatePreflightPdf } = await import('@/preflight');
    const copy = await PDFDocument.load(await annotatePreflightPdf(await fontsPdf({ standard: true, pages: 2 }), report, config({ fonts: true })));
    const notes = copy.getPage(0).node.Annots()!.asArray().map((ref) => copy.context.lookup(ref)!.toString());
    const note = notes.find((n) => n.includes('/Text'))!;
    const hex = /\/Contents <([0-9A-F]+)>/i.exec(note)![1];
    const text = new TextDecoder('utf-16be').decode(Uint8Array.from(hex.match(/../g)!.map((b) => parseInt(b, 16))));
    expect(text).toContain('• A font is not embedded. (Helvetica)');
  });

  it('reads embedding from the font dictionaries (pdf.js substitutes standard fonts and calls them loaded)', async () => {
    const embedding = await readFontEmbedding(await fontsPdf({ standard: true, type3: true }));
    expect(embedding.get('Helvetica')).toBe(false);
    expect([...embedding].filter(([name]) => name !== 'Helvetica').map(([, e]) => e)).toEqual([true]); // the TrueType font
  });

  it('keeps the font warning alongside the other checks of the page', async () => {
    const cfg: PreflightConfig = { version: 1, id: 't', margins: { top: 20, bottom: 20, left: 20, right: 20, unit: 'mm' }, checks: { fonts: true, marginText: true, textOverlap: true } };
    const report = await runPreflight(await fontsPdf({ standard: true }), cfg, { file: 'a.pdf', sha256: 'x' });
    expect(report.pages[0].warnings).toContain('FONT_NOT_EMBEDDED');
  });

  it('is quiet when every font is embedded, and reports Type 3 fonts', async () => {
    expect((await runPreflight(await fontsPdf({}), config({ fonts: true }), { file: 'a.pdf', sha256: 'x' })).result).toBe('ok');
    const t3 = await runPreflight(await fontsPdf({ type3: true }), config({ fonts: true }), { file: 'a.pdf', sha256: 'x' });
    expect(t3.pages[0].warnings).toEqual(['FONT_TYPE3']);
  });
});
