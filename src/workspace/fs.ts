import type { WorkspaceFileEntry } from '@/core/types';
import { basename, dirname } from './paths';

/** True when `err` is a DOMException with the given name (works across environments). */
function isDomError(err: unknown, name: string): boolean {
  return (
    (err instanceof DOMException && err.name === name) ||
    (typeof err === 'object' && err !== null && (err as { name?: string }).name === name)
  );
}

/** True for errors that mean "this path does not exist / is not that kind of entry". */
function isMissingError(err: unknown): boolean {
  return isDomError(err, 'NotFoundError') || isDomError(err, 'TypeMismatchError');
}

/**
 * Normalise a workspace-relative path: trims a leading `./`, collapses
 * repeated slashes and empty segments, and rejects `..` segments (paths must
 * stay inside the workspace root). Returns `''` for the workspace root.
 */
export function normalizeWorkspacePath(path: string): string {
  let p = path.trim();
  if (p.startsWith('./')) p = p.slice(2);
  const segments = p.split('/').filter((s) => s.length > 0 && s !== '.');
  for (const seg of segments) {
    if (seg === '..') {
      throw new Error(`Workspace paths must not contain '..': ${path}`);
    }
  }
  return segments.join('/');
}

/**
 * Minimal shape we rely on from a writable stream: `seek` is part of the
 * real File System Access API, but we feature-detect it at runtime (some
 * test doubles may not implement it), so it's typed as optional here rather
 * than via `extends FileSystemWritableFileStream` (which would make it
 * required).
 */
interface SeekableWritable {
  write: FileSystemWritableFileStream['write'];
  close: () => Promise<void>;
  seek?: (position: number) => Promise<void>;
}

/**
 * Thin wrapper around a `FileSystemDirectoryHandle` exposing a small,
 * promise-based, path-string API. All paths are workspace-relative POSIX
 * paths (e.g. `papers/paper.pdf`); a leading `./` is tolerated and `..` is
 * rejected.
 */
export class WorkspaceFS {
  private readonly root: FileSystemDirectoryHandle;

  constructor(root: FileSystemDirectoryHandle) {
    this.root = root;
  }

  /** Name of the root directory (the workspace's display name). */
  get name(): string {
    return this.root.name;
  }

  /** The underlying root directory handle, for callers that need it directly. */
  get rootHandle(): FileSystemDirectoryHandle {
    return this.root;
  }

  private async getDirectoryHandleAt(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    if (!path) return this.root;
    let dir = this.root;
    for (const seg of path.split('/')) {
      dir = await dir.getDirectoryHandle(seg, { create });
    }
    return dir;
  }

  private async getFileHandleAt(path: string, create: boolean): Promise<FileSystemFileHandle> {
    const normalized = normalizeWorkspacePath(path);
    const name = basename(normalized);
    if (!name) throw new Error(`Invalid file path: ${path}`);
    const dir = await this.getDirectoryHandleAt(dirname(normalized), create);
    return dir.getFileHandle(name, { create });
  }

  /** True when a file or directory exists at `path`. */
  async exists(path: string): Promise<boolean> {
    const normalized = normalizeWorkspacePath(path);
    if (normalized === '') return true;
    try {
      await this.getFileHandleAt(normalized, false);
      return true;
    } catch (fileErr) {
      if (!isMissingError(fileErr)) throw fileErr;
    }
    try {
      await this.getDirectoryHandleAt(normalized, false);
      return true;
    } catch (dirErr) {
      if (isMissingError(dirErr)) return false;
      throw dirErr;
    }
  }

  /** Read a file as UTF-8 text. Throws if the file does not exist. */
  async readText(path: string): Promise<string> {
    const file = await this.getFile(path);
    return file.text();
  }

  /** Read a file as raw bytes. Throws if the file does not exist. */
  async readBytes(path: string): Promise<Uint8Array> {
    const file = await this.getFile(path);
    const buf = await file.arrayBuffer();
    return new Uint8Array(buf);
  }

  /** Get the underlying `File` object (size, lastModified, ...). */
  async getFile(path: string): Promise<File> {
    const handle = await this.getFileHandleAt(path, false);
    return handle.getFile();
  }

  /** Write UTF-8 text to `path`, creating parent directories and overwriting any existing content. */
  async writeText(path: string, text: string): Promise<void> {
    const handle = await this.getFileHandleAt(path, true);
    const writable = await handle.createWritable();
    await writable.write(text);
    await writable.close();
  }

