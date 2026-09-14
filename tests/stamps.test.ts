import { describe, expect, it } from 'vitest';
import {
  BUILTIN_STAMP_TEMPLATES,
  createId,
  createInstanceFromDefinition,
  describePageSelector,
  effectivePosition,
  parsePageList,
  renderPageNumber,
  resolvePages,
  resolveStampOrigin,
  validateStampsConfig,
} from '@/stamps';
import type { PageSelector, StampAnchor, StampDefinition, StampInstance, StampsConfig } from '@/core/types';

describe('resolvePages', () => {
  const pageCount = 10;

  it('all -> every page', () => {
    expect(resolvePages({ kind: 'all' }, pageCount)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it('first -> [1]', () => {
    expect(resolvePages({ kind: 'first' }, pageCount)).toEqual([1]);
  });

  it('last -> [pageCount]', () => {
    expect(resolvePages({ kind: 'last' }, pageCount)).toEqual([10]);
  });

  it('range in order', () => {
    expect(resolvePages({ kind: 'range', from: 3, to: 6 }, pageCount)).toEqual([3, 4, 5, 6]);
  });

  it('range reversed still resolves in order', () => {
    expect(resolvePages({ kind: 'range', from: 6, to: 3 }, pageCount)).toEqual([3, 4, 5, 6]);
  });

  it('range clamped to page count', () => {
    expect(resolvePages({ kind: 'range', from: 8, to: 20 }, pageCount)).toEqual([8, 9, 10]);
  });

  it('list dedupes, sorts, and drops out-of-range entries', () => {
    expect(resolvePages({ kind: 'list', pages: [5, 1, 5, 0, -3, 100, 3] }, pageCount)).toEqual([1, 3, 5]);
  });

  it('odd pages', () => {
    expect(resolvePages({ kind: 'odd' }, pageCount)).toEqual([1, 3, 5, 7, 9]);
  });

  it('even pages', () => {
    expect(resolvePages({ kind: 'even' }, pageCount)).toEqual([2, 4, 6, 8, 10]);
  });

  it('empty document -> no pages', () => {
    expect(resolvePages({ kind: 'all' }, 0)).toEqual([]);
  });
});

describe('describePageSelector', () => {
  it('renders every selector kind in Japanese', () => {
    expect(describePageSelector({ kind: 'all' })).toBe('全ページ');
    expect(describePageSelector({ kind: 'first' })).toBe('先頭ページ');
    expect(describePageSelector({ kind: 'last' })).toBe('最終ページ');
    expect(describePageSelector({ kind: 'range', from: 2, to: 5 })).toBe('p.2–5');
    expect(describePageSelector({ kind: 'range', from: 5, to: 2 })).toBe('p.2–5');
    expect(describePageSelector({ kind: 'list', pages: [1, 3, 7] })).toBe('p.1,3,7');
    expect(describePageSelector({ kind: 'odd' })).toBe('奇数ページ');
    expect(describePageSelector({ kind: 'even' })).toBe('偶数ページ');
  });
});

describe('parsePageList', () => {
  it('expands ranges and singles', () => {
    const selector = parsePageList('1,3-5,8');
    expect(selector).toEqual({ kind: 'list', pages: [1, 3, 4, 5, 8] });
  });

  it('handles reversed ranges', () => {
    const selector = parsePageList('5-3');
    expect(selector).toEqual({ kind: 'list', pages: [3, 4, 5] });
  });

  it('drops entries beyond pageCount when given', () => {
    const selector = parsePageList('1,3-5,8', 4);
    expect(selector).toEqual({ kind: 'list', pages: [1, 3, 4] });
  });

  it('ignores blank segments and whitespace', () => {
    const selector = parsePageList(' 1 , , 2 ');
    expect(selector).toEqual({ kind: 'list', pages: [1, 2] });
  });
});

describe('resolveStampOrigin', () => {
  const page = { width: 600, height: 800 };
  const box = { width: 100, height: 40 };

  const cases: { anchor: StampAnchor; offsetX: number; offsetY: number; expected: { x: number; y: number } }[] = [
    { anchor: 'top-left', offsetX: 10, offsetY: 20, expected: { x: 10, y: 800 - 20 - 40 } },
    { anchor: 'top-center', offsetX: 5, offsetY: 20, expected: { x: (600 - 100) / 2 + 5, y: 800 - 20 - 40 } },
    { anchor: 'top-right', offsetX: 10, offsetY: 20, expected: { x: 600 - 10 - 100, y: 800 - 20 - 40 } },
    { anchor: 'middle-left', offsetX: 10, offsetY: 5, expected: { x: 10, y: (800 - 40) / 2 + 5 } },
    { anchor: 'middle-center', offsetX: 0, offsetY: 0, expected: { x: (600 - 100) / 2, y: (800 - 40) / 2 } },
    { anchor: 'middle-right', offsetX: 10, offsetY: 5, expected: { x: 600 - 10 - 100, y: (800 - 40) / 2 + 5 } },
    { anchor: 'bottom-left', offsetX: 10, offsetY: 20, expected: { x: 10, y: 20 } },
    { anchor: 'bottom-center', offsetX: 0, offsetY: 20, expected: { x: (600 - 100) / 2, y: 20 } },
    { anchor: 'bottom-right', offsetX: 36, offsetY: 36, expected: { x: 600 - 36 - 100, y: 36 } },
  ];

  for (const { anchor, offsetX, offsetY, expected } of cases) {
    it(`anchor=${anchor}`, () => {
      const origin = resolveStampOrigin({ anchor, offsetX, offsetY }, page, box);
      expect(origin.x).toBeCloseTo(expected.x);
      expect(origin.y).toBeCloseTo(expected.y);
    });
  }
});

describe('effectivePosition', () => {
  const def: StampDefinition = {
    id: 'd1',
    name: 'Def',
    layers: [],
    defaultPosition: { anchor: 'top-left', offsetX: 1, offsetY: 2 },
  };

  it('uses the instance override when present', () => {
    const inst: StampInstance = {
      id: 'i1',
      stampId: 'd1',
      enabled: true,
      pages: { kind: 'all' },
      position: { anchor: 'bottom-left', offsetX: 5, offsetY: 6 },
    };
    expect(effectivePosition(def, inst)).toEqual({ anchor: 'bottom-left', offsetX: 5, offsetY: 6 });
  });

  it('falls back to the definition default', () => {
    const inst: StampInstance = { id: 'i1', stampId: 'd1', enabled: true, pages: { kind: 'all' } };
    expect(effectivePosition(def, inst)).toEqual(def.defaultPosition);
  });

  it('falls back to the global default when neither is set', () => {
    const bareDef: StampDefinition = { id: 'd2', name: 'Bare', layers: [] };
    const inst: StampInstance = { id: 'i1', stampId: 'd2', enabled: true, pages: { kind: 'all' } };
    expect(effectivePosition(bareDef, inst)).toEqual({ anchor: 'bottom-right', offsetX: 36, offsetY: 36 });
  });
});

describe('renderPageNumber', () => {
  it('substitutes {page}', () => {
    expect(renderPageNumber('{page}', { page: 3, pages: 10 })).toBe('3');
  });

  it('substitutes {page} / {pages}', () => {
    expect(renderPageNumber('{page} / {pages}', { page: 3, pages: 10 })).toBe('3 / 10');
  });

  it('substitutes "Page {page} of {pages}"', () => {
    expect(renderPageNumber('Page {page} of {pages}', { page: 1, pages: 5 })).toBe('Page 1 of 5');
  });

  it('substitutes {file} without its extension', () => {
    expect(renderPageNumber('{file}', { page: 1, pages: 1, file: 'papers/paper001.pdf' })).toBe('paper001');
  });

  it('leaves unknown placeholders untouched', () => {
    expect(renderPageNumber('{page}/{total}', { page: 1, pages: 1 })).toBe('1/{total}');
  });

  it('leaves {file} untouched when no file is given', () => {
    expect(renderPageNumber('{file}', { page: 1, pages: 1 })).toBe('{file}');
  });
});

describe('createId / createInstanceFromDefinition', () => {
  it('createId produces unique, prefixed ids', () => {
    const a = createId('inst');
    const b = createId('inst');
    expect(a).not.toBe(b);
    expect(a.startsWith('inst-')).toBe(true);
  });

  it('createInstanceFromDefinition uses the definition default pages', () => {
    const def = BUILTIN_STAMP_TEMPLATES.find((d) => d.id === 'page-number')!;
    const inst = createInstanceFromDefinition(def);
    expect(inst.enabled).toBe(true);
    expect(inst.stampId).toBe('page-number');
    expect(inst.pages).toEqual(def.defaultPages);
  });

  it('falls back to all pages when the definition has no default', () => {
    const def: StampDefinition = { id: 'x', name: 'X', layers: [] };
    const inst = createInstanceFromDefinition(def);
    expect(inst.pages).toEqual({ kind: 'all' });
  });
});

describe('BUILTIN_STAMP_TEMPLATES', () => {
  it('has the expected ids', () => {
    expect(BUILTIN_STAMP_TEMPLATES.map((d) => d.id).sort()).toEqual(
      ['cc-by-4.0', 'confidential', 'custom-text', 'draft', 'page-number'].sort(),
    );
  });

  it('is a valid StampsConfig on its own', () => {
    const cfg: StampsConfig = { version: 1, definitions: BUILTIN_STAMP_TEMPLATES, instances: [] };
    expect(validateStampsConfig(cfg)).toEqual([]);
  });
});

describe('validateStampsConfig', () => {
  const baseDef: StampDefinition = {
    id: 'd1',
    name: 'D1',
    layers: [{ id: 'l1', type: 'text', text: 'hi', font: { kind: 'standard', name: 'Helvetica' }, size: 12, color: '#000000' }],
  };

  it('accepts a valid config', () => {
    const cfg: StampsConfig = { version: 1, definitions: [baseDef], instances: [] };
    expect(validateStampsConfig(cfg)).toEqual([]);
  });

  it('flags an instance referencing an unknown stampId', () => {
    const inst: StampInstance = { id: 'i1', stampId: 'missing', enabled: true, pages: { kind: 'all' } };
    const cfg: StampsConfig = { version: 1, definitions: [baseDef], instances: [inst] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('unknown stampId'))).toBe(true);
  });

  it('flags duplicate definition ids', () => {
    const cfg: StampsConfig = { version: 1, definitions: [baseDef, baseDef], instances: [] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('duplicate stamp definition id'))).toBe(true);
  });

  it('flags duplicate instance ids', () => {
    const inst: StampInstance = { id: 'i1', stampId: 'd1', enabled: true, pages: { kind: 'all' } };
    const cfg: StampsConfig = { version: 1, definitions: [baseDef], instances: [inst, { ...inst }] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('duplicate stamp instance id'))).toBe(true);
  });

  it('flags an unimplemented layer type', () => {
    const def: StampDefinition = {
      id: 'd2',
      name: 'D2',
      layers: [{ id: 'l1', type: 'line' } as StampDefinition['layers'][number]],
    };
    const cfg: StampsConfig = { version: 1, definitions: [def], instances: [] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('unimplemented type'))).toBe(true);
  });

  it('flags an empty pageNumber template', () => {
    const def: StampDefinition = {
      id: 'd3',
      name: 'D3',
      layers: [
        {
          id: 'l1',
          type: 'pageNumber',
          template: '',
          font: { kind: 'standard', name: 'Helvetica' },
          size: 10,
          color: '#000000',
        },
      ],
    };
    const cfg: StampsConfig = { version: 1, definitions: [def], instances: [] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('empty template'))).toBe(true);
  });

  it('flags a non-positive size', () => {
    const def: StampDefinition = {
      id: 'd4',
      name: 'D4',
      layers: [
        { id: 'l1', type: 'text', text: 'x', font: { kind: 'standard', name: 'Helvetica' }, size: 0, color: '#000000' },
      ],
    };
    const cfg: StampsConfig = { version: 1, definitions: [def], instances: [] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('non-positive size'))).toBe(true);
  });

  it('flags a bad hex colour', () => {
    const def: StampDefinition = {
      id: 'd5',
      name: 'D5',
      layers: [
        { id: 'l1', type: 'text', text: 'x', font: { kind: 'standard', name: 'Helvetica' }, size: 10, color: 'red' },
      ],
    };
    const cfg: StampsConfig = { version: 1, definitions: [def], instances: [] };
    const problems = validateStampsConfig(cfg);
    expect(problems.some((p) => p.includes('invalid colour'))).toBe(true);
  });
});

// Sanity check that PageSelector is exercised as a plain discriminated union
// (no reliance on class instances), matching @/core/types.
describe('PageSelector shape', () => {
  it('round-trips through parsePageList', () => {
    const s: PageSelector = parsePageList('2,4,6');
    expect(s.kind).toBe('list');
  });
});
