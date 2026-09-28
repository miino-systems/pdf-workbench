/**
 * Review copy of a PDF that failed preflight: the original pages with the
 * problems marked, for sending back to authors or checking by eye.
 *
 *  - the allowed text area (page minus margins) as a dashed frame,
 *  - each located finding boxed in red with a short ASCII label,
 *  - a comment (PDF Square annotation, Japanese text) on each box and a
 *    sticky note (Text annotation) per page listing every problem,
 *    so viewers show them in their comments list.
 *
 * Works on a copy: the source bytes are only read. Boxes are drawn into the
 * page content so they also show when printed.
 */
import { PDFDocument, PDFHexString, PDFName, PDFObject, PDFPage, PDFString, StandardFonts, degrees, rgb } from 'pdf-lib';
import type { PageSize, PreflightConfig, PreflightFinding, PreflightReport, PreflightWarningCode, Rect } from '@/core/types';
import { toPt } from '@/core/units';
import { normalizeAngle, toContentPoint, visiblePageSize, type PageAngle } from '@/pdf/stamper/rotation';
import { marginsForPage } from './checks';
import { TEXT_FORBIDDEN, TEXT_REQUIRED, TEXT_RULE_INVALID, parseTextRuleCode } from './textRules';

const RED = rgb(0.86, 0.1, 0.12);
const AUTHOR = 'PDF Workbench Preflight';

/**
 * Japanese description of a preflight code, for comments and summaries.
 * With `config`, a text rule's code is described by the rule's `message`.
 */
export function describePreflightCode(code: PreflightWarningCode, config?: PreflightConfig): string {
  const rule = parseTextRuleCode(code);
  if (rule) {
    const message = config?.textRules?.find((r) => r.id === rule.id)?.message;
    if (message && rule.kind !== TEXT_RULE_INVALID) return message;
    if (rule.kind === TEXT_REQUIRED) return `必要なテキストがありません（${rule.id}）`;
    if (rule.kind === TEXT_FORBIDDEN) return `使ってはいけないテキストがあります（${rule.id}）`;
    return `テキストルール「${rule.id}」の正規表現が正しくありません`;
  }
  switch (code) {
    case 'TOP_MARGIN':
      return '上余白にはみ出しています';
    case 'BOTTOM_MARGIN':
      return '下余白にはみ出しています';
    case 'LEFT_MARGIN':
      return '左余白にはみ出しています';
    case 'RIGHT_MARGIN':
      return '右余白にはみ出しています';
    case 'PAGE_SIZE':
      return '用紙サイズが指定と違います';
    case 'PAGE_ORIENTATION':
      return '用紙の向きが指定と違います';
    case 'PAGE_COUNT_MIN':
      return 'ページ数が最小値より少ないです';
    case 'PAGE_COUNT_MAX':
      return 'ページ数が最大値を超えています';
    case 'STAMP_COLLISION':
      return 'スタンプが既存の内容と重なります';
    case 'STAMP_DUPLICATE':
      return 'スタンプと同じ内容が原稿にすでにあります';
    default:
      return code;
  }
}

const SOURCE_LABEL: Record<PreflightFinding['source'], string> = {
  text: '文字',
  raster: '描画',
  page: 'ページ',
  stamp: 'スタンプ',
};

function findingComment(f: PreflightFinding, config: PreflightConfig): string {
  const what = f.text ? `「${f.text.length > 60 ? `${f.text.slice(0, 60)}…` : f.text}」` : '';
  return `${describePreflightCode(f.code, config)}（${SOURCE_LABEL[f.source]}${what ? `: ${what}` : ''}）`;
}

/** A rect in the visible frame → the same area in content space (for drawing/annotations). */
function toContentRect(r: Rect, angle: PageAngle, raw: PageSize): Rect {
  const a = toContentPoint({ x: r.x, y: r.y }, angle, raw);
  const b = toContentPoint({ x: r.x + r.width, y: r.y + r.height }, angle, raw);
  return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(b.x - a.x), height: Math.abs(b.y - a.y) };
}

