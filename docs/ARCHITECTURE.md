# PDF Workbench – Architecture

> ブラウザを UI として利用する **ローカル PDF 処理アプリケーション**。
> データの主体は常にユーザーのローカル Workspace。Web App はその Workspace を
> 読み書きする UI と処理エンジンに徹する。

## 1. 推奨 architecture

```
┌──────────────────────────────── Browser (Chromium) ────────────────────────────────┐
│                                                                                     │
│  UI (vanilla TS, src/ui)  ──── AppState (src/state) ────┐                           │
│     Workspace / PDF / Stamps / Preflight / History / Settings                        │
│                                                          │                           │
│  ┌───────────────┐  ┌──────────────┐  ┌───────────────┐  │  ┌──────────────────────┐ │
│  │ pdf/renderer  │  │ pdf/stamper  │  │ pdf/reader    │  │  │ workspace/           │ │
│  │ (PDF.js →     │  │ (pdf-lib +   │  │ (PDF.js       │  │  │  FileSystemAccess    │ │
│  │  canvas)      │  │  fontkit)    │  │  inspection)  │  │  │  .pdf-workbench/*.json│ │
│  └───────────────┘  └──────────────┘  └───────────────┘  │  │  IndexedDB (handles) │ │
│  ┌───────────────┐  ┌──────────────┐  ┌───────────────┐  │  └──────────────────────┘ │
│  │ pdf/converter │  │ stamps/      │  │ fonts/        │  │  ┌──────────────────────┐ │
│  │ (PNG/JPEG)    │  │ (model,      │  │ (local API,   │  │  │ history/             │ │
│  │               │  │  pages, pos) │  │  workspace,   │  │  │  events.jsonl        │ │
│  └───────────────┘  └──────────────┘  │  file, sha256)│  │  │  snapshots/          │ │
│  ┌───────────────┐  ┌──────────────┐  └───────────────┘  │  └──────────────────────┘ │
│  │ preflight/    │  │ git-helper/  │  ┌───────────────┐  │  ┌──────────────────────┐ │
│  │               │  │ (commands)   │  │ crypto/       │  │  │ localStorage         │ │
│  └───────────────┘  └──────────────┘  │ (Web Crypto)  │  │  │ (UI prefs only)      │ │
│                                       └───────────────┘  │  └──────────────────────┘ │
│                                                                                     │
│  ─── no network I/O after the static bundle is loaded ───                           │
└─────────────────────────────────────────────────────────────────────────────────────┘
```

原則:

| # | 原則 |
|---|------|
| A | source PDF (`papers/`) は絶対に上書きしない。出力は必ず `output/` の別ファイル |
| B | pdf-lib で **既存 page に drawText / drawImage** する。`embedPage`/`drawPage` や canvas 再構成は通常処理に使わない → hyperlink annotation を維持 |
| C | 設定・状態の正本は `.pdf-workbench/*.json`。localStorage は UI preference、IndexedDB は DirectoryHandle のみ |
| D | PDF / 画像 / フォント / レポートをネットワーク送信しない。ライブラリは全て bundle |
| E | Git remote 操作・認証を実装しない。コマンド生成とコピーのみ |
| F | 履歴は Git に依存しない。append-only `events.jsonl` を必ず持つ |
| G | 機能は module 化し、UI から独立してテストできる pure function を中心にする |

## 2. 主要 TypeScript interface

全て `src/core/types.ts` に集約。要点:

```ts
interface StampDefinition { id; name; layers: StampLayer[]; defaultPosition?; defaultPages? }
interface StampInstance   { id; stampId; enabled; pages: PageSelector; position?: StampPosition }
type StampLayer = TextLayer | ImageLayer | PageNumberLayer | FutureLayer   // line/rectangle/qrcode/dynamicText は予約
type PageSelector = all | first | last | range | list | odd | even
interface StampPosition { anchor: StampAnchor; offsetX: pt; offsetY: pt }  // UI では mm 表示可
type FontRef = standard | local (queryLocalFonts) | workspace (fonts/*.ttf) | file (user pick)   // + sha256
interface JobRecord { source; sourceHash: 'sha256:…'; output; stampInstances; fonts; status }
interface HistoryEvent { ts; type; prevHash?; hash?; …payload }
interface PreflightConfig / PreflightReport
```

## 3. Module API contracts

各 module は以下の public API を `index.ts` から export する。UI はこれのみに依存する。

### `crypto/`
```ts
sha256Hex(data: ArrayBuffer | Uint8Array): Promise<string>          // hex
sha256(data): Promise<string>                                       // 'sha256:<hex>'
sha256Text(text: string): Promise<string>
```
Web Crypto (`crypto.subtle`) を使用。Node (vitest) では `globalThis.crypto` を使う。

