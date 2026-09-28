/**
 * Text rules (`PreflightConfig.textRules`): regular expressions a set of
 * pages must contain (`require`, e.g. an ORCID section on page 1) or must
 * not contain (`forbid`, e.g. a hand-typed page number). Nothing here knows
 * about any particular venue; the rules come from `preflight.json`.
 */
import type { PreflightFinding, PreflightTextRule, PreflightWarningCode, Rect } from '@/core/types';

/** A text run in the page's visible frame (`y` = baseline). */
interface TextRun {
  str: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export const TEXT_REQUIRED = 'TEXT_REQUIRED';
export const TEXT_FORBIDDEN = 'TEXT_FORBIDDEN';
export const TEXT_RULE_INVALID = 'TEXT_RULE_INVALID';

/** `TEXT_REQUIRED:<id>` etc.: the code a rule reports under. */
export function textRuleCode(kind: typeof TEXT_REQUIRED | typeof TEXT_FORBIDDEN | typeof TEXT_RULE_INVALID, id: string): PreflightWarningCode {
  return `${kind}:${id}`;
}

/** Split a rule code back into its kind and rule id (`undefined` for other codes). */
export function parseTextRuleCode(code: string): { kind: string; id: string } | undefined {
  const m = /^(TEXT_REQUIRED|TEXT_FORBIDDEN|TEXT_RULE_INVALID):(.*)$/.exec(code);
  return m ? { kind: m[1], id: m[2] } : undefined;
}

export interface CompiledTextRule {
  rule: PreflightTextRule;
  require?: RegExp;
  forbid?: RegExp;
}

/**
 * Compile the rules' patterns (`u` is always on, `g` is added for `forbid`).
 * A rule whose pattern doesn't compile is returned in `invalid` and not run.
 */
export function compileTextRules(rules: PreflightTextRule[] | undefined): { compiled: CompiledTextRule[]; invalid: PreflightTextRule[] } {
  const compiled: CompiledTextRule[] = [];
  const invalid: PreflightTextRule[] = [];
  for (const [i, raw] of (rules ?? []).entries()) {
    if (!raw || typeof raw !== 'object') continue;
    const rule = raw.id ? raw : { ...raw, id: `rule${i + 1}` };
    const flags = [...new Set(`${(rule.flags ?? '').replace(/[gyu]/g, '')}u`)].join('');
    try {
      const c: CompiledTextRule = { rule };
      if (rule.require) c.require = new RegExp(rule.require, flags);
      if (rule.forbid) c.forbid = new RegExp(rule.forbid, `${flags}g`);
      if (c.require || c.forbid) compiled.push(c);
    } catch {
      invalid.push(rule);
    }
  }
  return { compiled, invalid };
}

/**
 * A page's text as the rules see it: runs in content order, runs on one
 * line joined directly when they touch (a word split into pieces) and with
 * a space otherwise, lines joined with a space, runs of whitespace
 * collapsed to one space. `runAt[i]` is the run character `i` came from
 * (-1 for an inserted space).
 */
export function pageTextForRules(runs: TextRun[]): { text: string; runAt: number[] } {
  let text = '';
  const runAt: number[] = [];
  const push = (s: string, run: number): void => {
    for (const ch of s) {
      const space = /\s/.test(ch);
      if (space && (text === '' || text.endsWith(' '))) continue;
      text += space ? ' ' : ch;
      runAt.push(space ? -1 : run);
      if (ch.length === 2) runAt.push(run); // astral character: two UTF-16 units
    }
  };
  runs.forEach((run, i) => {
    const prev = runs[i - 1];
    if (prev && text !== '' && !text.endsWith(' ')) {
      const sameLine = Math.abs(prev.y - run.y) < Math.max(prev.height, run.height) * 0.5;
      const gap = run.x - (prev.x + prev.width);
      if (!(sameLine && gap < Math.max(prev.height, run.height) * 0.15)) push(' ', -1);
    }
    push(run.str, i);
  });
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    runAt.pop();
  }
  return { text, runAt };
}

function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map((r) => r.x));
  const y = Math.min(...rects.map((r) => r.y));
  const right = Math.max(...rects.map((r) => r.x + r.width));
  const top = Math.max(...rects.map((r) => r.y + r.height));
  return { x, y, width: right - x, height: top - y };
}

/** Does the page's text match `rule.require`? */
export function pageMatchesRequired(rule: CompiledTextRule, runs: TextRun[]): boolean {
  return !!rule.require && rule.require.test(pageTextForRules(runs).text);
}

/** Every place the page's text matches `rule.forbid`, located on its runs. */
export function findForbiddenText(rule: CompiledTextRule, runs: TextRun[]): PreflightFinding[] {
  if (!rule.forbid) return [];
  const { text, runAt } = pageTextForRules(runs);
  const code = textRuleCode(TEXT_FORBIDDEN, rule.rule.id);
  const out: PreflightFinding[] = [];
  rule.forbid.lastIndex = 0;
  for (const m of text.matchAll(rule.forbid)) {
    if (m[0] === '') continue;
    const at = m.index ?? 0;
    const hit = new Set(runAt.slice(at, at + m[0].length).filter((i) => i >= 0));
    if (hit.size === 0) continue;
    out.push({ code, source: 'text', rect: union([...hit].map((i) => runs[i])), text: m[0] });
  }
  return out;
}
