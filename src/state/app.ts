/**
 * Application state + controller. This is the single integration point
 * between the UI and the domain modules. All mutations of the workspace go
 * through here so that:
 *   - `.pdf-workbench/*.json` stays the source of truth (saved on every change)
 *   - every meaningful action is appended to `events.jsonl`
 */
import type {
  JobRecord,
  JobsConfig,
  PageSelector,
  PreflightConfig,
  PreflightReport,
  SequenceConfig,
  StampDefinition,
  StampInstance,
  StampPosition,
  StampsConfig,
  WorkspaceConfig,
  WorkspaceFileEntry,
} from '@/core/types';
import { WORKBENCH_FILES } from '@/core/types';
import { sha256 } from '@/crypto';
import {
  WorkspaceFS,
  ensurePermission,
  forgetWorkspace,
  hasPermission,
  initializeWorkspace,
  isFileSystemAccessSupported,
  isWorkspaceInitialized,
  listRecentWorkspaces,
  loadWorkspace,
  outputPathFor,
  pickWorkspaceDirectory,
  rememberWorkspaceHandle,
  saveJobsConfig,
  savePreflightConfig,
  saveSequenceConfig,
  saveStampsConfig,
  saveWorkspaceConfig,
  stripSchemaKey,
  type RecentWorkspace,
  type WorkspaceState,
} from '@/workspace';
import { EVENT_TYPES, HistoryJournal, SnapshotStore } from '@/history';
import { countPdfPages } from '@/pdf/reader';
import { effectivePosition, stampsFingerprint } from '@/stamps';
import { resolveSequence, sequenceItemFor, type ResolvedSequence, type SequenceFileInfo } from '@/sequence';
import type { HistoryEvent } from '@/core/types';
import { normalizeSequenceConfig } from '@/sequence/normalize';
import { Store } from './store';
import { loadPrefs, savePrefs, type UiPrefs } from './prefs';
import { UndoStack, changedKinds, stampEditLabel, type ConfigSnapshot } from './undo';

export type FileStatus =
  | 'not-processed'
  | 'processed'
  | 'warning'
  | 'error'
  | 'source-changed'
  | 'numbering-changed'
  | 'stamps-changed'
  | 'output-changed';

/**
 * Generated before, but something it depends on has changed since (source
 * PDF, page numbering, stamps, output name): the output is stale and should
 * be regenerated.
 */
export const NEEDS_UPDATE_STATUSES: ReadonlySet<FileStatus> = new Set<FileStatus>([
  'source-changed',
  'numbering-changed',
  'stamps-changed',
  'output-changed',
]);

/** Generated and still up to date (possibly with warnings). */
export function isUpToDate(status: FileStatus): boolean {
  return status === 'processed' || status === 'warning';
}

export interface PdfFileItem extends WorkspaceFileEntry {
  status: FileStatus;
  /** Latest job for this source, if any. */
  job?: JobRecord;
  /** Current sha256 when it has been computed (lazy). */
  sha256?: string;
}

export interface Toast {
  id: number;
  kind: 'info' | 'ok' | 'warn' | 'err';
  text: string;
}

export interface AppState {
  prefs: UiPrefs;
  fsSupported: boolean;
  workspace?: WorkspaceState;
  workspaceHandle?: FileSystemDirectoryHandle;
  /** Directory picked but `.pdf-workbench/` missing: offer initialisation. */
  pendingInit?: { handle: FileSystemDirectoryHandle; fs: WorkspaceFS };
  recent: RecentWorkspace[];
  files: PdfFileItem[];
  selectedFile?: string;
  /** Bytes of the selected source PDF (read-only, in memory). */
  selectedBytes?: Uint8Array;
  selectedSha256?: string;
  currentPage: number;
  pageCount: number;
  busy?: string;
  /** Progress of a long batch (shown as n/N and %), while it runs. */
  progress?: { label: string; done: number; total: number };
  toasts: Toast[];
  /** Recently loaded events (for the History tab). */
  events: HistoryEvent[];
  lastReport?: PreflightReport;
  /**
   * Continuous page numbering of `files` per `sequence.json`, refreshed by
   * `refreshSequence()` (page counts are read lazily and cached per file).
   */
  sequence?: ResolvedSequence;
  /** Labels of the next undo / redo step (undefined when there is none). */
  undo: { undo?: string; redo?: string };
}

type LoadMode = 'opened' | 'initialized' | 'reloaded';

/** The `.pdf-workbench/*.json` files the app reads and writes, by `WorkspaceState` key. */
type ConfigFile = 'config' | 'stamps' | 'sequence' | 'preflight' | 'jobs';

const CONFIG_FILES: Record<ConfigFile, string> = {
  config: WORKBENCH_FILES.workspace,
  stamps: WORKBENCH_FILES.stamps,
  sequence: WORKBENCH_FILES.sequence,
  preflight: WORKBENCH_FILES.preflight,
  jobs: WORKBENCH_FILES.jobs,
};

function fileLabel(kind: ConfigFile): string {
  return CONFIG_FILES[kind].split('/').pop() ?? kind;
}

/** Context handed to an `updateStamps` mutation. */
export interface StampsMutationContext {
  /**
   * stamps.json had been changed outside the app since it was last read, and
   * `cfg` is the on-disk version. `previous` is the in-memory version the UI
   * was showing, so an edit built from it can tell whether the part it
   * replaces was changed externally (and return `false` to cancel).
   */
  external: boolean;
  previous: StampsConfig;
}

