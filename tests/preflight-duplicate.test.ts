/**
 * STAMP_DUPLICATE: a stamp's text or image already in the paper (e.g. a
 * licence line or logo the author added), found even when the author's
 * copy differs a little (line breaks, hyphenation, a changed word, size).
 */
import { describe, expect, it } from 'vitest';
import { crc32, deflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { AppController } from '@/state/app';
import { preflightOne } from '@/state/preflightBatch';
import { decodeImageFile } from '@/pdf/reader/images';
import { findTextDuplicates, imageSignature, sameImage } from '@/preflight';
import { createMemoryDirectory } from './helpers/memfs';

const A4: [number, number] = [595.28, 841.89];

/** Runs as a page would give them (one per line, top to bottom). */
function lines(...strs: string[]): { str: string; x: number; y: number; width: number; height: number }[] {
  return strs.map((str, i) => ({ str, x: 50, y: 700 - i * 12, width: 250, height: 10 }));
}

const LICENCE = 'This work is licensed under a Creative Commons Attribution Non Commercial, No Derivatives 4.0 License. ©IEICE 2026';

/** A test picture: a dark ring with a bar, on white; `w`×`h` pixels, RGBA. */
function picture(w: number, h: number, variant = 0): { data: Uint8ClampedArray; width: number; height: number } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = (x + 0.5) / w - 0.5;
      const v = (y + 0.5) / h - 0.5;
      const r = Math.hypot(u * 1.2, v);
      const ink = variant === 0 ? (r > 0.3 && r < 0.42) || (Math.abs(v) < 0.06 && u > 0) : u < 0 !== v < 0;
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = ink ? 20 : 250;
      data[i + 3] = 255;
    }
  }
  return { data, width: w, height: h };
}

/** Minimal RGBA PNG encoder (for stamp assets and paper images). */
function png(img: { data: Uint8ClampedArray; width: number; height: number }): Uint8Array {
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows: Buffer[] = [];
  for (let y = 0; y < img.height; y++) {
    rows.push(Buffer.from([0]), Buffer.from(img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4)));
  }
  return new Uint8Array(
    Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(Buffer.concat(rows))),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  );
}

describe('findTextDuplicates', () => {
  it('finds a text broken over lines and hyphenated differently', () => {
    const runs = lines(
      'Body text of the paper.',
      'This work is licensed under a Creative Commons Attribu-',
      'tion Non Commercial, No Derivatives 4.0 License. ©IEICE 2026',
    );
    const found = findTextDuplicates(runs, LICENCE);
    expect(found).toHaveLength(1);
    // The box covers the two licence lines, not the body line.
    expect(found[0].y).toBe(runs[2].y);
    expect(found[0].y + found[0].height).toBe(runs[1].y + runs[1].height);
  });

  it('finds a copy that differs in a few words (year, hyphen, punctuation)', () => {
    const runs = lines('This work is licensed under a Creative Commons Attribution', 'Non-Commercial No Derivatives 4.0 License ©IEICE 2025');
    expect(findTextDuplicates(runs, LICENCE)).toHaveLength(1);
  });

  it('does not match unrelated text or a short word inside a longer one', () => {
    expect(findTextDuplicates(lines('We study Creative approaches to commons.', 'No derivatives are taken.'), LICENCE)).toEqual([]);
    expect(findTextDuplicates(lines('DRAFTING the rules'), 'DRAFT')).toEqual([]);
    expect(findTextDuplicates(lines('DRAFT'), 'DRAFT')).toHaveLength(1);
  });
});

describe('image signatures', () => {
  it('match the same picture at another size and resolution, not a different one', () => {
    const small = imageSignature(picture(88, 31));
    expect(sameImage(small, imageSignature(picture(264, 93)))).toBe(true);
    expect(sameImage(small, imageSignature(picture(88, 31, 1)))).toBe(false);
    expect(sameImage(small, imageSignature(picture(31, 88)))).toBe(false); // other aspect
    const blank = { data: new Uint8ClampedArray(40 * 40 * 4).fill(255), width: 40, height: 40 };
    expect(sameImage(imageSignature(blank), imageSignature(blank))).toBe(false);
  });

  it('decode a PNG file the same way as an image in a PDF', async () => {
    const decoded = await decodeImageFile(png(picture(60, 20)));
    expect(decoded).toMatchObject({ width: 60, height: 20 });
    expect(sameImage(imageSignature(decoded!), imageSignature(picture(60, 20)))).toBe(true);
  });
});

