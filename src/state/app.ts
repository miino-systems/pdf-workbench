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
  saveStampsConfig,
  saveWorkspaceConfig,
  type RecentWorkspace,
  type WorkspaceState,
} from '@/workspace';
import { EVENT_TYPES, HistoryJournal, SnapshotStore } from '@/history';
import type { HistoryEvent } from '@/core/types';
import { Store } from './store';
import { loadPrefs, savePrefs, type UiPrefs } from './prefs';

export type FileStatus = 'not-processed' | 'processed' | 'warning' | 'error' | 'source-changed';

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
}

let toastSeq = 0;

export class AppController {
  readonly store: Store<AppState>;
  journal?: HistoryJournal;
  snapshots?: SnapshotStore;

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
    });
  }

  requireWorkspace(): WorkspaceState {
    const ws = this.state.workspace;
    if (!ws) throw new Error('Workspace が開かれていません');
    return ws;
  }

  // ---------------------------------------------------------------- files

  /** List `papers/*.pdf` and compute the status of each from jobs.json. */
  async refreshFiles(): Promise<void> {
    const ws = this.requireWorkspace();
    const entries = await ws.fs.list(ws.config.directories.papers, { extensions: ['.pdf'] });
    const prev = new Map(this.state.files.map((f) => [f.path, f]));
    const files: PdfFileItem[] = entries.map((e) => {
      const job = latestJob(ws.jobs, e.path);
      const old = prev.get(e.path);
      const sha = old && old.lastModified === e.lastModified && old.size === e.size ? old.sha256 : undefined;
      return { ...e, job, sha256: sha, status: computeStatus(job, sha) };
    });
    this.store.set({ files });
    // Detect "source changed" lazily for processed files (hash compare).
    for (const f of files) {
      if (f.job && !f.sha256) void this.hashFile(f.path);
    }
  }

  private async hashFile(path: string): Promise<string | undefined> {
    const ws = this.state.workspace;
    if (!ws) return undefined;
    try {
      const bytes = await ws.fs.readBytes(path);
      const hash = await sha256(bytes);
      this.store.set((s) => ({
        files: s.files.map((f) => (f.path === path ? { ...f, sha256: hash, status: computeStatus(f.job, hash) } : f)),
      }));
      return hash;
    } catch {
      return undefined;
    }
  }

  async selectFile(path: string | undefined): Promise<void> {
    const ws = this.requireWorkspace();
    if (!path) {
      this.store.set({ selectedFile: undefined, selectedBytes: undefined, selectedSha256: undefined, pageCount: 0 });
      return;
    }
    await this.run('PDF を読み込み', async () => {
      const bytes = await ws.fs.readBytes(path);
      const hash = await sha256(bytes);
      this.store.set((s) => ({
        selectedFile: path,
        selectedBytes: bytes,
        selectedSha256: hash,
        currentPage: 1,
        files: s.files.map((f) => (f.path === path ? { ...f, sha256: hash, status: computeStatus(f.job, hash) } : f)),
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

export function computeStatus(job: JobRecord | undefined, currentHash: string | undefined): FileStatus {
  if (!job) return 'not-processed';
  if (currentHash && job.sourceHash !== currentHash) return 'source-changed';
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
};
