/**
 * Environment-aware loader for `pdfjs-dist`.
 *
 * pdfjs-dist 6.x ships two ESM builds:
 *  - `pdfjs-dist` (the "modern" build) — targets current browsers and is
 *    what `vite.config.ts` bundles into the `pdfjs` chunk for the app.
 *  - `pdfjs-dist/legacy/build/pdf.mjs` — for older/non-browser JS engines.
 *
 * The modern build relies on runtime features (e.g. `Promise.try`) that are
 * only available starting Node 24; under Node 22 (which `vitest` runs on in
 * this project) calling `getDocument()` on the modern build throws inside
 * its worker-message handling. The legacy build works fine under Node 22
 * and is functionally equivalent (same public types — see
 * `legacy/build/pdf.d.mts`, which just re-exports `pdfjs-dist`'s types).
 *
 * This module is the single place that decides which build to load, so the
 * rest of `pdf/reader` can stay written against one API surface. The
 * browser bundle only ever reaches the `import('pdfjs-dist')` branch: the
 * `typeof window === 'undefined'` branch (and therefore the legacy build)
 * is never taken at runtime in a browser, so Rollup/Vite never has a reason
 * to load that chunk there.
 */

/** The shape both builds expose (they are structurally/nominally identical). */
export type PdfjsModule = typeof import('pdfjs-dist');

let modulePromise: Promise<PdfjsModule> | undefined;

/** Resolve the pdfjs-dist module appropriate for the current environment. Cached after the first call. */
export function getPdfjs(): Promise<PdfjsModule> {
  if (!modulePromise) {
    modulePromise =
      typeof window === 'undefined'
        ? import('pdfjs-dist/legacy/build/pdf.mjs')
        : import('pdfjs-dist');
  }
  return modulePromise;
}
