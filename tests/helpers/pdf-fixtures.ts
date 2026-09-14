/**
 * pdf-lib-based PDF fixture builder for tests. Not part of the app bundle —
 * `pdf-lib` here plays the role of an independent "reference implementation"
 * to build inputs, so tests genuinely exercise `pdf/reader`/`preflight`
 * against real PDF bytes rather than hand-rolled/mocked pdfjs objects.
 */
import { PDFDocument, PDFName, PDFString, StandardFonts } from 'pdf-lib';

export interface FixtureTextSpec {
  text: string;
  x: number;
  y: number;
  size?: number;
}

export interface FixtureLinkSpec {
  /** `[x1, y1, x2, y2]`, PDF user space. */
  rect: [number, number, number, number];
  uri: string;
}

export interface FixturePageSpec {
  /** `[width, height]` in pt. */
  size: [number, number];
  texts?: FixtureTextSpec[];
  link?: FixtureLinkSpec;
}

/** Build a PDF from a small declarative page spec, for use with `pdf/reader` and `preflight` tests. */
export async function buildFixturePdf(pages: FixturePageSpec[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);

  for (const spec of pages) {
    const page = doc.addPage(spec.size);
    for (const t of spec.texts ?? []) {
      page.drawText(t.text, { x: t.x, y: t.y, size: t.size ?? 12, font });
    }
    if (spec.link) {
      const annotRef = doc.context.register(
        doc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: spec.link.rect,
          Border: [0, 0, 0],
          A: {
            Type: 'Action',
            S: 'URI',
            URI: PDFString.of(spec.link.uri),
          },
        }),
      );
      page.node.set(PDFName.of('Annots'), doc.context.obj([annotRef]));
    }
  }

  return doc.save();
}