### `workspace/`
```ts
isFileSystemAccessSupported(): boolean
isLocalFontAccessSupported(): boolean
pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle>       // showDirectoryPicker({mode:'readwrite'})

class WorkspaceFS {                     // FileSystemDirectoryHandle wrapper (paths are workspace-relative POSIX)
  constructor(root: FileSystemDirectoryHandle)
  readonly name: string
  exists(path): Promise<boolean>
  readText(path): Promise<string>;  readBytes(path): Promise<Uint8Array>;  getFile(path): Promise<File>
  writeText(path, text): Promise<void>;  writeBytes(path, bytes): Promise<void>   // creates parent dirs
  appendText(path, text): Promise<void>                                          // for events.jsonl
  mkdirp(path): Promise<void>
  list(dirPath, opts?: { extensions?: string[]; recursive?: boolean }): Promise<WorkspaceFileEntry[]>
}

isWorkspaceInitialized(fs): Promise<boolean>                      // .pdf-workbench/workspace.json exists
initializeWorkspace(fs, opts?: { name? }): Promise<WorkspaceState>  // creates all files + dirs + .gitignore
loadWorkspace(fs): Promise<WorkspaceState>                          // reads the 4 json files (missing → defaults)
saveWorkspaceConfig / saveStampsConfig / savePreflightConfig / saveJobsConfig(fs, obj)

interface WorkspaceState { fs: WorkspaceFS; config: WorkspaceConfig; stamps: StampsConfig; preflight: PreflightConfig; jobs: JobsConfig }

// IndexedDB (idb-keyval): recent handles for reopening
rememberWorkspaceHandle(handle): Promise<void>
listRecentWorkspaces(): Promise<{ name; handle; lastOpened }[]>
forgetWorkspace(name): Promise<void>
ensurePermission(handle, mode: 'read' | 'readwrite'): Promise<boolean>  // queryPermission → requestPermission
```
デフォルト設定 (`createDefaultWorkspaceConfig`, `createDefaultStampsConfig`, `createDefaultPreflightConfig`, `createDefaultJobsConfig`, `DEFAULT_GITIGNORE`) は `workspace/defaults.ts`。

### `history/`
```ts
class HistoryJournal {
  constructor(fs: WorkspaceFS, opts?: { hashChain?: boolean })
  append(event: Omit<HistoryEvent,'ts'|'hash'|'prevHash'> & { ts?: string }): Promise<HistoryEvent>
  readAll(): Promise<HistoryEvent[]>
  verifyChain(): Promise<{ ok: boolean; brokenAt?: number }>
}
class SnapshotStore { save(snapshot: Omit<Snapshot,'ts'>): Promise<string /*path*/>; list(): Promise<string[]>; load(name) }
formatTs(date = new Date()): string      // ISO-8601 with local offset, e.g. 2026-09-14T10:30:12+09:00
snapshotFileName(date): string           // 20260914T103012.json
```
Hash chain: `hash = sha256(prevHash + canonicalJson(event without hash))`。`hashChain: false` (default) のときは prevHash/hash を付けない。

### `stamps/`
```ts
resolvePages(selector: PageSelector, pageCount: number): number[]                // 1-based, sorted, deduped
describePageSelector(selector): string
resolveStampOrigin(position: StampPosition, page: PageSize, box: { width; height }): { x; y }  // bottom-left of stamp box
effectivePosition(def, inst): StampPosition
renderPageNumber(template, ctx: { page; pages; file? }): string
createId(prefix?): string
BUILTIN_STAMP_TEMPLATES: StampDefinition[]   // DRAFT, Confidential, Page Number, CC BY 4.0 (image), Custom text
validateStampsConfig(cfg): string[]
```

### `fonts/`
```ts
listLocalFonts(): Promise<LocalFontInfo[]>                       // window.queryLocalFonts(); [] when unsupported
listWorkspaceFonts(fs, dir): Promise<WorkspaceFileEntry[]>       // fonts/*.ttf|otf
pickFontFile(): Promise<{ name; bytes }>                          // showOpenFilePicker / <input type=file> fallback
class FontResolver {
  constructor(ctx: { fs?: WorkspaceFS; fontsDir: string; pickedFiles?: Map<string, Uint8Array> })
  resolve(ref: FontRef): Promise<ResolvedFont>                    // computes sha256, sets hashMismatch
}
fontWarningMessage(resolved): string | undefined                  // '同名フォントですが，以前使用したフォントと内容が異なります'
```

