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
  type RecentWorkspace,
  type WorkspaceState,
} from '@/workspace';
import { EVENT_TYPES, HistoryJournal, SnapshotStore } from '@/history';
import { countPdfPages } from '@/pdf/reader';
import { resolveSequence, sequenceItemFor, type ResolvedSequence, type SequenceFileInfo } from '@/sequence';
import type { HistoryEvent } from '@/core/types';
import { Store } from './store';
import { loadPrefs, savePrefs, type UiPrefs } from './prefs';

export type FileStatus =
  | 'not-processed'
  | 'processed'
  | 'warning'
  | 'error'
  | 'source-changed'
  | 'numbering-changed';

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
  toasts: Toast[];
  /** Recently loaded events (for the History tab). */
  events: HistoryEvent[];
  lastReport?: PreflightReport;
  /**
   * Continuous page numbering of `files` per `sequence.json`, refreshed by
   * `refreshSequence()` (page counts are read lazily and cached per file).
   */
  sequence?: ResolvedSequence;
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
      await this.loadInto(handle, fs, false);
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
      await this.loadInto(pending.handle, pending.fs, true);
    });
  }

  private async loadInto(handle: FileSystemDirectoryHandle, fs: WorkspaceFS, justInitialized: boolean): Promise<void> {
    this.wsEpoch += 1;
    this.pageCountCache.clear();
    const workspace = await loadWorkspace(fs);
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
    });
    for (const w of workspace.warnings) this.toast('warn', w);
    await rememberWorkspaceHandle(handle).catch(() => undefined);
    await this.refreshRecent();
    await this.log(justInitialized ? EVENT_TYPES.workspaceInitialized : EVENT_TYPES.workspaceOpened, {
      name: workspace.config.name,
    });
    await this.refreshFiles();
    await this.refreshEvents();
  }

  closeWorkspace(): void {
    this.wsEpoch += 1;
    this.pageCountCache.clear();
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

  /** `computeStatus` against the currently resolved sequence (if any). */
  private statusFor(job: JobRecord | undefined, hash: string | undefined, path: string): FileStatus {
    const item = sequenceItemFor(this.state.sequence, path);
    return computeStatus(job, hash, item ? { pageStart: item.pageStart } : undefined);
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
      files: s.files.map((f) => {
        const item = sequenceItemFor(resolved, f.path);
        return { ...f, status: computeStatus(f.job, f.sha256, item ? { pageStart: item.pageStart } : undefined) };
      }),
    }));
    return resolved;
  }

  /** Persist a new `sequence.json`, log the change and re-resolve the numbering. */
  async updateSequence(next: SequenceConfig, event?: Record<string, unknown>): Promise<void> {
    const ws = this.requireWorkspace();
    ws.sequence = next;
    await saveSequenceConfig(ws.fs, next);
    this.store.set({ workspace: { ...ws } });
    await this.log(EVENT_TYPES.sequenceUpdated, {
      order: next.order,
      firstPage: next.firstPage,
      startOn: next.startOn,
      entries: next.entries.length,
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

  async selectFile(path: string | undefined): Promise<void> {
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
        currentPage: 1,
        files: s.files.map((f) => (f.path === path ? { ...f, sha256: hash, status: this.statusFor(f.job, hash, path) } : f)),
      }));
      const item = this.state.files.find((f) => f.path === path);
      if (item?.status === 'source-changed') {
        this.toast('warn', '⚠ 元 PDF が前回処理時から変更されています');
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

  async updateStamps(mutate: (cfg: StampsConfig) => void, event?: { type: string; [k: string]: unknown }): Promise<void> {
    const ws = this.requireWorkspace();
    const next = structuredClone(ws.stamps);
    mutate(next);
    ws.stamps = next;
    await saveStampsConfig(ws.fs, next);
    this.store.set({ workspace: { ...ws } });
    if (event) await this.log(event.type, event);
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

  async setInstancePosition(instanceId: string, position: StampPosition): Promise<void> {
    let stampId = '';
    await this.updateStamps(
      (cfg) => {
        const inst = cfg.instances.find((i) => i.id === instanceId);
        if (inst) {
          inst.position = position;
          stampId = inst.stampId;
        }
      },
      {
        type: EVENT_TYPES.stampMoved,
        stamp: stampId,
        instance: instanceId,
        anchor: position.anchor,
        x: Math.round(position.offsetX * 100) / 100,
        y: Math.round(position.offsetY * 100) / 100,
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

  async updateDefinition(def: StampDefinition): Promise<void> {
    await this.updateStamps(
      (cfg) => {
        const i = cfg.definitions.findIndex((d) => d.id === def.id);
        if (i >= 0) cfg.definitions[i] = def;
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

  async updateWorkspaceConfig(config: WorkspaceConfig): Promise<void> {
    const ws = this.requireWorkspace();
    ws.config = config;
    await saveWorkspaceConfig(ws.fs, config);
    this.journal = new HistoryJournal(ws.fs, { hashChain: config.history.hashChain });
    this.store.set({ workspace: { ...ws } });
    await this.log('workspace.updated', {});
  }

  async updatePreflightConfig(config: PreflightConfig): Promise<void> {
    const ws = this.requireWorkspace();
    ws.preflight = config;
    await savePreflightConfig(ws.fs, config);
    this.store.set({ workspace: { ...ws } });
    await this.log('preflight.updated', { id: config.id });
  }

  async recordJob(job: JobRecord): Promise<void> {
    const ws = this.requireWorkspace();
    ws.jobs = { ...ws.jobs, jobs: [...ws.jobs.jobs.filter((j) => j.source !== job.source), job] };
    await saveJobsConfig(ws.fs, ws.jobs);
    this.store.set({ workspace: { ...ws } });
  }

  outputPathFor(sourcePath: string): string {
    return outputPathFor(sourcePath, this.requireWorkspace().config);
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
): FileStatus {
  if (!job) return 'not-processed';
  if (currentHash && job.sourceHash !== currentHash) return 'source-changed';
  if (numbering && job.pageStart !== undefined && job.pageStart !== numbering.pageStart) return 'numbering-changed';
  if (job.status === 'error') return 'error';
  if (job.status === 'warning') return 'warning';
  return 'processed';
}

export const STATUS_LABEL: Record<FileStatus, { icon: string; text: string; cls: string }> = {
  'not-processed': { icon: '○', text: 'Not processed', cls: 'muted' },
  processed: { icon: '✓', text: 'Processed', cls: 'ok' },
  warning: { icon: '⚠', text: 'Warning', cls: 'warn' },
  error: { icon: '✗', text: 'Error', cls: 'err' },
  'source-changed': { icon: '⚠', text: 'Source changed', cls: 'warn' },
  'numbering-changed': { icon: '⚠', text: 'Page numbers changed', cls: 'warn' },
};
