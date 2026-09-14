import { WORKBENCH_FILES } from '@/core/types';
import type { JobsConfig, PreflightConfig, StampsConfig, WorkspaceConfig } from '@/core/types';
import {
  createDefaultJobsConfig,
  createDefaultPreflightConfig,
  createDefaultStampsConfig,
  createDefaultWorkspaceConfig,
  DEFAULT_GITIGNORE,
} from './defaults';
import { WorkspaceFS } from './fs';

/** In-memory view of a loaded workspace: the FS handle plus its 4 config files. */
export interface WorkspaceState {
  fs: WorkspaceFS;
  config: WorkspaceConfig;
  stamps: StampsConfig;
  preflight: PreflightConfig;
  jobs: JobsConfig;
  /** Non-fatal issues encountered while loading (missing/corrupt files -> defaults used). */
  warnings: string[];
}

/** Pretty-print JSON (2 spaces) with a trailing newline, matching the on-disk convention. */
function toPrettyJson(data: unknown): string {
  return `${JSON.stringify(data, null, 2)}\n`;
}

/** True when this directory already holds a `.pdf-workbench/workspace.json`. */
export async function isWorkspaceInitialized(fs: WorkspaceFS): Promise<boolean> {
  return fs.exists(WORKBENCH_FILES.workspace);
}

/** Lines that must be present in `.gitignore` for a properly configured workspace. */
const REQUIRED_GITIGNORE_LINES = ['papers/', 'output/', 'preview/'];

/**
 * Ensure `.gitignore` exists and contains the required ignore lines.
 * Never overwrites an existing file wholesale: if it's missing, the default
 * template is written; if it exists but lacks some required lines, only
 * those are appended.
 */
async function ensureGitignore(fs: WorkspaceFS): Promise<void> {
  if (!(await fs.exists('.gitignore'))) {
    await fs.writeText('.gitignore', DEFAULT_GITIGNORE);
    return;
  }
  const existing = await fs.readText('.gitignore');
  const existingLines = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = REQUIRED_GITIGNORE_LINES.filter((line) => !existingLines.has(line));
  if (missing.length === 0) return;
  const needsNewline = existing.length > 0 && !existing.endsWith('\n');
  const addition = `${needsNewline ? '\n' : ''}\n# Added by PDF Workbench\n${missing.join('\n')}\n`;
  await fs.writeText('.gitignore', existing + addition);
}

/**
 * Initialise a fresh workspace: creates the standard directory tree, writes
 * the 4 default config JSON files, an empty `events.jsonl`, and `.gitignore`.
 */
export async function initializeWorkspace(fs: WorkspaceFS, opts?: { name?: string }): Promise<WorkspaceState> {
  const config = createDefaultWorkspaceConfig(opts?.name ?? fs.name);
  const stamps = createDefaultStampsConfig();
  const preflight = createDefaultPreflightConfig();
  const jobs = createDefaultJobsConfig();

  // Directory tree.
  const dirs = [
    config.directories.papers,
    config.directories.output,
    config.directories.preview,
    config.directories.assets,
    config.directories.fonts,
    WORKBENCH_FILES.reportsDir,
    WORKBENCH_FILES.snapshotsDir, // implies .pdf-workbench/history too
  ];
  for (const dir of dirs) {
    await fs.mkdirp(dir);
  }

  // Config files.
  await fs.writeText(WORKBENCH_FILES.workspace, toPrettyJson(config));
  await fs.writeText(WORKBENCH_FILES.stamps, toPrettyJson(stamps));
  await fs.writeText(WORKBENCH_FILES.preflight, toPrettyJson(preflight));
  await fs.writeText(WORKBENCH_FILES.jobs, toPrettyJson(jobs));

  // Append-only history log: create empty if it doesn't already exist.
  if (!(await fs.exists(WORKBENCH_FILES.events))) {
    await fs.writeText(WORKBENCH_FILES.events, '');
  }

  await ensureGitignore(fs);

  return { fs, config, stamps, preflight, jobs, warnings: [] };
}

/** Read one JSON config file, falling back to `fallback()` when missing or corrupt. */
async function loadJsonFile<T>(
  fs: WorkspaceFS,
  path: string,
  fallback: () => T,
  warnings: string[]
): Promise<T> {
  if (!(await fs.exists(path))) {
    warnings.push(`${path} not found; using defaults.`);
    return fallback();
  }
  try {
    const text = await fs.readText(path);
    return JSON.parse(text) as T;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`${path} could not be parsed (${message}); using defaults.`);
    return fallback();
  }
}

/**
 * Load a workspace's 4 config files. Missing or corrupt files fall back to
 * defaults and are recorded in `WorkspaceState.warnings`.
 */
export async function loadWorkspace(fs: WorkspaceFS): Promise<WorkspaceState> {
  const warnings: string[] = [];
  const config = await loadJsonFile(fs, WORKBENCH_FILES.workspace, () => createDefaultWorkspaceConfig(fs.name), warnings);
  const stamps = await loadJsonFile(fs, WORKBENCH_FILES.stamps, createDefaultStampsConfig, warnings);
  const preflight = await loadJsonFile(fs, WORKBENCH_FILES.preflight, createDefaultPreflightConfig, warnings);
  const jobs = await loadJsonFile(fs, WORKBENCH_FILES.jobs, createDefaultJobsConfig, warnings);
  return { fs, config, stamps, preflight, jobs, warnings };
}

export async function saveWorkspaceConfig(fs: WorkspaceFS, config: WorkspaceConfig): Promise<void> {
  await fs.writeText(WORKBENCH_FILES.workspace, toPrettyJson(config));
}

export async function saveStampsConfig(fs: WorkspaceFS, stamps: StampsConfig): Promise<void> {
  await fs.writeText(WORKBENCH_FILES.stamps, toPrettyJson(stamps));
}

export async function savePreflightConfig(fs: WorkspaceFS, preflight: PreflightConfig): Promise<void> {
  await fs.writeText(WORKBENCH_FILES.preflight, toPrettyJson(preflight));
}

export async function saveJobsConfig(fs: WorkspaceFS, jobs: JobsConfig): Promise<void> {
  await fs.writeText(WORKBENCH_FILES.jobs, toPrettyJson(jobs));
}

/** Persist all 4 config files from a `WorkspaceState` in one call. */
export async function saveAll(state: WorkspaceState): Promise<void> {
  await saveWorkspaceConfig(state.fs, state.config);
  await saveStampsConfig(state.fs, state.stamps);
  await savePreflightConfig(state.fs, state.preflight);
  await saveJobsConfig(state.fs, state.jobs);
}