let toastSeq = 0;

export class AppController {
  readonly store: Store<AppState>;
  journal?: HistoryJournal;
  snapshots?: SnapshotStore;
  /**
   * Bumped every time the active workspace changes (opened/closed/switched).
   * Async work started against one workspace (e.g. `hashFile`) captures the
   * epoch at the start and checks it before committing state, so results
   * that resolve after the workspace has since changed are dropped instead
   * of corrupting the new workspace's file list.
   */
  private wsEpoch = 0;
  /** Bumped on every `selectFile` call so an earlier, still in-flight call doesn't clobber a later one. */
  private selectSeq = 0;
  /** Bumped on every `refreshSequence` call so a slower, earlier resolution doesn't overwrite a newer one. */
  private sequenceSeq = 0;
  /** Page counts of source PDFs, keyed by path and invalidated by size/mtime (reset when the workspace changes). */
  private pageCountCache = new Map<string, { size: number; lastModified: number; pageCount?: number }>();
  /** Undo/redo of config edits in the current workspace (cleared whenever it is (re)loaded or closed). */
  private undoStack = new UndoStack();
  /**
   * Exact text of each config file as this session last read or wrote it.
   * A different text on disk means someone edited the file outside the app:
   * it is read back instead of being overwritten with stale in-memory data.
   */
  private diskText = new Map<ConfigFile, string>();
  /** Unparseable external versions already reported (so the periodic check doesn't repeat the toast). */
  private reportedBadText = new Map<ConfigFile, string>();
  /** Serialises config reads/writes so the external-change check never sees a half-finished own save. */
  private io: Promise<unknown> = Promise.resolve();

  constructor() {
    this.store = new Store<AppState>({
      prefs: loadPrefs(),
      fsSupported: isFileSystemAccessSupported(),
      recent: [],
      files: [],
      currentPage: 1,
      pageCount: 0,
      toasts: [],
      events: [],
      undo: {},
    });
  }

  get state(): AppState {
    return this.store.get();
  }

  // ---------------------------------------------------------------- prefs

  setPrefs(patch: Partial<UiPrefs>): void {
    const prefs = { ...this.state.prefs, ...patch };
    savePrefs(prefs);
    this.store.set({ prefs });
  }

  // ---------------------------------------------------------------- toasts

  toast(kind: Toast['kind'], text: string, ttlMs = 6000): void {
    const t: Toast = { id: ++toastSeq, kind, text };
    this.store.set((s) => ({ toasts: [...s.toasts, t] }));
    setTimeout(() => this.dismissToast(t.id), ttlMs);
  }

  dismissToast(id: number): void {
    this.store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  }

  /** Report batch progress (undefined to clear). */
  setProgress(progress: AppState['progress']): void {
    this.store.set({ progress });
  }

