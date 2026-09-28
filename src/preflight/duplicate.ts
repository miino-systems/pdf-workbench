/**
 * "Already in the paper": does a page already carry what a stamp is about
 * to add — the same text (e.g. a licence line the author pasted in) or the
 * same image (e.g. a logo)? Pure functions over text runs and decoded
 * pixels; the caller supplies both (see `runPreflight`'s `duplicates`).
 */
import type { PreflightFinding, Rect } from '@/core/types';
import type { ImageDataLike } from './raster';

/** What one stamp would add to a page. */
export interface DuplicateProbe {
  /** Stamp name, shown in the finding. */
  name: string;
  /** Text of its text layers (`\n` separates lines). */
  texts: string[];
  /** Signatures of its image layers. */
  images: ImageSignature[];
}

/** A text run in the page's visible frame (`y` = baseline). */
interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Hyphens and dashes: dropped when matching, so a word split across lines ("Attribu-" / "tion") still matches. */
const DASHES = /[-­‐-―−]/g;

/** Text as compared: NFKC (ligatures, full-width), no whitespace, no hyphens/dashes; case kept. */
export function normalizeForMatch(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').replace(DASHES, '');
}

/** Below this many (normalized) characters a text must fill whole runs to count, so `DRAFT` doesn't match inside `DRAFTING`. */
const SHORT_TEXT = 12;
/** Each line of a multi-line stamp text of at least this many characters is also looked for on its own. */
const LINE_MIN = 20;

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const top = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: top - y };
}

/**
 * Where `text` already appears among a page's text runs (read in content
 * order). Two ways, so an author's copy that differs a little still counts:
 *  - exact, ignoring whitespace and hyphens (line breaks, hyphenation,
 *    scripts written without spaces) — the whole text, and each long line
 *    of a multi-line text on its own;
 *  - by words, for texts of {@link FUZZY_MIN_WORDS}+ words: a stretch of
 *    the page sharing at least {@link FUZZY_SHARE} of the text's words
 *    (case and punctuation ignored), so a changed year, a missing comma or
 *    "Non-Commercial" for "Non Commercial" doesn't hide it.
 * Returns one box per place found.
 */
export function findTextDuplicates(runs: TextRun[], text: string): Rect[] {
  const hits = [...exactHits(runs, text), ...wordHits(runs, text)];
  // Largest first; a hit whose runs are all inside an earlier one is the same place.
  hits.sort((a, b) => b.size - a.size);
  const kept: Set<number>[] = [];
  for (const h of hits) {
    if (kept.some((k) => [...h].every((i) => k.has(i)))) continue;
    kept.push(h);
  }
  return kept.map((set) => union([...set].map((i) => runs[i])));
}

/** Exact matches (normalized); each hit is the set of run indices it spans. */
function exactHits(runs: TextRun[], text: string): Set<number>[] {
  const chars: number[] = []; // run index of each normalized character
  let stream = '';
  const runStart: number[] = [];
  const runEnd: number[] = [];
  runs.forEach((run, i) => {
    const n = normalizeForMatch(run.str);
    runStart[i] = stream.length;
    stream += n;
    runEnd[i] = stream.length;
    for (let k = 0; k < n.length; k++) chars.push(i);
  });

  const lines = text.split('\n').map(normalizeForMatch);
  const needles = [normalizeForMatch(text)];
  if (lines.length > 1) needles.push(...lines.filter((l) => l.length >= LINE_MIN));

  const hits: Set<number>[] = [];
  for (const needle of needles) {
    if (needle.length < 3) continue;
    for (let at = stream.indexOf(needle); at !== -1; at = stream.indexOf(needle, at + needle.length)) {
      const first = chars[at];
      const last = chars[at + needle.length - 1];
      if (needle.length < SHORT_TEXT && (runStart[first] !== at || runEnd[last] !== at + needle.length)) continue;
      const set = new Set<number>();
      for (let i = first; i <= last; i++) if (runStart[i] !== runEnd[i]) set.add(i);
      hits.push(set);
    }
  }
  return hits;
}

/** Word matching needs a text of at least this many words (fewer is too easy to find by chance). */
const FUZZY_MIN_WORDS = 5;
/** Share of the text's words a stretch of the page must contain. */
const FUZZY_SHARE = 0.8;

/** A word as compared: NFKC, lower case, letters and digits only. */
function wordKey(w: string): string {
  return w.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
}

/** The page's words in reading order with the runs each comes from; a word hyphenated at a run's end is joined with the next. */
function pageWords(runs: TextRun[]): { key: string; runs: number[] }[] {
  const words: { key: string; runs: number[] }[] = [];
  let carry: { text: string; runs: number[] } | undefined;
  runs.forEach((run, i) => {
    const parts = run.str.split(/\s+/).filter(Boolean);
    parts.forEach((part, k) => {
      const text = (carry?.text ?? '') + part;
      const from = [...(carry?.runs ?? []), i];
      carry = undefined;
      if (k === parts.length - 1 && part.length > 1 && HYPHEN_END.test(part)) {
        carry = { text: text.replace(HYPHEN_END, ''), runs: from };
        return;
      }
      const key = wordKey(text);
      if (key) words.push({ key, runs: from });
    });
  });
  const key = carry ? wordKey(carry.text) : '';
  if (carry && key) words.push({ key, runs: carry.runs });
  return words;
}

const HYPHEN_END = /[-\u00ad\u2010\u2011]$/;

