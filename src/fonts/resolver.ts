/**
 * Resolves a `FontRef` (as stored in `stamps.json`) to actual bytes (or to
 * "no bytes needed" for standard fonts), detecting when a previously-used
 * font's content has changed under the same name/path.
 *
 * Takes plain functions for reading workspace/picked-file bytes instead of
 * importing `WorkspaceFS`, so this module stays independent from the
 * `workspace/` module (developed in parallel).
 */
import type { FontRef, ResolvedFont } from '@/core/types';
import { sha256 } from './hash';
import { readLocalFontBytes } from './local';

export interface FontResolverContext {
  /** Reads `fonts/<file>` (or any workspace-relative path) as bytes. */
  readWorkspaceFile?: (path: string) => Promise<Uint8Array>;
  /** In-memory bytes for `FontRef.kind === 'file'`, keyed by `ref.name`. */
  pickedFiles?: Map<string, Uint8Array>;
}

/** Resolves `FontRef`s to bytes, caching per (kind, key) for its lifetime. */
export class FontResolver {
  private readonly readWorkspaceFile?: (path: string) => Promise<Uint8Array>;
  private readonly pickedFiles?: Map<string, Uint8Array>;
  private readonly cache = new Map<string, Promise<ResolvedFont>>();

  constructor(ctx: FontResolverContext = {}) {
    this.readWorkspaceFile = ctx.readWorkspaceFile;
    this.pickedFiles = ctx.pickedFiles;
  }

  /** Resolve `ref` to bytes (if any) and detect a content-hash mismatch. */
  async resolve(ref: FontRef): Promise<ResolvedFont> {
    const key = resolverCacheKey(ref);
    const cached = this.cache.get(key);
    if (cached) return cached;

    const promise = this.doResolve(ref);
    this.cache.set(key, promise);
    // Don't poison the cache with a rejected lookup - let callers retry.
    promise.catch(() => this.cache.delete(key));
    return promise;
  }

  private async doResolve(ref: FontRef): Promise<ResolvedFont> {
    if (ref.kind === 'standard') {
      return { ref, hashMismatch: false };
    }

    const bytes = await this.readBytes(ref);
    const digest = await sha256(bytes);
    const hashMismatch = !!ref.sha256 && ref.sha256 !== digest;
    return { ref, bytes, sha256: digest, hashMismatch };
  }

  private async readBytes(ref: Exclude<FontRef, { kind: 'standard' }>): Promise<Uint8Array> {
    switch (ref.kind) {
      case 'local':
        return readLocalFontBytes(ref.postscriptName);
      case 'workspace':
        if (!this.readWorkspaceFile) {
          throw new Error(
            `Cannot resolve workspace font "${ref.path}": no workspace file reader was configured`,
          );
        }
        return this.readWorkspaceFile(ref.path);
      case 'file': {
        const bytes = this.pickedFiles?.get(ref.name);
        if (!bytes) {
          throw new Error(`Font file "${ref.name}" is not loaded; please pick it again`);
        }
        return bytes;
      }
    }
  }
}

function resolverCacheKey(ref: FontRef): string {
  switch (ref.kind) {
    case 'standard':
      return `standard:${ref.name}`;
    case 'local':
      return `local:${ref.postscriptName}`;
    case 'workspace':
      return `workspace:${ref.path}`;
    case 'file':
      return `file:${ref.name}`;
  }
}

/** Copy of `ref` with `sha256` filled in from a resolved font, for saving. */
export function withHash(ref: FontRef, resolved: ResolvedFont): FontRef {
  if (ref.kind === 'standard' || !resolved.sha256) return ref;
  return { ...ref, sha256: resolved.sha256 };
}

/**
 * Japanese warning shown when a font resolved to bytes different from the
 * ones last recorded under the same name/path, or `undefined` when fine.
 */
export function fontWarningMessage(resolved: ResolvedFont): string | undefined {
  return resolved.hashMismatch
    ? '同名フォントですが，以前使用したフォントと内容が異なります'
    : undefined;
}
