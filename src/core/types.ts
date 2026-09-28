/**
 * Core domain types shared by every module.
 *
 * Design rules:
 *  - All lengths are PDF points (pt) unless a field is explicitly named otherwise.
 *  - Everything here must be plain JSON-serialisable data: these shapes are
 *    persisted verbatim into `.pdf-workbench/*.json` (the workspace is the
 *    source of truth, not localStorage / IndexedDB).
 *  - Paths stored in config are always workspace-relative, POSIX style
 *    (e.g. `assets/cc-by.png`, `papers/paper001.pdf`).
 */

// ---------------------------------------------------------------------------
// Workspace
// ---------------------------------------------------------------------------

/** Format version of the on-disk workspace. Bump on breaking changes. */
export const WORKSPACE_FORMAT_VERSION = 1;

/** Name of the metadata directory inside a workspace. */
export const WORKBENCH_DIR = '.pdf-workbench';

/** Files inside `.pdf-workbench/`. */
export const WORKBENCH_FILES = {
  workspace: `${WORKBENCH_DIR}/workspace.json`,
  stamps: `${WORKBENCH_DIR}/stamps.json`,
  preflight: `${WORKBENCH_DIR}/preflight.json`,
  jobs: `${WORKBENCH_DIR}/jobs.json`,
  sequence: `${WORKBENCH_DIR}/sequence.json`,
  events: `${WORKBENCH_DIR}/history/events.jsonl`,
  reportsDir: `${WORKBENCH_DIR}/reports`,
  historyDir: `${WORKBENCH_DIR}/history`,
  snapshotsDir: `${WORKBENCH_DIR}/history/snapshots`,
} as const;

export interface WorkspaceDirectories {
  /** Immutable source PDFs. Never written by the app. */
  papers: string;
  /** Generated PDFs. */
  output: string;
  /** PNG/JPEG previews and conversions. */
  preview: string;
  /** Stamp images (logos, CC badges, ...). */
  assets: string;
  /** Workspace fonts (.ttf/.otf). */
  fonts: string;
  /** Annotated review copies of PDFs that failed the batch preflight, plus its summary (default `preflight`). */
  preflight?: string;
}

export const DEFAULT_DIRECTORIES: WorkspaceDirectories = {
  papers: 'papers',
  output: 'output',
  preview: 'preview',
  assets: 'assets',
  fonts: 'fonts',
};

/** `.pdf-workbench/workspace.json` */
export interface WorkspaceConfig {
  version: number;
  /** Human readable workspace name (defaults to directory name). */
  name: string;
  createdAt: string; // ISO-8601
  directories: WorkspaceDirectories;
  output: {
    /** Suffix inserted before `.pdf`, e.g. `_stamped` -> `paper_stamped.pdf`. */
    suffix: string;
  };
  history: {
    /** When true, every appended event carries prevHash/hash (Phase 3). */
    hashChain: boolean;
  };
}

// ---------------------------------------------------------------------------
// Geometry / placement
// ---------------------------------------------------------------------------

export type StampAnchor =
  | 'top-left'
  | 'top-center'
  | 'top-right'
  | 'middle-left'
  | 'middle-center'
  | 'middle-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'bottom-right';

export const STAMP_ANCHORS: readonly StampAnchor[] = [
  'top-left',
  'top-center',
  'top-right',
  'middle-left',
  'middle-center',
  'middle-right',
  'bottom-left',
  'bottom-center',
  'bottom-right',
];

/**
 * Position of a stamp on a page. `offsetX`/`offsetY` are in points and are
 * applied *inward* from the anchor edge (positive offsetY on a bottom anchor
 * moves the stamp up; positive offsetY on a top anchor moves it down).
 * The UI may display/edit these in mm (see core/units.ts).
 */
export interface StampPosition {
  anchor: StampAnchor;
  offsetX: number;
  offsetY: number;
}

/** Axis-aligned rectangle in PDF user space (origin bottom-left). */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PageSize {
  width: number;
  height: number;
}