describe('preflightOne with stampDuplicate', () => {
  async function setup(): Promise<AppController> {
    const ctrl = new AppController();
    await ctrl.openHandle(createMemoryDirectory('ws'));
    await ctrl.initializePendingWorkspace();
    const ws = ctrl.requireWorkspace();
    await ctrl.updatePreflightConfig({ ...ws.preflight, checks: { stampDuplicate: true } });
    await ws.fs.writeBytes('assets/licence.png', png(picture(88, 31)));
    await ctrl.updateStamps((cfg) => {
      cfg.definitions.push({
        id: 'licence',
        name: 'Licence',
        layers: [
          { id: 'logo', type: 'image', src: 'assets/licence.png', width: 30 },
          { id: 'text', type: 'text', text: LICENCE, font: { kind: 'standard', name: 'Times-Roman' }, size: 8, color: '#000000' },
        ],
      });
      for (const inst of cfg.instances) inst.enabled = false;
      cfg.instances.push({ id: 'licence-1', stampId: 'licence', enabled: true, pages: { kind: 'first' } });
    });
    return ctrl;
  }

  async function paper(withLogo: boolean, withText: boolean, pages = 1): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.TimesRoman);
    const logo = await doc.embedPng(png(picture(176, 62)));
    for (let p = 0; p < pages; p++) {
      const page = doc.addPage(A4);
      page.drawText('Body text of the paper.', { x: 72, y: 700, size: 10, font });
      if (withLogo) page.drawImage(logo, { x: 72, y: 80, width: 44, height: 15.5 });
      if (withText) {
        page.drawText('This work is licensed under a Creative Commons Attribu-', { x: 120, y: 86, size: 8, font });
        page.drawText('tion Non Commercial, No Derivatives 4.0 License. ©IEICE 2026', { x: 72, y: 74, size: 8, font });
      }
    }
    return doc.save();
  }

  it('reports the licence text and the logo the author already put in, with where they are', async () => {
    const ctrl = await setup();
    const report = await preflightOne(ctrl, 'papers/a.pdf', await paper(true, true));
    expect(report.result).toBe('warning');
    expect(report.pages[0].warnings).toContain('STAMP_DUPLICATE');
    const found = report.pages[0].findings!.filter((f) => f.code === 'STAMP_DUPLICATE');
    expect(found).toHaveLength(2);
    expect(found.every((f) => f.text === 'Licence' && f.source === 'stamp')).toBe(true);
    const logo = found.find((f) => Math.abs(f.rect!.width - 44) < 0.5)!;
    expect(logo.rect).toMatchObject({ x: 72, y: 80 });
  });

  it('finds the logo alone, stays quiet on a clean paper, and only checks the stamped pages', async () => {
    const ctrl = await setup();
    const logoOnly = await preflightOne(ctrl, 'papers/a.pdf', await paper(true, false));
    expect(logoOnly.pages[0].findings?.filter((f) => f.code === 'STAMP_DUPLICATE')).toHaveLength(1);

    const clean = await preflightOne(ctrl, 'papers/b.pdf', await paper(false, false));
    expect(clean.result).toBe('ok');

    // The stamp goes on the first page only: a copy on page 2 is not a duplicate of it.
    const twoPages = await preflightOne(ctrl, 'papers/c.pdf', await paper(true, true, 2));
    expect(twoPages.pages[0].warnings).toContain('STAMP_DUPLICATE');
    expect(twoPages.pages[1].warnings).not.toContain('STAMP_DUPLICATE');
  });

  it('is off unless enabled', async () => {
    const ctrl = await setup();
    const ws = ctrl.requireWorkspace();
    await ctrl.updatePreflightConfig({ ...ws.preflight, checks: {} });
    expect((await preflightOne(ctrl, 'papers/a.pdf', await paper(true, true))).result).toBe('ok');
  });
});
