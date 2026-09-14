/**
 * `PageNumberLayer.template` placeholder substitution.
 */

export interface PageNumberContext {
  /** 1-based number shown for this occurrence (already accounts for startAt). */
  page: number;
  /** Total page count shown for `{pages}` (already accounts for totalPagesOverride). */
  pages: number;
  /** Workspace-relative source file path or name, for `{file}`. */
  file?: string;
}

/**
 * Replace `{page}`, `{pages}` and `{file}` placeholders in `template`.
 * `{file}` is replaced with the file name without its extension. Unknown
 * placeholders (e.g. `{foo}`) are left untouched.
 */
export function renderPageNumber(template: string, ctx: PageNumberContext): string {
  return template.replace(/\{(page|pages|file)\}/g, (_match, key: string) => {
    switch (key) {
      case 'page':
        return String(ctx.page);
      case 'pages':
        return String(ctx.pages);
      case 'file':
        return ctx.file !== undefined ? stripExtension(ctx.file) : '{file}';
      default:
        return _match;
    }
  });
}

function stripExtension(fileName: string): string {
  const base = fileName.split('/').pop() ?? fileName;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}
