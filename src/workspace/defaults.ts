import { DEFAULT_DIRECTORIES, WORKSPACE_FORMAT_VERSION } from '@/core/types';
import type { JobsConfig, PreflightConfig, StampsConfig, WorkspaceConfig } from '@/core/types';

/**
 * Build a fresh `WorkspaceConfig` for a newly initialised workspace.
 * `createdAt` uses the current time (ISO-8601, UTC).
 */
export function createDefaultWorkspaceConfig(name: string): WorkspaceConfig {
  return {
    version: WORKSPACE_FORMAT_VERSION,
    name,
    createdAt: new Date().toISOString(),
    directories: { ...DEFAULT_DIRECTORIES },
    output: { suffix: '_stamped' },
    history: { hashChain: false },
  };
}

/**
 * Build a fresh, empty `StampsConfig`.
 *
 * Note: built-in stamp templates (DRAFT, Confidential, Page Number, CC BY
 * 4.0, ...) live in `src/stamps` (`BUILTIN_STAMP_TEMPLATES`), which this
 * module intentionally does not depend on. The stamps module is responsible
 * for seeding `definitions` from those templates when appropriate (e.g. on
 * first workspace initialisation) — `workspace/` stays dependency-free.
 */
export function createDefaultStampsConfig(): StampsConfig {
  return {
    version: WORKSPACE_FORMAT_VERSION,
    definitions: [],
    instances: [],
  };
}

/**
 * Build a fresh `PreflightConfig`: A4 portrait, 20/20/18/18 mm margins
 * (top/bottom/left/right), all checks disabled.
 */
export function createDefaultPreflightConfig(): PreflightConfig {
  return {
    version: WORKSPACE_FORMAT_VERSION,
    id: 'default',
    name: 'Default',
    page: {
      size: 'A4',
      orientation: 'portrait',
      tolerance: 2,
    },
    margins: {
      top: 20,
      bottom: 20,
      left: 18,
      right: 18,
      unit: 'mm',
    },
    pages: {},
    checks: {
      marginText: false,
      marginRaster: false,
      stampCollision: false,
    },
  };
}

/** Build a fresh, empty `JobsConfig`. */
export function createDefaultJobsConfig(): JobsConfig {
  return {
    version: WORKSPACE_FORMAT_VERSION,
    jobs: [],
  };
}

/**
 * Default `.gitignore` content written on workspace initialisation.
 * `papers/`, `output/` and `preview/` (source PDFs and generated files) are
 * excluded by default; `assets/` and `fonts/` are left to the user's
 * discretion (commented out) since they may want to version stamp images /
 * embedded fonts alongside the rest of the project.
 */
export const DEFAULT_GITIGNORE = `# PDF Workbench: source PDFs and generated output should not be committed.
# The workspace itself (this directory) is the source of truth, not Git.
papers/
output/
preview/

# 必要に応じて
# assets/
# fonts/
`;