### `pdf/stamper/`
pure: FS を触らない。
```ts
interface StampJobInput {
  sourceBytes: Uint8Array
  definitions: StampDefinition[]
  instances: StampInstance[]
  fileName?: string                                   // for {file}
  resolveFont: (ref: FontRef) => Promise<ResolvedFont>
  resolveImage: (src: string) => Promise<Uint8Array>  // workspace-relative path → PNG/JPEG bytes
}
interface StampJobResult { bytes: Uint8Array; pageCount: number; applied: { instanceId; pages: number[] }[]; fonts: { ref; sha256? }[]; warnings: string[] }
applyStamps(input: StampJobInput): Promise<StampJobResult>
measureStamp(def, ctx): Promise<{ width; height }>   // bounding box for preview / collision check
```
実装方針: `PDFDocument.load(bytes, { updateMetadata: false })` → `registerFontkit` → `embedFont(bytes, { subset: true })` → `page.drawText / drawImage` → `save({ useObjectStreams: false })`。ページの `/Annots` に触らない。

### `pdf/reader/`  (PDF.js)
```ts
loadPdfDocument(bytes): Promise<PDFDocumentProxy>
inspectPdf(bytes): Promise<PdfInfo>                     // page sizes, link annotation counts
getLinkAnnotations(doc, page): Promise<{ rect; url?; dest? }[]>
```

### `pdf/renderer/`  (PDF.js → canvas)
```ts
class PdfRenderer { constructor(bytes); load(); pageCount; getPageSize(n): PageSize; renderPage(n, canvas, { scale | dpi }): Promise<{ width; height; scale }>; destroy() }
```
Worker: `new Worker(new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url), { type: 'module' })` で bundle 内から読む (CDN 不使用)。

### `pdf/converter/`  (Phase 3, module only)
```ts
convertPdfToImages(bytes, { format: 'png'|'jpeg'; dpi: 150|300|600; pages?: number[]; quality? }): AsyncGenerator<{ page; blob; fileName }>
imageFileName(base, page, format): string     // paper_001.png
```

### `preflight/`
```ts
runPreflight(bytes, config: PreflightConfig, ctx: { file; sha256 }): Promise<PreflightReport>   // page size / orientation / count (Phase 2 basic)
checkMarginsByText(doc, page, margins)        // Phase 2/3 (object based)
checkMarginsByRaster(canvas, margins)         // Phase 3 stub
checkStampCollision(canvas, rect)             // Phase 2 raster based
reportFileName(file, date): string
```

### `git-helper/`
```ts
gitInitCommands(): string[]; gitUpdateCommands(): string[]; DEFAULT_GITIGNORE: string; explainGitignore(): string
```

## 4. Workspace file format

```
workspace/
├─ papers/        immutable source PDFs
├─ output/        generated PDFs  (<name><suffix>.pdf)
├─ preview/       PNG/JPEG
├─ assets/        stamp images
├─ fonts/         .ttf/.otf
├─ .pdf-workbench/
│   ├─ workspace.json        WorkspaceConfig
│   ├─ stamps.json           StampsConfig  { definitions[], instances[] }
│   ├─ preflight.json        PreflightConfig
│   ├─ jobs.json             JobsConfig    { jobs[] }
│   ├─ reports/              PreflightReport JSON
│   └─ history/
│       ├─ events.jsonl      HistoryEvent per line (append-only)
│       └─ snapshots/        <YYYYMMDDTHHMMSS>.json  Snapshot
└─ .gitignore
```

各 JSON は `version` フィールドを持つ。画像・フォント本体は JSON に埋め込まず、workspace 相対パスで参照する。

## 5. Phase 1 実装計画

| Step | 内容 | module |
|------|------|--------|
| 1 | Vite + TS project | root |
| 2–4 | directory 選択 / 初期化 / JSON 読み書き / IndexedDB 再オープン | workspace |
| 5 | `papers/*.pdf` 一覧 + ジョブ状態 (Processed / Warning / Not processed / Source changed) | workspace, state |
| 6 | PDF.js preview (page 切替, zoom, stamp 位置 overlay) | pdf/renderer, ui |
| 7–10 | text / image / pageNumber stamp, 複数同時適用 | pdf/stamper, stamps, fonts |
| 11 | `output/<name>_stamped.pdf` へ保存。source は読み取りのみ | workspace |
| 12 | hyperlink 維持テスト (pdf-lib で link 付き PDF を生成 → stamp → annotation 数一致) | tests |
| 13 | events.jsonl | history |
| 14 | source SHA-256 → jobs.json、変更検知 | crypto, state |
| 15 | Git command copy UI | git-helper, ui |

Phase 2 以降 (Local Font Access, workspace font, font sha256, snapshot, basic preflight, collision) は module 境界を今の段階で用意し、可能なものは同時に実装する。
