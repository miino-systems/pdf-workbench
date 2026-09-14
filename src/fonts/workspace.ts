/**
 * Listing `.ttf`/`.otf` font files stored inside the workspace's `fonts/`
 * directory. Takes the workspace listing function as a parameter (rather
 * than importing `WorkspaceFS`) to avoid coupling to the `workspace/`
 * module, which is developed in parallel — see task instructions.
 */
import type { WorkspaceFileEntry } from '@/core/types';

/** Structural shape of the subset of `WorkspaceFS` this module needs. */
export interface WorkspaceFontLister {
  list(
    dirPath: string,
    opts?: { extensions?: string[]; recursive?: boolean },
  ): Promise<WorkspaceFileEntry[]>;
}

const FONT_EXTENSIONS = ['.ttf', '.otf'];

/** List `.ttf`/`.otf` files in `fontsDir` (typically `"fonts"`). */
export async function listWorkspaceFonts(
  fs: WorkspaceFontLister,
  fontsDir: string,
): Promise<WorkspaceFileEntry[]> {
  return fs.list(fontsDir, { extensions: FONT_EXTENSIONS });
}
