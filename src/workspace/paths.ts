import type { WorkspaceConfig } from '@/core/types';

/**
 * Path helpers for workspace-relative POSIX paths (e.g. `papers/paper.pdf`).
 * These are pure string operations — no filesystem access.
 */

/** Join path segments with `/`, collapsing empty segments and `./`. */
export function joinPath(...segments: string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    if (!segment) continue;
    for (const raw of segment.split('/')) {
      if (raw === '' || raw === '.') continue;
      parts.push(raw);
    }
  }
  return parts.join('/');
}

/** Directory portion of a path (`''` for a top-level file). */
export function dirname(path: string): string {
  const clean = joinPath(path);
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? '' : clean.slice(0, idx);
}

/** File name portion of a path (last segment). */
export function basename(path: string): string {
  const clean = joinPath(path);
  const idx = clean.lastIndexOf('/');
  return idx === -1 ? clean : clean.slice(idx + 1);
}

/** Remove the last `.ext` from a file name / path (no-op if there is none). */
export function stripExtension(path: string): string {
  const base = basename(path);
  const dir = dirname(path);
  const idx = base.lastIndexOf('.');
  const stripped = idx <= 0 ? base : base.slice(0, idx);
  return dir ? `${dir}/${stripped}` : stripped;
}

/**
 * Compute the output path for a source PDF under `papers/`, e.g.
 * `papers/report.pdf` -> `output/report_stamped.pdf` (suffix from config).
 * With `outputName` (a per-file override from `sequence.json`) the result
 * is `output/<outputName>` with `.pdf` appended when missing; the name is
 * always resolved *inside* the output directory (`..` segments are dropped).
 */
export function outputPathFor(sourcePath: string, config: WorkspaceConfig, outputName?: string): string {
  const custom = outputName?.trim();
  if (custom) {
    const cleaned = custom
      .replace(/\\/g, '/')
      .split('/')
      .filter((seg) => seg !== '' && seg !== '.' && seg !== '..')
      .join('/');
    if (cleaned) {
      const withExt = /\.pdf$/i.test(cleaned) ? cleaned : `${cleaned}.pdf`;
      return joinPath(config.directories.output, withExt);
    }
  }
  const base = basename(stripExtension(sourcePath));
  return joinPath(config.directories.output, `${base}${config.output.suffix}.pdf`);
}

/** True when `path` lies inside the configured source (`papers/`) directory. */
export function isSourcePath(path: string, config: WorkspaceConfig): boolean {
  const papers = joinPath(config.directories.papers);
  const clean = joinPath(path);
  return clean === papers || clean.startsWith(`${papers}/`);
}