// ---------------------------------------------------------------------------
// Page selection
// ---------------------------------------------------------------------------

/**
 * Which pages a stamp instance applies to. Page numbers are 1-based.
 * `odd` / `even` are already modelled so the UI can expose them later.
 */
export type PageSelector =
  | { kind: 'all' }
  | { kind: 'first' }
  | { kind: 'last' }
  | { kind: 'range'; from: number; to: number }
  | { kind: 'list'; pages: number[] }
  | { kind: 'odd' }
  | { kind: 'even' };

// ---------------------------------------------------------------------------
// Fonts
// ---------------------------------------------------------------------------

/** pdf-lib built-in (non-embedded) fonts. WinAnsi only: no CJK. */
export type StandardFontName =
  | 'Helvetica'
  | 'Helvetica-Bold'
  | 'Helvetica-Oblique'
  | 'Times-Roman'
  | 'Times-Bold'
  | 'Times-Italic'
  | 'Courier'
  | 'Courier-Bold';

/**
 * Reference to a font, persisted in stamps.json.
 * The optional `sha256` records the font file that was last used so that a
 * same-named font with different bytes can be detected (spec §15).
 */
export type FontRef =
  | { kind: 'standard'; name: StandardFontName }
  | {
      kind: 'local'; // Local Font Access API (window.queryLocalFonts)
      family: string;
      postscriptName: string;
      fullName?: string;
      style?: string;
      sha256?: string;
    }
  | {
      kind: 'workspace'; // fonts/<file> inside the workspace
      path: string;
      family?: string;
      sha256?: string;
    }
  | {
      kind: 'file'; // user-picked font file (bytes held in memory only)
      name: string;
      family?: string;
      sha256?: string;
    };

/** A font that has been resolved to bytes (or to a standard font). */
export interface ResolvedFont {
  ref: FontRef;
  /** Undefined for `standard` fonts. */
  bytes?: Uint8Array;
  /** `sha256:<hex>` of `bytes`; undefined for standard fonts. */
  sha256?: string;
  /** True when ref.sha256 was set and differs from the resolved bytes. */
  hashMismatch: boolean;
}

// ---------------------------------------------------------------------------
// Stamps
// ---------------------------------------------------------------------------

export interface StampLayerBase {
  id: string;
  /**
   * Offset of this layer relative to the stamp origin (pt, x right / y up).
   * With a definition `layout`, an extra nudge on top of the automatic
   * placement.
   */
  dx?: number;
  dy?: number;
  /** 0..1 */
  opacity?: number;
  /** Degrees, counter-clockwise. */
  rotate?: number;
}

/** Horizontal alignment of the lines of a multi-line text block. */
export type TextAlign = 'left' | 'center' | 'right';

/** Options shared by the text-drawing layers (`text`, `pageNumber`). */
export interface TextBlockOptions {
  /** Line alignment within the block (the block is as wide as its longest line). Default `left`. */
  align?: TextAlign;
  /** Distance between baselines as a multiple of `size`. Default 1.2. */
  lineHeight?: number;
}

export interface TextLayer extends StampLayerBase, TextBlockOptions {
  type: 'text';
  /** `\n` starts a new line. */
  text: string;
  font: FontRef;
  /** Font size in pt. */
  size: number;
  /** CSS hex colour, e.g. `#000000`. */
  color: string;
}

export interface ImageLayer extends StampLayerBase {
  type: 'image';
  /** Workspace-relative path, e.g. `assets/cc-by.png` (PNG or JPEG). */
  src: string;
  /** Target width in pt. If only one of width/height is given, aspect ratio is kept. */
  width?: number;
  height?: number;
}

/**
 * Page-number layer. `template` supports `{page}`, `{pages}`, `{file}`.
 * Examples: `{page}`, `{page} / {pages}`, `Page {page} of {pages}`.
 */
