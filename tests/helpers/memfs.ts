/**
 * A minimal in-memory fake of the File System Access API
 * (`FileSystemDirectoryHandle` / `FileSystemFileHandle` /
 * `FileSystemWritableFileStream`), sufficient to exercise `WorkspaceFS`
 * under vitest (Node has no real File System Access API).
 *
 * Only the surface `WorkspaceFS` actually uses is implemented; unsupported
 * operations throw. Missing-entry errors are `DOMException('NotFoundError')`
 * to match the real API, which `WorkspaceFS` relies on.
 */

type Entry = MemoryDirectoryHandle | MemoryFileHandle;

function notFound(name: string): DOMException {
  return new DOMException(`Entry not found: ${name}`, 'NotFoundError');
}

function typeMismatch(name: string): DOMException {
  return new DOMException(`Entry is not the requested kind: ${name}`, 'TypeMismatchError');
}

export class MemoryFileHandle implements FileSystemFileHandle {
  readonly kind = 'file' as const;
  name: string;
  content: Uint8Array = new Uint8Array(0);
  lastModified = Date.now();

  constructor(name: string) {
    this.name = name;
  }

  async getFile(): Promise<File> {
    // Copy the bytes so later writes don't mutate a `File` already handed out.
    const bytes = this.content.slice();
    return new File([bytes], this.name, { lastModified: this.lastModified });
  }

  async createWritable(options?: FileSystemCreateWritableOptions): Promise<FileSystemWritableFileStream> {
    const keepExisting = options?.keepExistingData ?? false;
    return new MemoryWritableStream(this, keepExisting);
  }

  async resolve(): Promise<string[] | null> {
    return null;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }
}

/** Writable stream that buffers writes and commits them to the file on `close()`. */
class MemoryWritableStream implements FileSystemWritableFileStream {
  locked = false;
  private readonly file: MemoryFileHandle;
  private buffer: Uint8Array;
  private position = 0;

  constructor(file: MemoryFileHandle, keepExisting: boolean) {
    this.file = file;
    this.buffer = keepExisting ? file.content.slice() : new Uint8Array(0);
  }

  private ensureCapacity(minLength: number): void {
    if (this.buffer.length >= minLength) return;
    const grown = new Uint8Array(minLength);
    grown.set(this.buffer);
    this.buffer = grown;
  }

  async write(data: FileSystemWriteChunkType): Promise<void> {
    let bytes: Uint8Array;
    if (typeof data === 'string') {
      bytes = new TextEncoder().encode(data);
    } else if (data instanceof Uint8Array) {
      bytes = data;
    } else if (data instanceof ArrayBuffer) {
      bytes = new Uint8Array(data);
    } else if (data instanceof Blob) {
      bytes = new Uint8Array(await data.arrayBuffer());
    } else if (ArrayBuffer.isView(data)) {
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } else {
      // WriteParams ({ type: 'write' | 'seek' | 'truncate', ... }) — not used by WorkspaceFS.
      throw new Error('Unsupported write chunk type in MemoryWritableStream');
    }
    this.ensureCapacity(this.position + bytes.length);
    this.buffer.set(bytes, this.position);
    this.position += bytes.length;
  }

  async seek(position: number): Promise<void> {
    this.position = position;
  }

  async truncate(size: number): Promise<void> {
    if (size <= this.buffer.length) {
      this.buffer = this.buffer.slice(0, size);
    } else {
      this.ensureCapacity(size);
    }
    if (this.position > size) this.position = size;
  }

  async close(): Promise<void> {
    this.file.content = this.buffer;
    this.file.lastModified = Date.now();
  }

  async abort(): Promise<void> {
    // no-op: nothing was committed yet.
  }

  getWriter(): WritableStreamDefaultWriter {
    throw new Error('MemoryWritableStream.getWriter() is not implemented');
  }
}

export class MemoryDirectoryHandle implements FileSystemDirectoryHandle {
  readonly kind = 'directory' as const;
  name: string;
  private readonly children = new Map<string, Entry>();

  constructor(name: string) {
    this.name = name;
  }

  async getDirectoryHandle(name: string, options?: FileSystemGetDirectoryOptions): Promise<FileSystemDirectoryHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'directory') throw typeMismatch(name);
      return existing;
    }
    if (!options?.create) throw notFound(name);
    const created = new MemoryDirectoryHandle(name);
    this.children.set(name, created);
    return created;
  }

  async getFileHandle(name: string, options?: FileSystemGetFileOptions): Promise<FileSystemFileHandle> {
    const existing = this.children.get(name);
    if (existing) {
      if (existing.kind !== 'file') throw typeMismatch(name);
      return existing;
    }
    if (!options?.create) throw notFound(name);
    const created = new MemoryFileHandle(name);
    this.children.set(name, created);
    return created;
  }

  async removeEntry(name: string, options?: FileSystemRemoveOptions): Promise<void> {
    const existing = this.children.get(name);
    if (!existing) throw notFound(name);
    if (existing.kind === 'directory' && !options?.recursive) {
      const child = existing as MemoryDirectoryHandle;
      if (child.children.size > 0) {
        throw new DOMException(`Directory not empty: ${name}`, 'InvalidModificationError');
      }
    }
    this.children.delete(name);
  }

  async resolve(): Promise<string[] | null> {
    return null;
  }

  async isSameEntry(other: FileSystemHandle): Promise<boolean> {
    return other === this;
  }

  async *entries(): AsyncGenerator<[string, Entry]> {
    for (const [name, handle] of [...this.children.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      yield [name, handle];
    }
  }

  async *keys(): AsyncGenerator<string> {
    for await (const [name] of this.entries()) yield name;
  }

  async *values(): AsyncGenerator<Entry> {
    for await (const [, handle] of this.entries()) yield handle;
  }

  [Symbol.asyncIterator](): AsyncGenerator<[string, Entry]> {
    return this.entries();
  }
}

/** Create a fresh, empty in-memory directory handle (the workspace root for tests). */
export function createMemoryDirectory(name = 'workspace'): FileSystemDirectoryHandle {
  return new MemoryDirectoryHandle(name);
}

/**
 * Recursively dump a directory tree to a flat map of path -> UTF-8 text
 * content, for asserting on file contents in tests.
 */
export async function dumpTree(dir: FileSystemDirectoryHandle, base = ''): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for await (const [name, handle] of dir.entries()) {
    const path = base ? `${base}/${name}` : name;
    if (handle.kind === 'file') {
      const file = await (handle as FileSystemFileHandle).getFile();
      out[path] = await file.text();
    } else {
      Object.assign(out, await dumpTree(handle as FileSystemDirectoryHandle, path));
    }
  }
  return out;
}