/** Mirrors the dictionary literal `PDFContext.obj` accepts (pdf-lib doesn't export its `LiteralObject` type). */
type Literal = AnnotationDict | Literal[] | PDFObject | string | number | boolean | null | undefined;
interface AnnotationDict {
  [name: string]: Literal;
}

function addAnnotation(doc: PDFDocument, page: PDFPage, dict: AnnotationDict): void {
  const ref = doc.context.register(doc.context.obj(dict));
  const existing = page.node.Annots();
  if (existing) existing.push(ref);
  else page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
}

function commonAnnotation(contents: string, rect: Rect): AnnotationDict {
  return {
    Type: 'Annot',
    Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
    Contents: PDFHexString.fromText(contents),
    T: PDFHexString.fromText(AUTHOR),
    M: PDFString.fromDate(new Date()),
    C: [0.86, 0.1, 0.12],
    F: 4, // print
  };
}

/**
 * Build the annotated review copy for `report` (pages without problems are
 * kept unchanged). `config` supplies the margins to draw the frame with.
 */
export async function annotatePreflightPdf(
  sourceBytes: Uint8Array,
  report: PreflightReport,
  config: PreflightConfig,
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(sourceBytes, { updateMetadata: false, ignoreEncryption: true });
  const font = doc.embedStandardFont(StandardFonts.Helvetica);
  const pageCount = doc.getPageCount();

  for (const result of report.pages) {
    const docLevel = result.page === 1 ? report.documentWarnings : [];
    const codes = [...docLevel, ...(result.errors ?? []), ...result.warnings];
    if (codes.length === 0) continue;
    const page = doc.getPage(result.page - 1);
    const raw = page.getSize();
    const angle = normalizeAngle(page.getRotation().angle);
    const visible = visiblePageSize(raw, angle);

    // Allowed area: page minus the margins that apply to this page.
    if (config.margins) {
      const m = marginsForPage(config.margins, config.marginOverrides, result.page, pageCount);
      const [top, bottom, left, right] = [m.top, m.bottom, m.left, m.right].map((v) => toPt(v, m.unit));
      const area = toContentRect(
        { x: left, y: bottom, width: visible.width - left - right, height: visible.height - top - bottom },
        angle,
        raw,
      );
      page.drawRectangle({ ...area, borderColor: RED, borderWidth: 0.6, borderDashArray: [4, 3], borderOpacity: 0.7 });
    }

    for (const f of result.findings ?? []) {
      if (!f.rect) continue;
      const r = toContentRect(
        { x: f.rect.x - 1, y: f.rect.y - 1, width: f.rect.width + 2, height: f.rect.height + 2 },
        angle,
        raw,
      );
      page.drawRectangle({ ...r, color: RED, opacity: 0.12, borderColor: RED, borderWidth: 1, borderOpacity: 0.9 });
      page.drawText(String(f.code), { x: r.x, y: r.y + r.height + 1.5, size: 5.5, font, color: RED });
      addAnnotation(doc, page, {
        ...commonAnnotation(findingComment(f, config), r),
        Subtype: 'Square',
        BS: { W: 1 },
        CA: 0.9,
      });
    }

    // One sticky note per page listing everything (incl. page-level problems without a location).
    const lines = [...new Set(codes)].map((c) => `・${describePreflightCode(c, config)}`);
    const located = (result.findings ?? []).filter((f) => f.rect).length;
    const note =
      `Preflight: ${report.file} p.${result.page}\n` +
      `${lines.join('\n')}` +
      (located ? `\n（赤枠 ${located} 箇所．点線は余白の内側の範囲）` : '');
    const noteAt = toContentRect({ x: 4, y: visible.height - 22, width: 18, height: 18 }, angle, raw);
    addAnnotation(doc, page, {
      ...commonAnnotation(note, noteAt),
      Subtype: 'Text',
      Name: 'Comment',
      Open: false,
    });
    page.drawText(`PREFLIGHT: ${[...new Set(codes)].join(', ')}`, {
      ...toContentPoint({ x: 26, y: visible.height - 14 }, angle, raw),
      size: 6.5,
      font,
      color: RED,
      rotate: degrees(angle),
    });
  }

  return doc.save({ useObjectStreams: false, updateFieldAppearances: false });
}
