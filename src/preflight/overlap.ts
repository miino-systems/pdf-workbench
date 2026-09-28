/**
 * Signs of a page that doesn't display as intended, from its text runs
 * alone: two different pieces of text drawn on top of each other (e.g. a
 * logo that fell back to text and now sits over the next word).
 */
import type { PreflightFinding, Rect } from '@/core/types';

/** A text run in the page's visible frame (`y` = baseline). */
interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Runs with fewer letters/digits than this take no part: accents, operators, sub/superscript symbols in formulas. */
const MIN_CHARS = 2;
/** Share of the lower run's height the two must share vertically (adjacent lines only touch). */
const MIN_V_OVERLAP = 0.6;
/** Share of the narrower run's width they must share horizontally (kerning only nudges). */
const MIN_H_OVERLAP = 0.3;
/** …and at least this much, pt. */
const MIN_H_OVERLAP_PT = 2;

function chars(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * `TEXT_OVERLAP` findings: pairs of text runs (each with 2+ letters or
 * digits) whose boxes overlap substantially — sharing 60 % of the lower
 * one's height and 30 % (and 2 pt) of the narrower one's width. The same
 * text drawn twice at (nearly) the same place is left alone: that's how
 * some tools fake bold or add a shadow.
 */
export function findTextOverlaps(runs: TextRun[]): PreflightFinding[] {
  const cands = runs.filter((r) => r.width > 0 && r.height > 0 && chars(r.str) >= MIN_CHARS).sort((a, b) => a.y - b.y);
  const maxHeight = Math.max(0, ...cands.map((r) => r.height));
  const out: PreflightFinding[] = [];
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    for (let j = i + 1; j < cands.length && cands[j].y < a.y + Math.max(a.height, maxHeight); j++) {
      const b = cands[j];
      const vo = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (vo < MIN_V_OVERLAP * Math.min(a.height, b.height)) continue;
      const ho = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      if (ho < Math.max(MIN_H_OVERLAP_PT, MIN_H_OVERLAP * Math.min(a.width, b.width))) continue;
      const sa = a.str.trim();
      const sb = b.str.trim();
      const samePlace = Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;
      if (samePlace && (sa.includes(sb) || sb.includes(sa))) continue;
      // Box the narrower run: the clash is there (the other may be a whole line).
      const n = a.width <= b.width ? a : b;
      const rect: Rect = { x: n.x, y: n.y, width: n.width, height: n.height };
      out.push({ code: 'TEXT_OVERLAP', source: 'text', rect, text: `${sa} / ${sb}` });
    }
  }
  return out;
}
