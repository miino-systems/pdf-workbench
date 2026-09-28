/**
 * Public API of the `workspace/` module. UI and other modules should import
 * from `@/workspace` rather than reaching into individual files.
 */

export {
  isFileSystemAccessSupported,
  isLocalFontAccessSupported,
  pickWorkspaceDirectory,
  ensurePermission,
  hasPermission,
} from './support';

export { WorkspaceFS, normalizeWorkspacePath } from './fs';

export {
  createDefaultWorkspaceConfig,
  createDefaultStampsConfig,
  createDefaultPreflightConfig,
  createDefaultJobsConfig,
  createDefaultSequenceConfig,
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
  saveSequenceConfig,
  saveAll,
  stripSchemaKey,
  WORKSPACE_SCHEMA_URL,
  STAMPS_SCHEMA_URL,
  PREFLIGHT_SCHEMA_URL,
  JOBS_SCHEMA_URL,
  SEQUENCE_SCHEMA_URL,
} from './store';
export type { WorkspaceState } from './store';

export { rememberWorkspaceHandle, listRecentWorkspaces, forgetWorkspace } from './recent';
export type { RecentWorkspace } from './recent';

export { joinPath, dirname, basename, stripExtension, outputPathFor, preflightCopyPathFor, isSourcePath } from './paths';
