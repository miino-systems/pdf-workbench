/**
 * Signs of a page that doesn't display as intended, from its text runs
 * alone: two different pieces of text drawn on top of each other (e.g. a
 * logo that fell back to text and now sits over the next word).
 */
import type { PreflightFinding, Rect } from '@/core/types';

/** A text run in the page's visible frame (`y` = baseline); `run` for rotated text, see `PageTextBox`. */
interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
  run?: { x: number; y: number; angle: number; length: number; size: number };
}

/** A run measured in its own frame: `x` along the baseline, `y` the baseline. */
interface Local {
  src: TextRun;
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
/**
 * Baselines further apart than this share of the smaller run's size are
 * different lines, not a clash: superscripts and subscripts (`W^in`,
 * `W_ij^dyn`), axis tick labels over the axis title.
 */
const MAX_BASELINE_SHIFT = 0.25;
/** Runs are compared only with runs of the same direction, in steps of this many degrees. */
const ANGLE_STEP_DEG = 2;

function chars(s: string): number {
  return (s.match(/[\p{L}\p{N}]/gu) ?? []).length;
}

/**
 * `TEXT_OVERLAP` findings: pairs of text runs (each with 2+ letters or
 * digits) running the same direction whose boxes overlap substantially —
 * on (nearly) the same baseline (within 25 % of the smaller size), sharing
 * 60 % of the lower one's height and 30 % (and 2 pt) of the narrower one's
 * width, measured along their baseline (so rotated text, e.g. a figure's
 * vertical axis label, is judged by its real extent). The same text drawn
 * twice at (nearly) the same place is left alone: that's how some tools
 * fake bold or add a shadow.
 */
export function findTextOverlaps(runs: TextRun[]): PreflightFinding[] {
  const groups = new Map<number, TextRun[]>();
  for (const r of runs) {
    if (!(r.width > 0 && r.height > 0 && chars(r.str) >= MIN_CHARS)) continue;
    const step = Math.round(((r.run?.angle ?? 0) * 180) / Math.PI / ANGLE_STEP_DEG);
    const key = ((step % (360 / ANGLE_STEP_DEG)) + 360 / ANGLE_STEP_DEG) % (360 / ANGLE_STEP_DEG);
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: PreflightFinding[] = [];
  for (const [key, group] of groups) out.push(...overlapsInFrame(group, (key * ANGLE_STEP_DEG * Math.PI) / 180));
  return out;
}

/** {@link findTextOverlaps} for runs of one direction `angle`, compared in their own frame. */
function overlapsInFrame(runs: TextRun[], angle: number): PreflightFinding[] {
  const [c, s] = [Math.cos(angle), Math.sin(angle)];
  const cands: Local[] = runs
    .map((r) => {
      const o = r.run ?? { x: r.x, y: r.y, length: r.width, size: r.height };
      return { src: r, str: r.str, x: o.x * c + o.y * s, y: -o.x * s + o.y * c, width: o.length, height: o.size };
    })
    .filter((r) => r.width > 0 && r.height > 0)
    .sort((a, b) => a.y - b.y);
  const maxHeight = Math.max(0, ...cands.map((r) => r.height));
  const out: PreflightFinding[] = [];
  for (let i = 0; i < cands.length; i++) {
    const a = cands[i];
    for (let j = i + 1; j < cands.length && cands[j].y < a.y + Math.max(a.height, maxHeight); j++) {
      const b = cands[j];
      if (Math.abs(a.y - b.y) > MAX_BASELINE_SHIFT * Math.min(a.height, b.height)) continue;
      const vo = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (vo < MIN_V_OVERLAP * Math.min(a.height, b.height)) continue;
      const ho = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      if (ho < Math.max(MIN_H_OVERLAP_PT, MIN_H_OVERLAP * Math.min(a.width, b.width))) continue;
      const sa = a.str.trim();
      const sb = b.str.trim();
      const samePlace = Math.abs(a.x - b.x) < 1.5 && Math.abs(a.y - b.y) < 1.5;
      if (samePlace && (sa.includes(sb) || sb.includes(sa))) continue;
      // Box the narrower run: the clash is there (the other may be a whole line).
      const n = (a.width <= b.width ? a : b).src;
      const rect: Rect = { x: n.x, y: n.y, width: n.width, height: n.height };
      out.push({ code: 'TEXT_OVERLAP', source: 'text', rect, text: `${sa} / ${sb}` });
    }
  }
  return out;
}