export interface PageNumberLayer extends StampLayerBase, TextBlockOptions {
  type: 'pageNumber';
  template: string;
  font: FontRef;
  size: number;
  color: string;
  /**
   * Number shown on the first *selected* page (default 1). Ignored when the
   * file is numbered by the workspace sequence (`sequence.json`), which
   * supplies a document-level start instead.
   */
  startAt?: number;
  /** When set, `{pages}` shows this instead of the document page count. */
  totalPagesOverride?: number;
}

/** Reserved for future layer kinds (line, rectangle, qrcode, dynamicText). */
export interface FutureLayer extends StampLayerBase {
  type: 'line' | 'rectangle' | 'qrcode' | 'dynamicText';
  [key: string]: unknown;
}

export type StampLayer = TextLayer | ImageLayer | PageNumberLayer | FutureLayer;

export type ImplementedLayerType = 'text' | 'image' | 'pageNumber';
export const IMPLEMENTED_LAYER_TYPES: readonly ImplementedLayerType[] = ['text', 'image', 'pageNumber'];

/**
 * Automatic placement of a stamp's layers. Without it every layer sits at
 * the stamp origin shifted by its own dx/dy (layers overlap). With it the
 * layers are laid out one after another, in `layers` order:
 *  - `row`: left to right (e.g. a logo left of a text block),
 *  - `column`: top to bottom,
 * `gap` pt apart, aligned across the other axis by `align` (`start` = top
 * for a row / left for a column, `end` = bottom / right). Each layer's
 * dx/dy is then an extra nudge.
 */
export interface StampLayout {
  direction: 'row' | 'column';
  gap?: number;
  align?: 'start' | 'center' | 'end';
}

export interface StampDefinition {
  id: string;
  name: string;
  description?: string;
  layers: StampLayer[];
  layout?: StampLayout;
  defaultPosition?: StampPosition;
  defaultPages?: PageSelector;
}

export interface StampInstance {
  id: string;
  stampId: string;
  enabled: boolean;
  pages: PageSelector;
  /** Overrides `StampDefinition.defaultPosition`. */
  position?: StampPosition;
}

/** `.pdf-workbench/stamps.json` */
export interface StampsConfig {
  version: number;
  definitions: StampDefinition[];
  instances: StampInstance[];
}

// ---------------------------------------------------------------------------
// Sequence (continuous page numbering across source PDFs)
// ---------------------------------------------------------------------------

/**
 * How the source PDFs are ordered for continuous numbering.
 *  - `name`:   natural sort by file name (`paper2.pdf` < `paper10.pdf`);
 *              `entries` only carry per-file overrides (startPage / skip).
 *  - `manual`: the order of `entries`; files not listed are appended after
 *              them in name order so a newly added PDF is never silently
 *              dropped from the numbering.
 */
export type SequenceOrder = 'name' | 'manual';

/**
 * Alignment rule for the first page of every file: `odd` makes each file
 * start on a recto (odd) page, as is customary for printed proceedings,
 * by skipping a number where necessary. An explicit `startPage` pin is
 * always respected as-is.
 */
export type SequenceStartOn = 'any' | 'odd' | 'even';

export interface SequenceEntry {
  /** Workspace-relative source path, e.g. `papers/paper001.pdf`. */
  file: string;
  /**
   * Pin this file's first page number. Numbering continues from here for
   * the files that follow (use it for gaps, restarts or externally
   * numbered material).
   */
  startPage?: number;
  /** Exclude the file from the continuous numbering (its page-number stamps fall back to `PageNumberLayer.startAt`). */
  skip?: boolean;
  /**
   * Name of the stamped output file (inside the output directory), e.g.
   * `NOLTA2026-A1-01.pdf`, overriding `<name><suffix>.pdf`. `.pdf` is
   * appended when missing; sub-directories are allowed, `..` is not.
   */
  output?: string;
}

