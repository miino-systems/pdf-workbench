/**
 * Feature detection and permission helpers for the File System Access API.
 * Every function here guards its `window`/`navigator` access so importing
 * this module under Node (vitest) never throws.
 */

/** True when the File System Access API (`showDirectoryPicker`) is available. */
export function isFileSystemAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

/** True when the Local Font Access API (`queryLocalFonts`) is available. */
export function isLocalFontAccessSupported(): boolean {
  return typeof window !== 'undefined' && 'queryLocalFonts' in window;
}

/**
 * Prompt the user to pick a workspace directory with read-write access.
 * Throws in environments without File System Access support — callers
 * should check {@link isFileSystemAccessSupported} first.
 */
export async function pickWorkspaceDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!isFileSystemAccessSupported()) {
    throw new Error('File System Access API is not supported in this browser.');
  }
  const picker = (
    window as unknown as {
      showDirectoryPicker: (opts: { mode: string; id: string }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker;
  return picker({ mode: 'readwrite', id: 'pdf-workbench' });
}

/** Handle types that expose the (still experimental) permission API. */
interface PermissionCapableHandle {
  queryPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: 'read' | 'readwrite' }) => Promise<PermissionState>;
}

/**
 * Ensure the given handle has at least `mode` permission, requesting it from
 * the user if necessary. Returns `true` once granted, `false` if denied.
 * Browsers that don't implement the permission methods are assumed to already
 * have implicit permission (handle came from a picker in the same session).
 */
export async function ensurePermission(
  handle: FileSystemDirectoryHandle,
  mode: 'read' | 'readwrite'
): Promise<boolean> {
  const capable = handle as unknown as PermissionCapableHandle;
  if (typeof capable.queryPermission !== 'function' || typeof capable.requestPermission !== 'function') {
    return true;
  }
  const current = await capable.queryPermission({ mode });
  if (current === 'granted') return true;
  const requested = await capable.requestPermission({ mode });
  return requested === 'granted';
}