/** Stretches of the page sharing most of the text's words (see {@link findTextDuplicates}). */
function wordHits(runs: TextRun[], text: string): Set<number>[] {
  const want = text.split(/\s+/).map(wordKey).filter(Boolean);
  if (want.length < FUZZY_MIN_WORDS) return [];
  const need = new Map<string, number>();
  for (const w of want) need.set(w, (need.get(w) ?? 0) + 1);
  const words = pageWords(runs);
  const len = want.length;
  const threshold = Math.ceil(len * FUZZY_SHARE);

  /** How many of the text's words the window `[start, start + len)` supplies. */
  const score = (start: number): number => {
    const left = new Map(need);
    let n = 0;
    for (let i = start; i < Math.min(words.length, start + len); i++) {
      const c = left.get(words[i].key);
      if (c) {
        left.set(words[i].key, c - 1);
        n++;
      }
    }
    return n;
  };

  const hits: Set<number>[] = [];
  for (let start = 0; start < words.length; ) {
    const s = score(start);
    if (s < threshold) {
      start++;
      continue;
    }
    // Slide on while it keeps improving, then take that window.
    let best = start;
    let bestScore = s;
    for (let next = start + 1; next < words.length && next <= start + len; next++) {
      const ns = score(next);
      if (ns > bestScore) {
        best = next;
        bestScore = ns;
      }
    }
    const matched = words.slice(best, best + len).filter((w) => need.has(w.key));
    hits.push(new Set(matched.flatMap((w) => w.runs)));
    start = best + len;
  }
  return hits;
}

// ---------------------------------------------------------------------------
// Images

/** Side of the grid an image is reduced to for comparison. */
const GRID = 16;

/**
 * A small fingerprint of an image for "same picture?" checks that survive
 * rescaling and recompression: its aspect ratio and the image reduced to
 * a 16×16 grey grid (over white, so transparent = white), compared as
 * brightness-vs-mean and left-vs-right bit patterns.
 */
export interface ImageSignature {
  aspect: number;
  /** 256 bits: cell brighter than the mean. */
  mean: Uint8Array;
  /** 256 bits: cell brighter than its right neighbour (last column: than the first). */
  gradient: Uint8Array;
  /** Almost uniform (blank, a solid box): never matched, it would match every other such image. */
  flat: boolean;
}

export function imageSignature(img: ImageDataLike): ImageSignature {
  const { width, height, data } = img;
  const sum = new Float64Array(GRID * GRID);
  const count = new Float64Array(GRID * GRID);
  for (let y = 0; y < height; y++) {
    const gy = Math.min(GRID - 1, Math.floor((y * GRID) / height));
    for (let x = 0; x < width; x++) {
      const gx = Math.min(GRID - 1, Math.floor((x * GRID) / width));
      const i = (y * width + x) * 4;
      const a = (data[i + 3] ?? 255) / 255;
      const lum = 0.2126 * (data[i] ?? 255) + 0.7152 * (data[i + 1] ?? 255) + 0.0722 * (data[i + 2] ?? 255);
      sum[gy * GRID + gx] += lum * a + 255 * (1 - a);
      count[gy * GRID + gx] += 1;
    }
  }
  const cells = Array.from(sum, (s, i) => (count[i] ? s / count[i] : 255));
  const avg = cells.reduce((a, b) => a + b, 0) / cells.length;
  const spread = Math.max(...cells) - Math.min(...cells);
  const mean = new Uint8Array(cells.length);
  const gradient = new Uint8Array(cells.length);
  for (let r = 0; r < GRID; r++) {
    for (let c = 0; c < GRID; c++) {
      const i = r * GRID + c;
      mean[i] = cells[i] > avg ? 1 : 0;
      gradient[i] = cells[i] > cells[r * GRID + ((c + 1) % GRID)] ? 1 : 0;
    }
  }
  return { aspect: width / height, mean, gradient, flat: spread < 16 };
}

function hamming(a: Uint8Array, b: Uint8Array): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

/** At most this share of the bits may differ (per pattern) for two images to count as the same. */
const MAX_BIT_DIFF = 0.12;

/** Do two signatures show the same picture (aspect within 15 %, both bit patterns within {@link MAX_BIT_DIFF})? */
export function sameImage(a: ImageSignature, b: ImageSignature): boolean {
  if (a.flat || b.flat) return false;
  const ratio = a.aspect / b.aspect;
  if (ratio > 1.15 || ratio < 1 / 1.15) return false;
  const limit = a.mean.length * MAX_BIT_DIFF;
  return hamming(a.mean, b.mean) <= limit && hamming(a.gradient, b.gradient) <= limit;
}

/** Images smaller than this (pt, either side) are not compared: bullets, rules, tiny glyph-like bitmaps. */
const MIN_IMAGE_PT = 4;

/**
 * `STAMP_DUPLICATE` findings for one page: every place where a probe's
 * text or image is already present. `images` are the page's images with
 * their box in the visible frame.
 */
export function findStampDuplicates(
  probes: DuplicateProbe[],
  runs: TextRun[],
  images: { rect: Rect; signature: ImageSignature }[],
): PreflightFinding[] {
  const out: PreflightFinding[] = [];
  for (const probe of probes) {
    for (const text of probe.texts) {
      for (const rect of findTextDuplicates(runs, text)) out.push({ code: 'STAMP_DUPLICATE', source: 'stamp', rect, text: probe.name });
    }
    for (const sig of probe.images) {
      for (const img of images) {
        if (img.rect.width < MIN_IMAGE_PT || img.rect.height < MIN_IMAGE_PT) continue;
        if (sameImage(sig, img.signature)) out.push({ code: 'STAMP_DUPLICATE', source: 'stamp', rect: img.rect, text: probe.name });
      }
    }
  }
  return out;
}