/**
 * Where the current `order` / `entries` came from, kept for audit purposes
 * only (never read by the numbering logic itself).
 *  - `import`: read from a dropped CSV/JSON file (`source` / `format`).
 *  - `manual`: built up by hand in the Sequence tab (moves, pins, ...) with
 *    no file import behind it.
 *  - `name`: explicitly reset to natural name order ("ファイル名順に戻す").
 *
 * A manual edit that follows an import (e.g. nudging one row after dropping
 * a CSV) does not overwrite `kind`/`source`/`format` — it only stamps
 * `editedAt`, so the tab can show both "came from rename_map.csv" and
 * "edited afterwards".
 */
export interface SequenceOrigin {
  kind: 'import' | 'manual' | 'name';
  /** Name of the dropped file, e.g. `rename_map.csv`. */
  source?: string;
  format?: 'csv' | 'json';
  /** ISO-8601 with offset, set when `kind` is `import`. */
  importedAt?: string;
  /** ISO-8601 with offset of the most recent manual edit made after import. */
  editedAt?: string;
  /**
   * Name of the column the source rows were ordered by, when the header
   * suggests one (e.g. `Session Code`, `time`); `'file order'` when the
   * file has no such column and its row order was simply taken as-is.
   */
  sortKey?: string;
  /** Number of entries the import produced (excluding a skipped header row). */
  rows?: number;
}

