import { createStore, del, set, values, type UseStore } from 'idb-keyval';

/** A recently-opened workspace, as stored in IndexedDB. */
export interface RecentWorkspace {
  name: string;
  handle: FileSystemDirectoryHandle;
  lastOpened: number; // epoch ms
}

const DB_NAME = 'pdf-workbench';
const STORE_NAME = 'handles';
const MAX_RECENT = 10;

let store: UseStore | undefined;

/**
 * Lazily create the idb-keyval store. Returns `undefined` when IndexedDB is
 * not available (e.g. under vitest/Node), so callers degrade gracefully
 * instead of throwing.
 */
function getStore(): UseStore | undefined {
  if (typeof indexedDB === 'undefined') return undefined;
  if (!store) store = createStore(DB_NAME, STORE_NAME);
  return store;
}

/** Remember (or refresh) a workspace directory handle, keyed by its name. */
export async function rememberWorkspaceHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  const s = getStore();
  if (!s) return;
  const record: RecentWorkspace = { name: handle.name, handle, lastOpened: Date.now() };
  await set(handle.name, record, s);
}

/** List remembered workspaces, most recently opened first (max 10). */
export async function listRecentWorkspaces(): Promise<RecentWorkspace[]> {
  const s = getStore();
  if (!s) return [];
  const all = await values<RecentWorkspace>(s);
  return all.sort((a, b) => b.lastOpened - a.lastOpened).slice(0, MAX_RECENT);
}

/** Forget a remembered workspace by name. */
export async function forgetWorkspace(name: string): Promise<void> {
  const s = getStore();
  if (!s) return;
  await del(name, s);
}
