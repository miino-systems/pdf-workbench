/**
 * Types for the `pdf/stamper` module's public API. Kept separate from
 * `@/core/types` because these are specific to this pure, FS-free module
 * (callers pass in `resolveFont`/`resolveImage` instead of a workspace).
 */
import type { FontRef, ResolvedFont, StampDefinition, StampInstance } from '@/core/types';

export interface StampJobInput {
  /** Raw bytes of the source PDF (never mutated). */
  sourceBytes: Uint8Array;
  /** All known stamp definitions (only ones referenced by an instance are used). */
  definitions: StampDefinition[];
  /** Stamp instances to apply; disabled ones are skipped. */
  instances: StampInstance[];
  /** Source file name/path, used for the `{file}` placeholder. */
  fileName?: string;
  /**
   * Document-level start of continuous numbering (e.g. this file's first
   * page number in a multi-document sequence). When set, every page-number
   * layer shows `pageNumberStart + (physicalPage - 1)` — independent of
   * which pages the stamp is applied to — and `PageNumberLayer.startAt`
   * is ignored.
   */
  pageNumberStart?: number;
  /** Resolves a font reference to bytes (or "standard, no bytes needed"). */
  resolveFont: (ref: FontRef) => Promise<ResolvedFont>;
  /** Resolves an `ImageLayer.src` (workspace-relative path) to PNG/JPEG bytes. */
  resolveImage: (src: string) => Promise<Uint8Array>;
}

export interface StampJobResult {
  /** The stamped PDF's bytes. */
  bytes: Uint8Array;
  pageCount: number;
  /** Pages each instance was actually applied to. */
  applied: { instanceId: string; pages: number[] }[];
  /** Distinct fonts embedded while producing `bytes`. */
  fonts: { ref: FontRef; sha256?: string }[];
  /** Non-fatal problems encountered (unsupported glyphs, unknown ids, ...). */
  warnings: string[];
}
