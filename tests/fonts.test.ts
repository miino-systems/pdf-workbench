import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FontResolver, fontWarningMessage, withHash } from '@/fonts';
import { readLocalFontBytes } from '@/fonts/local';
import { sha256 } from '@/fonts/hash';
import type { FontRef } from '@/core/types';

const FIXTURE_PATH = path.resolve(__dirname, 'fixtures/ipag-subset.ttf');

async function loadFixtureBytes(): Promise<Uint8Array> {
  const buffer = await readFile(FIXTURE_PATH);
  return new Uint8Array(buffer);
}

describe('FontResolver workspace fonts', () => {
  it('resolves workspace font bytes and computes sha256', async () => {
    const bytes = await loadFixtureBytes();
    const resolver = new FontResolver({
      readWorkspaceFile: async (p) => {
        expect(p).toBe('fonts/ipag-subset.ttf');
        return bytes;
      },
    });

    const ref: FontRef = { kind: 'workspace', path: 'fonts/ipag-subset.ttf' };
    const resolved = await resolver.resolve(ref);

    expect(resolved.bytes).toBeInstanceOf(Uint8Array);
    expect(resolved.bytes?.length).toBe(bytes.length);
    expect(resolved.sha256).toBe(await sha256(bytes));
    expect(resolved.hashMismatch).toBe(false);
    expect(fontWarningMessage(resolved)).toBeUndefined();
  });

  it('flags hashMismatch when ref.sha256 differs from the resolved bytes', async () => {
    const bytes = await loadFixtureBytes();
    const resolver = new FontResolver({
      readWorkspaceFile: async () => bytes,
    });

    const ref: FontRef = {
      kind: 'workspace',
      path: 'fonts/ipag-subset.ttf',
      sha256: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    };
    const resolved = await resolver.resolve(ref);

    expect(resolved.hashMismatch).toBe(true);
    expect(fontWarningMessage(resolved)).toBe(
      '同名フォントですが，以前使用したフォントと内容が異なります',
    );
  });

  it('withHash fills in sha256 for saving back to config', async () => {
    const bytes = await loadFixtureBytes();
    const resolver = new FontResolver({ readWorkspaceFile: async () => bytes });
    const ref: FontRef = { kind: 'workspace', path: 'fonts/ipag-subset.ttf' };
    const resolved = await resolver.resolve(ref);

    const updated = withHash(ref, resolved);
    expect(updated).not.toBe(ref);
    expect((updated as { sha256?: string }).sha256).toBe(resolved.sha256);
    // Original ref is untouched.
    expect((ref as { sha256?: string }).sha256).toBeUndefined();
  });

  it('caches resolved bytes per key for the resolver lifetime', async () => {
    const bytes = await loadFixtureBytes();
    let calls = 0;
    const resolver = new FontResolver({
      readWorkspaceFile: async () => {
        calls += 1;
        return bytes;
      },
    });
    const ref: FontRef = { kind: 'workspace', path: 'fonts/ipag-subset.ttf' };
    await resolver.resolve(ref);
    await resolver.resolve(ref);
    expect(calls).toBe(1);
  });

  it('standard fonts resolve without bytes and never mismatch', async () => {
    const resolver = new FontResolver();
    const resolved = await resolver.resolve({ kind: 'standard', name: 'Helvetica' });
    expect(resolved.bytes).toBeUndefined();
    expect(resolved.sha256).toBeUndefined();
    expect(resolved.hashMismatch).toBe(false);
  });
});

describe('FontResolver file refs', () => {
  it('resolves from pickedFiles when present', async () => {
    const bytes = await loadFixtureBytes();
    const resolver = new FontResolver({ pickedFiles: new Map([['my-font.ttf', bytes]]) });
    const resolved = await resolver.resolve({ kind: 'file', name: 'my-font.ttf' });
    expect(resolved.bytes?.length).toBe(bytes.length);
  });

  it('throws a clear error when the file is not loaded', async () => {
    const resolver = new FontResolver();
    await expect(resolver.resolve({ kind: 'file', name: 'missing.ttf' })).rejects.toThrow(
      /"missing\.ttf" is not loaded; please pick it again/,
    );
  });
});

describe('FontResolver local refs', () => {
  it('throws when the local font was never listed', async () => {
    const resolver = new FontResolver();
    await expect(
      resolver.resolve({ kind: 'local', family: 'Foo', postscriptName: 'Foo-Regular' }),
    ).rejects.toThrow(/Foo-Regular/);
  });
});

describe('readLocalFontBytes', () => {
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
  });

  it('falls back to a targeted queryLocalFonts() lookup when the cache is empty (e.g. after a page reload)', async () => {
    // Simulate a page reload: `listLocalFonts()` was never called this
    // session (so the module-level cache is empty), but stamps.json still
    // references a `local` FontRef and the browser's permission grant is
    // still in effect.
    const bytes = await loadFixtureBytes();
    const blob = { arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    let queried: { postscriptNames?: string[] } | undefined;
    (globalThis as unknown as { window: unknown }).window = {
      queryLocalFonts: async (opts?: { postscriptNames?: string[] }) => {
        queried = opts;
        if (opts?.postscriptNames?.includes('Foo-Regular')) {
          return [{ family: 'Foo', fullName: 'Foo Regular', postscriptName: 'Foo-Regular', style: 'Regular', blob: async () => blob }];
        }
        return [];
      },
    };

    const result = await readLocalFontBytes('Foo-Regular');
    expect(queried).toEqual({ postscriptNames: ['Foo-Regular'] });
    expect(result.length).toBe(bytes.length);
  });

  it('still throws a clear error when the font truly cannot be found', async () => {
    (globalThis as unknown as { window: unknown }).window = {
      queryLocalFonts: async () => [],
    };
    await expect(readLocalFontBytes('Nope-Regular')).rejects.toThrow(/Nope-Regular/);
  });
});