  /** Write raw bytes to `path`, creating parent directories and overwriting any existing content. */
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.getFileHandleAt(path, true);
    const writable = await handle.createWritable();
    // Copy into a fresh, plain-ArrayBuffer-backed view: avoids a typing
    // mismatch when `bytes` is typed as `Uint8Array<ArrayBufferLike>` (which
    // admits SharedArrayBuffer, not accepted by FileSystemWriteChunkType).
    await writable.write(new Uint8Array(bytes));
    await writable.close();
  }

  /**
   * Append UTF-8 text to `path` (creating it and its parent directories if
   * necessary). Uses `keepExistingData: true` plus a seek to the current end
   * of the file; falls back to a read-concat-rewrite when the writable
   * stream doesn't support `seek` (used for events.jsonl).
   */
  async appendText(path: string, text: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    const existed = await this.exists(normalized);
    const handle = await this.getFileHandleAt(normalized, true);
    const writable = (await handle.createWritable({ keepExistingData: true })) as SeekableWritable;
    if (typeof writable.seek === 'function') {
      const size = existed ? (await handle.getFile()).size : 0;
      await writable.seek(size);
      await writable.write(text);
      await writable.close();
      return;
    }
    // No seek support: abandon the (already truncation-free) writable and
    // fall back to reading the whole file and rewriting it.
    await writable.close();
    const existing = existed ? await this.readText(normalized) : '';
    await this.writeText(normalized, existing + text);
  }

  /** Create `path` (and any missing parent directories) as a directory tree. */
  async mkdirp(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) return;
    await this.getDirectoryHandleAt(normalized, true);
  }

  /** Remove a file or (recursively) a directory. No-op if it doesn't already exist. */
  async remove(path: string): Promise<void> {
    const normalized = normalizeWorkspacePath(path);
    if (!normalized) throw new Error('Refusing to remove the workspace root.');
    const dir = await this.getDirectoryHandleAt(dirname(normalized), false).catch((err) => {
      if (isMissingError(err)) return undefined;
      throw err;
    });
    if (!dir) return;
    await dir.removeEntry(basename(normalized), { recursive: true }).catch((err) => {
      if (!isMissingError(err)) throw err;
    });
  }

  /**
   * List directory contents as `WorkspaceFileEntry[]`, sorted by name.
   * Missing directories resolve to `[]` rather than throwing. Hidden entries
   * (name starting with `.`) are skipped unless `includeHidden` is set.
   */
  async list(
    dirPath: string,
    opts?: { extensions?: string[]; recursive?: boolean; includeHidden?: boolean }
  ): Promise<WorkspaceFileEntry[]> {
    const normalized = normalizeWorkspacePath(dirPath);
    let dir: FileSystemDirectoryHandle;
    try {
      dir = await this.getDirectoryHandleAt(normalized, false);
    } catch (err) {
      if (isMissingError(err)) return [];
      throw err;
    }
    const extensions = opts?.extensions?.map((e) => e.toLowerCase());
    const results: WorkspaceFileEntry[] = [];
    await collectEntries(dir, normalized, { ...opts, extensions }, results);
    results.sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path));
    return results;
  }
}

async function collectEntries(
  dir: FileSystemDirectoryHandle,
  basePath: string,
  opts: { extensions?: string[]; recursive?: boolean; includeHidden?: boolean } | undefined,
  out: WorkspaceFileEntry[]
): Promise<void> {
  for await (const [name, handle] of dir.entries()) {
    if (!opts?.includeHidden && name.startsWith('.')) continue;
    const path = basePath ? `${basePath}/${name}` : name;
    if (handle.kind === 'file') {
      if (opts?.extensions && opts.extensions.length > 0) {
        const dot = name.lastIndexOf('.');
        const ext = dot === -1 ? '' : name.slice(dot).toLowerCase();
        if (!opts.extensions.includes(ext)) continue;
      }
      const file = await (handle as FileSystemFileHandle).getFile();
      out.push({ path, name, size: file.size, lastModified: file.lastModified });
    } else if (handle.kind === 'directory' && opts?.recursive) {
      await collectEntries(handle as FileSystemDirectoryHandle, path, opts, out);
    }
  }
}

