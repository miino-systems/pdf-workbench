import { getPdfjs } from './pdfjs.js';

/**
 * Wires up the PDF.js worker so it is loaded from the app's own bundle
 * (via Vite, from `node_modules`) instead of a CDN — see architecture
 * principle D ("no network I/O", "everything bundled").
 *
 * `new URL('pdfjs-dist/build/pdf.worker.min.mjs', import.meta.url)` is the
 * literal pattern Vite/Rollup statically recognises and turns into a copied,
 * fingerprinted asset (`dist/assets/pdf.worker-*.mjs`); it must stay written
 * exactly like this (not built from a variable) for the bundler to pick it
 * up. `npx vite build` confirms the file lands in `dist/assets/`.
 *
 * In Node (vitest, SSR, ...) there is no `Worker` global and no bundler
 * pass, so this is a no-op: PDF.js transparently falls back to an
 * in-process "fake worker" when no workerSrc/workerPort is configured.
 *
 * Idempotent and safe to call from multiple places (e.g. app startup and
 * `loadPdfDocument`); the underlying work only happens once.
 */
let configuredPromise: Promise<void> | undefined;

export function configurePdfjsWorker(): Promise<void> {
  if (typeof window === 'undefined') {
    return Promise.resolve();
  }
  if (!configuredPromise) {
    configuredPromise = getPdfjs().then((pdfjs) => {
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
    });
  }
  return configuredPromise;
}