  /** Run an async task with a busy indicator and error toast. */
  async run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    this.store.set({ busy: label });
    try {
      return await fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(label, e);
      this.toast('err', `${label}: ${msg}`);
      return undefined;
    } finally {
      this.store.set({ busy: undefined });
    }
  }

  // ------------------------------------------------------------ workspace

  async refreshRecent(): Promise<void> {
    const recent = await listRecentWorkspaces().catch(() => []);
    this.store.set({ recent });
  }

  async pickAndOpenWorkspace(): Promise<void> {
    if (!this.state.fsSupported) {
      this.toast('warn', 'このブラウザではローカルディレクトリ機能が利用できません（Chrome / Edge をご利用ください）');
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await pickWorkspaceDirectory();
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      throw e;
    }
    await this.openHandle(handle);
  }

  async openRecent(entry: RecentWorkspace): Promise<void> {
    const ok = await ensurePermission(entry.handle, 'readwrite');
    if (!ok) {
      this.toast('warn', `「${entry.name}」への書き込み権限が許可されませんでした`);
      return;
    }
    await this.openHandle(entry.handle);
  }

  async forgetRecent(name: string): Promise<void> {
    await forgetWorkspace(name);
    await this.refreshRecent();
  }

  async openHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    await this.run('Workspace を開く', async () => {
      const fs = new WorkspaceFS(handle);
      if (!(await isWorkspaceInitialized(fs))) {
        this.store.set({ pendingInit: { handle, fs }, workspace: undefined, files: [], selectedFile: undefined });
        return;
      }
      await this.loadInto(handle, fs, 'opened');
    });
  }

  async initializePendingWorkspace(): Promise<void> {
    const pending = this.state.pendingInit;
    if (!pending) return;
    await this.run('Workspace を初期化', async () => {
      const state = await initializeWorkspace(pending.fs, { name: pending.handle.name });
      // Seed built-in stamp templates so a fresh workspace is immediately usable.
      const { BUILTIN_STAMP_TEMPLATES, createInstanceFromDefinition } = await import('@/stamps');
      state.stamps.definitions = BUILTIN_STAMP_TEMPLATES.map((d) => structuredClone(d));
      state.stamps.instances = state.stamps.definitions.map((d) => ({
        ...createInstanceFromDefinition(d),
        enabled: false,
      }));
      await saveStampsConfig(state.fs, state.stamps);
      this.store.set({ pendingInit: undefined });
      await this.loadInto(pending.handle, pending.fs, 'initialized');
    });
  }

  /**
   * Re-read the open workspace from disk (Cmd+R / the header's 更新 button): picks up files and
   * `.pdf-workbench/*.json` edited outside the app, keeping the selected PDF
   * and page. With no workspace open, reopens the most recently used one.
   */
  async reloadWorkspace(): Promise<void> {
    const { workspace, workspaceHandle, selectedFile, currentPage } = this.state;
    if (workspace && workspaceHandle) {
      await this.run('Workspace を再読み込み', () => this.loadInto(workspaceHandle, new WorkspaceFS(workspaceHandle), 'reloaded'));
      if (this.state.workspaceHandle !== workspaceHandle) return;
      if (selectedFile && this.state.files.some((f) => f.path === selectedFile)) {
        await this.selectFile(selectedFile, currentPage);
      }
      this.toast('ok', `「${workspace.config.name}」を再読み込みしました`);
      return;
    }
    await this.refreshRecent();
    const latest = this.state.recent[0];
    if (!latest) {
      this.toast('info', '最近使った Workspace がありません．Workspace タブでディレクトリを選択してください．');
      return;
    }
    await this.openRecent(latest);
    if (this.state.workspaceHandle === latest.handle) this.toast('ok', `「${latest.name}」を開きました`);
  }

  /**
   * At startup, silently reopen the most recently used workspace when the
   * browser still grants access to it (no prompt is possible without a user
   * gesture; otherwise Cmd+R / the Workspace tab reopens it).
   */
  async restoreLastWorkspace(): Promise<void> {
    if (!this.state.fsSupported) return;
    await this.refreshRecent();
    const latest = this.state.recent[0];
    if (!latest || this.state.workspace || !(await hasPermission(latest.handle, 'readwrite'))) return;
    await this.openHandle(latest.handle);
  }

  private async loadInto(handle: FileSystemDirectoryHandle, fs: WorkspaceFS, mode: LoadMode): Promise<void> {
    this.wsEpoch += 1;
    this.pageCountCache.clear();
    this.undoStack.clear();
    const workspace = await loadWorkspace(fs);
    await this.rememberDiskText(workspace);
    this.journal = new HistoryJournal(fs, { hashChain: workspace.config.history.hashChain });
    this.snapshots = new SnapshotStore(fs);
    this.store.set({
      workspace,
      workspaceHandle: handle,
      pendingInit: undefined,
      selectedFile: undefined,
      selectedBytes: undefined,
      selectedSha256: undefined,
      pageCount: 0,
      currentPage: 1,
      sequence: undefined,
      undo: {},
    });
    for (const w of workspace.warnings) this.toast('warn', w);
    await rememberWorkspaceHandle(handle).catch(() => undefined);
    await this.refreshRecent();
    const eventType = {
      opened: EVENT_TYPES.workspaceOpened,
      initialized: EVENT_TYPES.workspaceInitialized,
      reloaded: EVENT_TYPES.workspaceReloaded,
    }[mode];
    await this.log(eventType, { name: workspace.config.name });
    await this.refreshFiles();
    await this.refreshEvents();
  }

  closeWorkspace(): void {
    this.wsEpoch += 1;
    this.pageCountCache.clear();
    this.undoStack.clear();
    this.diskText.clear();
    this.journal = undefined;
    this.snapshots = undefined;
    this.store.set({
      workspace: undefined,
      workspaceHandle: undefined,
      pendingInit: undefined,
      files: [],
      selectedFile: undefined,
      selectedBytes: undefined,
      selectedSha256: undefined,
      events: [],
      pageCount: 0,
      sequence: undefined,
      undo: {},
    });
  }

  requireWorkspace(): WorkspaceState {
    const ws = this.state.workspace;
    if (!ws) throw new Error('Workspace が開かれていません');
    return ws;
  }

  // ---------------------------------------------------------------- files

  /**
   * List `papers/*.pdf` and compute the status of each from jobs.json and
   * the continuous numbering (`refreshSequence`, awaited so callers see the
   * page ranges as soon as this resolves).
   */
  async refreshFiles(): Promise<void> {
    const ws = this.requireWorkspace();
    const entries = await ws.fs.list(ws.config.directories.papers, { extensions: ['.pdf'] });
    const prev = new Map(this.state.files.map((f) => [f.path, f]));
    const files: PdfFileItem[] = entries.map((e) => {
      const job = latestJob(ws.jobs, e.path);
      const old = prev.get(e.path);
      const sha = old && old.lastModified === e.lastModified && old.size === e.size ? old.sha256 : undefined;
      return { ...e, job, sha256: sha, status: this.statusFor(job, sha, e.path) };
    });
    this.store.set({ files });
    // Detect "source changed" lazily for processed files (hash compare).
    for (const f of files) {
      if (f.job && !f.sha256) void this.hashFile(f.path);
    }
    await this.refreshSequence();
  }

  /** `computeStatus` against the currently resolved sequence (if any) and the current stamps. */
  private statusFor(job: JobRecord | undefined, hash: string | undefined, path: string, sequence = this.state.sequence): FileStatus {
    const item = sequenceItemFor(sequence, path);
    const ws = this.state.workspace;
    return computeStatus(
      job,
      hash,
      item ? { pageStart: item.pageStart } : undefined,
      ws ? stampsFingerprint(ws.stamps) : undefined,
      ws ? this.outputPathFor(path) : undefined,
    );
  }

  /** Recompute every file's status (after stamps.json or jobs.json changed). */
  private refreshStatuses(): void {
    this.store.set((s) => ({ files: s.files.map((f) => ({ ...f, status: this.statusFor(f.job, f.sha256, f.path) })) }));
  }

  // ------------------------------------------------------------- sequence

  /**
   * Re-resolve the continuous page numbering for the current file list:
   * reads the page count of every source PDF not yet cached, then updates
   * `state.sequence` and each file's status. Returns the resolved sequence
   * (undefined when no workspace is open or the result is stale).
   */
  async refreshSequence(): Promise<ResolvedSequence | undefined> {
    const ws = this.state.workspace;
    if (!ws) return undefined;
    const epoch = this.wsEpoch;
    const seq = ++this.sequenceSeq;
    const infos: SequenceFileInfo[] = [];
    for (const f of this.state.files) {
      const cached = this.pageCountCache.get(f.path);
      let pageCount = cached && cached.size === f.size && cached.lastModified === f.lastModified ? cached.pageCount : undefined;
      if (pageCount === undefined) {
        try {
          pageCount = await countPdfPages(await ws.fs.readBytes(f.path));
        } catch (e) {
          console.warn('page count failed', f.path, e);
          pageCount = undefined;
        }
        if (epoch !== this.wsEpoch) return undefined;
        this.pageCountCache.set(f.path, { size: f.size, lastModified: f.lastModified, pageCount });
      }
      infos.push({ path: f.path, pageCount });
    }
    if (epoch !== this.wsEpoch || seq !== this.sequenceSeq) return undefined;
    const resolved = resolveSequence(ws.sequence, infos);
    this.store.set((s) => ({
      sequence: resolved,
      files: s.files.map((f) => ({ ...f, status: this.statusFor(f.job, f.sha256, f.path, resolved) })),
    }));
    return resolved;
  }

  /**
   * Persist a new `sequence.json`, log the change and re-resolve the
   * numbering. Pass a function to derive the new config from the current
   * one: if the file was edited outside the app, it is then applied to the
   * on-disk version. A plain config replaces the file only when it was not
   * edited externally (or for an explicit import), otherwise the external
   * version is loaded and the change is dropped with a warning.
   */
  async updateSequence(
    next: SequenceConfig | ((current: SequenceConfig) => SequenceConfig),
    event?: Record<string, unknown>,
  ): Promise<void> {
    const ws = this.requireWorkspace();
    const saved = await this.guardedWrite(ws, 'sequence', (external) => {
      if (external && typeof next !== 'function' && event?.action !== 'import') return false;
      const before = snapshotOf(ws);
      ws.sequence = typeof next === 'function' ? next(ws.sequence) : next;
      return () => this.recordUndo('通し番号の設定を変更', before, ws);
    });
    if (!saved) {
      await this.refreshSequence();
      return;
    }
    const cfg = ws.sequence;
    await this.log(EVENT_TYPES.sequenceUpdated, {
      order: cfg.order,
      firstPage: cfg.firstPage,
      startOn: cfg.startOn,
      entries: cfg.entries.length,
      ...event,
    });
    await this.refreshSequence();
  }

  private async hashFile(path: string): Promise<string | undefined> {
    const ws = this.state.workspace;
    if (!ws) return undefined;
    const epoch = this.wsEpoch;
    try {
      const bytes = await ws.fs.readBytes(path);
      const hash = await sha256(bytes);
      // The workspace may have been closed or switched to a different one
      // while `readBytes`/`sha256` were in flight — a *different* workspace
      // can easily contain a file at this same relative path, so applying
      // this result unconditionally could attach the wrong hash to it.
      if (epoch !== this.wsEpoch) return undefined;
      this.store.set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, sha256: hash, status: this.statusFor(f.job, hash, path) } : f)),
      }));
      return hash;
    } catch {
      return undefined;
    }
  }

  /** Select a source PDF (read + hash it) and show `page` (default 1; clamped once the page count is known). */
  async selectFile(path: string | undefined, page = 1): Promise<void> {
    const ws = this.requireWorkspace();
    const epoch = this.wsEpoch;
    if (!path) {
      this.selectSeq += 1;
      this.store.set({ selectedFile: undefined, selectedBytes: undefined, selectedSha256: undefined, pageCount: 0 });
      return;
    }
    const seq = ++this.selectSeq;
    await this.run('PDF を読み込み', async () => {
      const bytes = await ws.fs.readBytes(path);
      const hash = await sha256(bytes);
      // Superseded by a later `selectFile` call, or the workspace changed
      // underneath us, while the read/hash were in flight: don't clobber
      // whatever is now selected.
      if (seq !== this.selectSeq || epoch !== this.wsEpoch) return;
      this.store.set((s) => ({
        selectedFile: path,
        selectedBytes: bytes,
        selectedSha256: hash,
        currentPage: Math.max(1, page),
        files: s.files.map((f) => (f.path === path ? { ...f, sha256: hash, status: this.statusFor(f.job, hash, path) } : f)),
      }));
      const item = this.state.files.find((f) => f.path === path);
      if (item?.status === 'source-changed') {
        this.toast('warn', '元 PDF が前回処理時から変更されています');
      }
    });
  }

  setPage(page: number): void {
    const max = Math.max(1, this.state.pageCount);
    this.store.set({ currentPage: Math.min(Math.max(1, page), max) });
  }

  setPageCount(pageCount: number): void {
    this.store.set((s) => ({ pageCount, currentPage: Math.min(Math.max(1, s.currentPage), Math.max(1, pageCount)) }));
  }

  // --------------------------------------------------------------- stamps

  /**
   * Mutate and persist `stamps.json`. Edits that carry an `event` are user
   * actions: they are logged and can be undone; bookkeeping updates without
   * one (e.g. font hashes recorded by `generate.ts`) are neither.
   */
  async updateStamps(
    mutate: (cfg: StampsConfig, ctx: StampsMutationContext) => void | false,
    event?: { type: string; [k: string]: unknown },
  ): Promise<boolean> {
    const ws = this.requireWorkspace();
    const previous = ws.stamps;
    const saved = await this.guardedWrite(ws, 'stamps', (external) => {
      const before = snapshotOf(ws);
      const next = structuredClone(ws.stamps);
      if (mutate(next, { external, previous }) === false) return false;
      ws.stamps = next;
      return () => {
        if (!event) return;
        const target = typeof event.instance === 'string' ? event.instance : typeof event.stamp === 'string' ? event.stamp : '';
        const mergeable = event.type === EVENT_TYPES.stampMoved || event.type === EVENT_TYPES.stampUpdated;
        this.recordUndo(stampEditLabel(event.type, stampNameFor(before.stamps, next, event)), before, ws, mergeable ? `${event.type}:${target}` : undefined);
      };
    });
    if (saved && event) await this.log(event.type, event);
    return saved;
  }

  async setInstanceEnabled(instanceId: string, enabled: boolean): Promise<void> {
    let stampId = '';
    await this.updateStamps(
      (cfg) => {
        const inst = cfg.instances.find((i) => i.id === instanceId);
        if (inst) {
          inst.enabled = enabled;
          stampId = inst.stampId;
        }
      },
      { type: enabled ? EVENT_TYPES.stampEnabled : EVENT_TYPES.stampDisabled, stamp: stampId, instance: instanceId },
    );
  }

  /** Enable or disable every placement of a stamp (the checkbox in the Stamps list). */
  async setStampEnabled(stampId: string, enabled: boolean): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        for (const inst of cfg.instances) if (inst.stampId === stampId) inst.enabled = enabled;
      },
      { type: enabled ? EVENT_TYPES.stampEnabled : EVENT_TYPES.stampDisabled, stamp: stampId },
    );
  }

  /**
   * Give a placement its own position (overriding the definition's
   * `defaultPosition`). The event records where it was before (`from`) so
   * the history shows the whole move.
   */
  async setInstancePosition(instanceId: string, position: StampPosition): Promise<void> {
    const ws = this.requireWorkspace();
    const inst = ws.stamps.instances.find((i) => i.id === instanceId);
    const def = inst && ws.stamps.definitions.find((d) => d.id === inst.stampId);
    const from = inst && def ? effectivePosition(def, inst) : undefined;
    await this.updateStamps(
      (cfg) => {
        const target = cfg.instances.find((i) => i.id === instanceId);
        if (!target) return false;
        target.position = position;
      },
      {
        type: EVENT_TYPES.stampMoved,
        stamp: inst?.stampId ?? '',
        instance: instanceId,
        anchor: position.anchor,
        x: round2(position.offsetX),
        y: round2(position.offsetY),
        ...(from ? { from: { anchor: from.anchor, x: round2(from.offsetX), y: round2(from.offsetY), own: !!inst?.position } } : {}),
      },
    );
  }

  /** Drop a placement's own position so it follows the definition's `defaultPosition` again. */
  async resetInstancePosition(instanceId: string): Promise<void> {
    const inst = this.requireWorkspace().stamps.instances.find((i) => i.id === instanceId);
    if (!inst?.position) return;
    const from = inst.position;
    await this.updateStamps(
      (cfg) => {
        const target = cfg.instances.find((i) => i.id === instanceId);
        if (!target) return false;
        target.position = undefined;
      },
      {
        type: EVENT_TYPES.stampMoved,
        stamp: inst.stampId,
        instance: instanceId,
        reset: true,
        from: { anchor: from.anchor, x: round2(from.offsetX), y: round2(from.offsetY), own: true },
      },
    );
  }

  async setInstancePages(instanceId: string, pages: PageSelector): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        const inst = cfg.instances.find((i) => i.id === instanceId);
        if (inst) inst.pages = pages;
      },
      { type: EVENT_TYPES.stampUpdated, instance: instanceId, pages },
    );
  }

  async addDefinition(def: StampDefinition, withInstance = true): Promise<void> {
    const { createInstanceFromDefinition } = await import('@/stamps');
    await this.updateStamps(
      (cfg) => {
        cfg.definitions.push(def);
        if (withInstance) cfg.instances.push(createInstanceFromDefinition(def));
      },
      { type: EVENT_TYPES.stampAdded, stamp: def.id, name: def.name },
    );
  }

  /**
   * Replace a definition with an edited copy. When stamps.json was edited
   * externally and this very definition changed there, the edit (built from
   * the stale in-memory copy) is dropped rather than undoing those changes.
   */
  async updateDefinition(def: StampDefinition): Promise<void> {
    await this.updateStamps(
      (cfg, { external, previous }) => {
        const i = cfg.definitions.findIndex((d) => d.id === def.id);
        if (i < 0) return false;
        if (external) {
          const shown = previous.definitions.find((d) => d.id === def.id);
          if (JSON.stringify(shown) !== JSON.stringify(cfg.definitions[i])) return false;
        }
        cfg.definitions[i] = def;
      },
      { type: EVENT_TYPES.stampUpdated, stamp: def.id },
    );
  }

  async removeDefinition(stampId: string): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        cfg.definitions = cfg.definitions.filter((d) => d.id !== stampId);
        cfg.instances = cfg.instances.filter((i) => i.stampId !== stampId);
      },
      { type: EVENT_TYPES.stampRemoved, stamp: stampId },
    );
  }

  async addInstance(inst: StampInstance): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        cfg.instances.push(inst);
      },
      { type: EVENT_TYPES.stampAdded, stamp: inst.stampId, instance: inst.id },
    );
  }

  async removeInstance(instanceId: string): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        cfg.instances = cfg.instances.filter((i) => i.id !== instanceId);
      },
      { type: EVENT_TYPES.stampRemoved, instance: instanceId },
    );
  }

  // ------------------------------------------------------------- configs

  /** Save the Settings form. Dropped (with a warning) when workspace.json was edited externally meanwhile. */
  async updateWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    const ws = this.requireWorkspace();
    const saved = await this.guardedWrite(ws, 'config', (external) => {
      if (external) return false;
      const before = snapshotOf(ws);
      ws.config = config;
      return () => this.recordUndo('Workspace 設定を変更', before, ws);
    });
    if (saved) await this.log('workspace.updated', {});
  }

  /** Save the Preflight form. Dropped (with a warning) when preflight.json was edited externally meanwhile. */
  async updatePreflightConfig(config: PreflightConfig): Promise<void> {
    const ws = this.requireWorkspace();
    const saved = await this.guardedWrite(ws, 'preflight', (external) => {
      if (external) return false;
      const before = snapshotOf(ws);
      ws.preflight = config;
      return () => this.recordUndo('Preflight ルールを変更', before, ws);
    });
    if (saved) await this.log('preflight.updated', { id: config.id });
  }

  async recordJob(job: JobRecord): Promise<void> {
    const ws = this.requireWorkspace();
    await this.guardedWrite(ws, 'jobs', () => {
      ws.jobs = { ...ws.jobs, jobs: [...ws.jobs.jobs.filter((j) => j.source !== job.source), job] };
    });
  }

  // ------------------------------------------------------ external edits

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.io.then(fn, fn);
    this.io = next.catch(() => undefined);
    return next;
  }

  private async rememberDiskText(ws: WorkspaceState): Promise<void> {
    this.diskText.clear();
    this.reportedBadText.clear();
    for (const kind of Object.keys(CONFIG_FILES) as ConfigFile[]) {
      try {
        this.diskText.set(kind, await ws.fs.readText(CONFIG_FILES[kind]));
      } catch {
        /* missing: nothing external to protect yet */
      }
    }
  }

  private async writeConfig(ws: WorkspaceState, kind: ConfigFile): Promise<void> {
    let text: string;
    if (kind === 'config') {
      text = await saveWorkspaceConfig(ws.fs, ws.config);
      this.journal = new HistoryJournal(ws.fs, { hashChain: ws.config.history.hashChain });
    } else if (kind === 'stamps') text = await saveStampsConfig(ws.fs, ws.stamps);
    else if (kind === 'sequence') text = await saveSequenceConfig(ws.fs, ws.sequence);
    else if (kind === 'preflight') text = await savePreflightConfig(ws.fs, ws.preflight);
    else text = await saveJobsConfig(ws.fs, ws.jobs);
    this.diskText.set(kind, text);
    if (kind === 'stamps') this.refreshStatuses();
  }

  /**
   * If `kind` changed on disk since this session last read or wrote it,
   * load the on-disk version into `ws` and return true. Undo history is
   * dropped then: its snapshots predate the external edit and restoring one
   * would silently revert it. Throws when the external version isn't valid
   * JSON (nothing is written until it is fixed).
   */
  private async adoptExternal(ws: WorkspaceState, kind: ConfigFile): Promise<boolean> {
    const known = this.diskText.get(kind);
    let text: string;
    try {
      text = await ws.fs.readText(CONFIG_FILES[kind]);
    } catch {
      return false;
    }
    if (known === undefined || text === known) return false;
    let parsed: unknown;
    try {
      parsed = stripSchemaKey(JSON.parse(text));
    } catch (e) {
      throw new Error(
        `${fileLabel(kind)} が外部で変更されましたが JSON として読めません（${e instanceof Error ? e.message : String(e)}）．修正されるまで保存しません`,
      );
    }
    if (kind === 'sequence') ws.sequence = normalizeSequenceConfig(parsed).config;
    else if (kind === 'config') {
      ws.config = parsed as WorkspaceConfig;
      this.journal = new HistoryJournal(ws.fs, { hashChain: ws.config.history.hashChain });
    } else if (kind === 'stamps') ws.stamps = parsed as StampsConfig;
    else if (kind === 'preflight') ws.preflight = parsed as PreflightConfig;
    else ws.jobs = parsed as JobsConfig;
    this.diskText.set(kind, text);
    this.reportedBadText.delete(kind);
    if (kind === 'stamps') this.refreshStatuses();
    this.undoStack.clear();
    this.syncUndoState();
    return true;
  }

  /**
   * Read-modify-write of one config file that never overwrites an external
   * edit with stale data: the on-disk version is adopted first (when it
   * changed), then `apply` edits `ws` — returning false to cancel, or a
   * callback run after the write (e.g. to record undo). Returns whether the
   * file was written; failures are reported as toasts.
   */
  private async guardedWrite(
    ws: WorkspaceState,
    kind: ConfigFile,
    apply: (external: boolean) => false | void | (() => void),
  ): Promise<boolean> {
    const file = fileLabel(kind);
    try {
      return await this.exclusive(async () => {
        const external = await this.adoptExternal(ws, kind);
        const after = apply(external);
        if (after === false) {
          this.store.set({ workspace: { ...ws } });
          if (external) {
            this.toast('warn', `${file} が Workbench の外で変更されていたため，この変更は保存せず外部の内容を読み込みました．内容を確認してからもう一度操作してください`, 10000);
          }
          return false;
        }
        await this.writeConfig(ws, kind);
        if (after) after();
        this.store.set({ workspace: { ...ws } });
        if (external) this.toast('warn', `${file} が Workbench の外で変更されていたため，読み直してから変更を適用しました`, 8000);
        return true;
      });
    } catch (e) {
      this.toast('err', `${file} を保存できませんでした: ${e instanceof Error ? e.message : String(e)}`, 10000);
      return false;
    }
  }

  /**
   * Pick up config files edited outside the app (called on window focus and
   * periodically). Returns the files that were reloaded.
   */
  async checkExternalChanges(): Promise<string[]> {
    const ws = this.state.workspace;
    if (!ws || this.diskText.size === 0) return [];
    const epoch = this.wsEpoch;
    const changed: ConfigFile[] = await this.exclusive(async () => {
      const kinds: ConfigFile[] = [];
      for (const kind of Object.keys(CONFIG_FILES) as ConfigFile[]) {
        if (epoch !== this.wsEpoch) return [];
        try {
          if (await this.adoptExternal(ws, kind)) kinds.push(kind);
        } catch (e) {
          const text = await ws.fs.readText(CONFIG_FILES[kind]).catch(() => '');
          if (this.reportedBadText.get(kind) !== text) {
            this.reportedBadText.set(kind, text);
            this.toast('warn', e instanceof Error ? e.message : String(e), 10000);
          }
        }
      }
      return kinds;
    });
    if (changed.length === 0 || epoch !== this.wsEpoch) return [];
    this.store.set({ workspace: { ...ws } });
    const names = changed.map(fileLabel);
    this.toast('info', `Workbench の外で変更された ${names.join('，')} を読み込みました`);
    await this.log(EVENT_TYPES.externalChange, { files: names });
    if (changed.includes('sequence') || changed.includes('jobs')) await this.refreshFiles();
    return names;
  }

  /** Output path for a source, honouring a per-file `output` name from `sequence.json`. */
  outputPathFor(sourcePath: string): string {
    const ws = this.requireWorkspace();
    const entry = ws.sequence.entries.find((e) => e.file === sourcePath);
    return outputPathFor(sourcePath, ws.config, entry?.output);
  }

  // ------------------------------------------------------------ undo/redo

  private recordUndo(label: string, before: ConfigSnapshot, ws: WorkspaceState, mergeKey?: string): void {
    this.undoStack.push({ label, before, after: snapshotOf(ws), mergeKey, at: Date.now() });
    this.syncUndoState();
  }

  private syncUndoState(): void {
    this.store.set({ undo: { undo: this.undoStack.nextUndo?.label, redo: this.undoStack.nextRedo?.label } });
  }

  /** Cmd+Z: restore the config files as they were before the last edit. */
  async undo(): Promise<void> {
    await this.stepHistory('undo');
  }

  /** Cmd+Shift+Z: re-apply the last undone edit. */
  async redo(): Promise<void> {
    await this.stepHistory('redo');
  }

  private async stepHistory(dir: 'undo' | 'redo'): Promise<void> {
    const ws = this.state.workspace;
    if (!ws) return;
    const entry = dir === 'undo' ? this.undoStack.nextUndo : this.undoStack.nextRedo;
    if (!entry) {
      this.toast('info', dir === 'undo' ? '元に戻す操作はありません' : 'やり直す操作はありません', 2500);
      return;
    }
    const target = dir === 'undo' ? entry.before : entry.after;
    const result = await this.run(dir === 'undo' ? '元に戻す' : 'やり直す', () =>
      this.exclusive(async () => {
        const kinds = changedKinds(snapshotOf(ws), target);
        // Restoring a snapshot taken before an external edit would revert it:
        // load the external version instead and drop the undo history.
        const external: ConfigFile[] = [];
        for (const kind of kinds) if (await this.adoptExternal(ws, kind)) external.push(kind);
        if (external.length) {
          this.store.set({ workspace: { ...ws } });
          return { external: external.map(fileLabel), kinds };
        }
        const restored = structuredClone(target);
        for (const kind of kinds) {
          if (kind === 'config') ws.config = restored.config;
          else if (kind === 'stamps') ws.stamps = restored.stamps;
          else if (kind === 'sequence') ws.sequence = restored.sequence;
          else ws.preflight = restored.preflight;
          await this.writeConfig(ws, kind);
        }
        if (dir === 'undo') this.undoStack.undo();
        else this.undoStack.redo();
        this.store.set({ workspace: { ...ws } });
        this.syncUndoState();
        return { external: [], kinds };
      }),
    );
    if (!result) return;
    if (result.kinds.includes('sequence')) await this.refreshSequence();
    if (result.external.length) {
      this.toast('warn', `${result.external.join('，')} が Workbench の外で変更されていたため，元に戻さずに外部の内容を読み込みました`, 10000);
      return;
    }
    await this.log(dir === 'undo' ? EVENT_TYPES.undo : EVENT_TYPES.redo, { label: entry.label });
    this.toast('info', dir === 'undo' ? `元に戻しました: ${entry.label}` : `やり直しました: ${entry.label}`, 3000);
  }

  // ------------------------------------------------------------- history

  async log(type: string, payload: Record<string, unknown>): Promise<void> {
    if (!this.journal) return;
    try {
      const { type: _t, ...rest } = payload as { type?: string } & Record<string, unknown>;
      void _t;
      const ev = await this.journal.append({ type, ...rest });
      this.store.set((s) => ({ events: [...s.events.slice(-499), ev] }));
    } catch (e) {
      console.warn('history append failed', e);
    }
  }

  async refreshEvents(): Promise<void> {
    if (!this.journal) return;
    const all = await this.journal.readAll().catch(() => [] as HistoryEvent[]);
    this.store.set({ events: all.slice(-500) });
  }

  async saveSnapshot(reason: string): Promise<string | undefined> {
    const ws = this.requireWorkspace();
    if (!this.snapshots) return undefined;
    const path = await this.snapshots.save({
      reason,
      workspace: ws.config,
      stamps: ws.stamps,
      preflight: ws.preflight,
      jobs: ws.jobs,
      sequence: ws.sequence,
    });
    await this.log(EVENT_TYPES.snapshotSaved, { path, reason });
    return path;
  }

  async saveReport(report: PreflightReport): Promise<string> {
    const ws = this.requireWorkspace();
    const { reportFileName } = await import('@/preflight');
    const path = `${WORKBENCH_FILES.reportsDir}/${reportFileName(report.file, new Date())}`;
    await ws.fs.writeText(path, `${JSON.stringify(report, null, 2)}\n`);
    this.store.set({ lastReport: report });
    await this.log(EVENT_TYPES.preflightRun, { file: report.file, result: report.result, report: path });
    return path;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function snapshotOf(ws: WorkspaceState): ConfigSnapshot {
  return structuredClone({ config: ws.config, stamps: ws.stamps, sequence: ws.sequence, preflight: ws.preflight });
}

/** Name of the stamp an edit event refers to (by definition or instance id), looked up before and after the edit. */
function stampNameFor(before: StampsConfig, after: StampsConfig, event: Record<string, unknown>): string | undefined {
  for (const cfg of [after, before]) {
    const stampId =
      typeof event.stamp === 'string' && event.stamp
        ? event.stamp
        : cfg.instances.find((i) => i.id === event.instance)?.stampId;
    const name = cfg.definitions.find((d) => d.id === stampId)?.name;
    if (name) return name;
  }
  return undefined;
}

export function latestJob(jobs: JobsConfig, source: string): JobRecord | undefined {
  const list = jobs.jobs.filter((j) => j.source === source);
  return list.length ? list[list.length - 1] : undefined;
}

/**
 * Status of a source file from its latest job, its current hash and (when
 * the sequence has been resolved) the continuous page number it should
 * start at. A job that recorded a `pageStart` is flagged when that number
 * no longer matches; jobs without one (skipped files, or generated before
 * the sequence existed) are never flagged for numbering.
 */
export function computeStatus(
  job: JobRecord | undefined,
  currentHash: string | undefined,
  numbering?: { pageStart?: number },
  stampsHash?: string,
  outputPath?: string,
): FileStatus {
  if (!job) return 'not-processed';
  if (currentHash && job.sourceHash !== currentHash) return 'source-changed';
  if (numbering && job.pageStart !== undefined && job.pageStart !== numbering.pageStart) return 'numbering-changed';
  // Jobs from before stamps fingerprints were recorded are never flagged.
  if (stampsHash && job.stampsHash && job.stampsHash !== stampsHash) return 'stamps-changed';
  // e.g. a re-imported CSV renamed the output.
  if (outputPath && job.output !== outputPath) return 'output-changed';
  if (job.status === 'error') return 'error';
  if (job.status === 'warning') return 'warning';
  return 'processed';
}

/** How each status is shown: `icon` names an icon in `ui/icons.ts`, `cls` its colour. */
export const STATUS_LABEL: Record<FileStatus, { icon: string; text: string; cls: string }> = {
  'not-processed': { icon: 'circle', text: '未処理', cls: 'muted' },
  processed: { icon: 'circle-check', text: '処理済み（最新）', cls: 'ok' },
  warning: { icon: 'triangle-alert', text: '処理済み（警告あり）', cls: 'warn' },
  error: { icon: 'circle-x', text: 'エラー', cls: 'err' },
  'source-changed': { icon: 'refresh-cw', text: '要更新: 元 PDF が変更されました', cls: 'update' },
  'numbering-changed': { icon: 'refresh-cw', text: '要更新: 通しページ番号が変わりました', cls: 'update' },
  'stamps-changed': { icon: 'refresh-cw', text: '要更新: 生成後にスタンプ設定が変更されました', cls: 'update' },
  'output-changed': { icon: 'refresh-cw', text: '要更新: 出力ファイル名が変わりました（CSV の取り込みなど）', cls: 'update' },
};
