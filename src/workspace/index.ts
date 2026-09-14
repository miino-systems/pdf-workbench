/**
 * Public API of the `workspace/` module. UI and other modules should import
 * from `@/workspace` rather than reaching into individual files.
 */

export {
  isFileSystemAccessSupported,
  isLocalFontAccessSupported,
  pickWorkspaceDirectory,
  ensurePermission,
} from './support';

export { WorkspaceFS, normalizeWorkspacePath } from './fs';

export {
  createDefaultWorkspaceConfig,
  createDefaultStampsConfig,
  createDefaultPreflightConfig,
  createDefaultJobsConfig,
  DEFAULT_GITIGNORE,
} from './defaults';

export {
  isWorkspaceInitialized,
  initializeWorkspace,
  loadWorkspace,
  saveWorkspaceConfig,
  saveStampsConfig,
  savePreflightConfig,
  saveJobsConfig,
  saveAll,
} from './store';
export type { WorkspaceState } from './store';

export { rememberWorkspaceHandle, listRecentWorkspaces, forgetWorkspace } from './recent';
export type { RecentWorkspace } from './recent';

export { joinPath, dirname, basename, stripExtension, outputPathFor, isSourcePath } from './paths';
