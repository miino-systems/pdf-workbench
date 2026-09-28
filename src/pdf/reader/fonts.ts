import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from 'pdf-lib';
import { getPdfjs } from './pdfjs.js';

/** A font a page draws text with. */
export interface PageFont {
  /** pdf.js id of the loaded font (matches `getTextContent` items' `fontName`). */
  id: string;
  /** Font name from the PDF (`BaseFont`). */
  name: string;
  /** False when the PDF only names the font and the viewer has to substitute one. */
  embedded: boolean;
  /** Type 3: glyphs drawn by PDF operators, typically bitmap fonts from old TeX setups. */
  type3: boolean;
}

/** Embedding status of the fonts a PDF declares, by `BaseFont` without its subset prefix. */
export type FontEmbedding = Map<string, boolean>;

interface PdfjsFont {
  name?: string;
  missingFile?: boolean;
  isType3Font?: boolean;
}

/** `ABCDEF+Times-Roman` → `Times-Roman`. */
function baseName(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

function resolveFont(page: PDFPageProxy, id: string): Promise<PdfjsFont | undefined> {
  return new Promise((resolve) => {
    try {
      page.commonObjs.get(id, (obj: unknown) => resolve((obj as PdfjsFont | null) ?? undefined));
    } catch {
      resolve(undefined);
    }
  });
}

/**
 * Read from the PDF's own font dictionaries whether each font is embedded
 * (its descriptor carries `FontFile`/`FontFile2`/`FontFile3`; for a Type 0
 * font, its descendant's). pdf.js can't tell: when a font isn't embedded
 * it substitutes its bundled standard-font data and reports the font as
 * loaded. Covers page resources and form XObjects within them. A font
 * name declared both embedded and not counts as not embedded. Empty when
 * the PDF can't be parsed (e.g. encrypted).
 */
export async function readFontEmbedding(bytes: Uint8Array): Promise<FontEmbedding> {
  const out: FontEmbedding = new Map();
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    return out;
  }
  const ctx = doc.context;
  const dict = (v: unknown): PDFDict | undefined => {
    const o = v instanceof PDFRef ? ctx.lookup(v) : v;
    return o instanceof PDFDict ? o : undefined;
  };
  const note = (name: unknown, embedded: boolean): void => {
    if (!(name instanceof PDFName)) return;
    const key = baseName(name.decodeText());
    out.set(key, (out.get(key) ?? true) && embedded);
  };
  const hasFile = (font: PDFDict): boolean => {
    const desc = dict(font.get(PDFName.of('FontDescriptor')));
    return !!desc && ['FontFile', 'FontFile2', 'FontFile3'].some((k) => desc.has(PDFName.of(k)));
  };
  const seen = new Set<PDFDict>();
  const walk = (resources: PDFDict | undefined): void => {
    if (!resources || seen.has(resources)) return;
    seen.add(resources);
    const fonts = dict(resources.get(PDFName.of('Font')));
    for (const [, ref] of fonts?.entries() ?? []) {
      const font = dict(ref);
      if (!font) continue;
      const subtype = font.get(PDFName.of('Subtype'));
      if (subtype === PDFName.of('Type3')) continue; // drawn by its own procedures: nothing to embed
      if (subtype === PDFName.of('Type0')) {
        const kids = ctx.lookup(font.get(PDFName.of('DescendantFonts')));
        const kid = kids instanceof PDFArray ? dict(kids.get(0)) : undefined;
        const embedded = !!kid && hasFile(kid);
        note(font.get(PDFName.of('BaseFont')), embedded);
        if (kid) note(kid.get(PDFName.of('BaseFont')), embedded);
      } else {
        note(font.get(PDFName.of('BaseFont')), hasFile(font));
      }
    }
    const xobjects = dict(resources.get(PDFName.of('XObject')));
    for (const [, ref] of xobjects?.entries() ?? []) {
      const xo = ctx.lookup(ref) as { dict?: PDFDict } | undefined;
      if (xo?.dict?.get(PDFName.of('Subtype')) === PDFName.of('Form')) walk(dict(xo.dict.get(PDFName.of('Resources'))));
    }
  };
  for (const page of doc.getPages()) walk(page.node.Resources());
  return out;
}

/**
 * The distinct fonts a page sets (`Tf`), in first-use order, including
 * fonts used inside form XObjects. `embedding` (from `readFontEmbedding`)
 * decides `embedded`; a font it doesn't know falls back to pdf.js's view.
 */
export async function getPageFonts(doc: PDFDocumentProxy, pageNumber: number, embedding?: FontEmbedding): Promise<PageFont[]> {
  const pdfjs = await getPdfjs();
  const page = await doc.getPage(pageNumber);
  const list = await page.getOperatorList();
  const ids: string[] = [];
  for (let i = 0; i < list.fnArray.length; i++) {
    if (list.fnArray[i] !== pdfjs.OPS.setFont) continue;
    const id = String((list.argsArray[i] as unknown[])[0]);
    if (!ids.includes(id)) ids.push(id);
  }
  const out: PageFont[] = [];
  for (const id of ids) {
    const f = await resolveFont(page, id);
    if (!f) continue;
    const name = baseName(f.name || id);
    const type3 = !!f.isType3Font;
    out.push({ id, name, type3, embedded: type3 || (embedding?.get(name) ?? !f.missingFile) });
  }
  return out;
}