/** `.pdf-workbench/sequence.json` */
export interface SequenceConfig {
  version: number;
  order: SequenceOrder;
  /** Page number of the first page of the first numbered file (default 1). */
  firstPage: number;
  startOn: SequenceStartOn;
  entries: SequenceEntry[];
  /** Where this order came from (import / manual edit / name order). Advisory only. */
  origin?: SequenceOrigin;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export type PreflightSeverity = 'ok' | 'warning' | 'error';

export interface PreflightMargins {
  top: number;
  bottom: number;
  left: number;
  right: number;
  unit: 'mm' | 'pt' | 'in';
}

/**
 * Per-page override of some margin sides, e.g. a wider top margin on the
 * title page only. `pages` selects which pages it applies to (same
 * `PageSelector` used for stamp placement); `margins` only needs to name the
 * sides being overridden — `unit` and any side left out fall back to
 * `PreflightConfig.margins`. When several overrides match the same page, the
 * later entry in `marginOverrides` wins per side.
 *
 * Example (first page only, top margin 35mm — the rest inherited):
 * ```json
 * { "pages": { "kind": "first" }, "margins": { "top": 35 } }
 * ```
 */
export interface PreflightMarginOverride {
  pages: PageSelector;
  margins: Partial<Pick<PreflightMargins, 'top' | 'bottom' | 'left' | 'right'>>;
}

/** `.pdf-workbench/preflight.json` */
export interface PreflightConfig {
  version: number;
  id: string;
  name?: string;
  /**
   * Id of the built-in preset (`preflight/presets.ts` `PREFLIGHT_PRESETS`)
   * this config was last applied from, e.g. `'ieee-conference'`. Purely
   * informational (shown in the UI as "適用元"); editing the config after
   * applying a preset does not clear it, so treat it as a starting-point
   * label rather than a guarantee the values still match that preset.
   */
  preset?: string;
  page?: {
    /** e.g. `A4`, `Letter`; see core/units.ts PAPER_SIZES_PT. */
    size?: string;
    orientation?: 'portrait' | 'landscape';
    /** Tolerance in pt when comparing page size (default 2). */
    tolerance?: number;
  };
  margins?: PreflightMargins;
  /** Per-page margin overrides (e.g. a wider first-page top margin). See `PreflightMarginOverride`. */
  marginOverrides?: PreflightMarginOverride[];
  pages?: { min?: number; max?: number };
  checks?: {
    /** Object-based (getTextContent) margin check. */
    marginText?: boolean;
    /** Raster-based margin check (Phase 3). */
    marginRaster?: boolean;
    /** Raster-based stamp collision check (Phase 2). */
    stampCollision?: boolean;
  };
}

export type PreflightWarningCode =
  | 'PAGE_SIZE'
  | 'PAGE_ORIENTATION'
  | 'PAGE_COUNT_MIN'
  | 'PAGE_COUNT_MAX'
  | 'TOP_MARGIN'
  | 'BOTTOM_MARGIN'
  | 'LEFT_MARGIN'
  | 'RIGHT_MARGIN'
  | 'STAMP_COLLISION'
  | string;

/**
 * Where a preflight problem is on the page, for annotating a review copy.
 * `rect` is in the page's visible frame (as displayed, `/Rotate` applied),
 * pt, origin bottom-left.
 */
export interface PreflightFinding {
  code: PreflightWarningCode;
  /** Which check found it. */
  source: 'text' | 'raster' | 'page' | 'stamp';
  rect?: Rect;
  /** The offending text run (text check) or stamp name (stamp check). */
  text?: string;
}

export interface PreflightPageResult {
  page: number; // 1-based
  warnings: PreflightWarningCode[];
  errors?: PreflightWarningCode[];
  details?: Record<string, unknown>;
  /** Located problems on this page (capped per page), used to annotate a review copy. */
  findings?: PreflightFinding[];
}

/** Saved into `.pdf-workbench/reports/<file>.<timestamp>.json` */
export interface PreflightReport {
  file: string; // workspace-relative source path
  sha256: string; // `sha256:<hex>`
  configId: string;
  ranAt: string; // ISO-8601
  result: PreflightSeverity;
  pageCount: number;
  documentWarnings: PreflightWarningCode[];
  pages: PreflightPageResult[];
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

export type JobStatus = 'processed' | 'warning' | 'error';

export interface JobRecord {
  id: string;
  /** Workspace-relative source path, e.g. `papers/paper001.pdf`. */
  source: string;
  /** `sha256:<hex>` of the source at processing time. */
  sourceHash: string;
  /** Workspace-relative output path. */
  output: string;
  outputHash?: string;
  /** StampInstance ids that were applied. */
  stampInstances: string[];
  /**
   * `stampsFingerprint` of stamps.json at generation time; when the current
   * stamps no longer match, the output is shown as stale.
   */
  stampsHash?: string;
  /** Fonts actually embedded (for reproducibility warnings). */
  fonts?: { ref: FontRef; sha256?: string }[];
  /**
   * Continuous page numbers this output was generated with (from
   * `sequence.json`). Absent when the file was not part of the numbering
   * (skipped, or generated before the sequence existed); a later change
   * of the sequence is then not reported for it.
   */
  pageStart?: number;
  pageEnd?: number;
  createdAt: string;
  status: JobStatus;
  message?: string;
}

/** `.pdf-workbench/jobs.json` */
export interface JobsConfig {
  version: number;
  jobs: JobRecord[];
}

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

/** One line in `.pdf-workbench/history/events.jsonl` (append-only). */
export interface HistoryEvent {
  ts: string; // ISO-8601 with offset
  type: string; // e.g. `workspace.opened`, `stamp.enabled`, `pdf.generated`
  /** Hash chain (optional, Phase 3). `sha256:<hex>`. */
  prevHash?: string;
  hash?: string;
  [key: string]: unknown;
}

export interface Snapshot {
  ts: string;
  reason: string;
  workspace: WorkspaceConfig;
  stamps: StampsConfig;
  preflight: PreflightConfig;
  jobs: JobsConfig;
  /** Absent in snapshots taken before continuous numbering existed. */
  sequence?: SequenceConfig;
}

// ---------------------------------------------------------------------------
// PDF inspection (PDF.js side)
// ---------------------------------------------------------------------------

export interface PdfPageInfo {
  page: number; // 1-based
  width: number; // pt (rotation applied)
  height: number;
  rotation: number;
  /** Number of link annotations on the page. */
  linkCount: number;
}

export interface PdfInfo {
  pageCount: number;
  pages: PdfPageInfo[];
  title?: string;
  /** Total link annotations across the document. */
  linkCount: number;
}

// ---------------------------------------------------------------------------
// Workspace file entry (for listings)
// ---------------------------------------------------------------------------

export interface WorkspaceFileEntry {
  /** Workspace-relative path. */
  path: string;
  name: string;
  size: number;
  lastModified: number;
}
