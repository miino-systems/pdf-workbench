Bundled copies of pdfjs-dist's `standard_fonts/` and `cmaps/` directories
(from node_modules/pdfjs-dist, matching the pinned version in package.json).

Served as plain static files (same origin, no CDN) and referenced by
`src/pdf/reader/document.ts` via `standardFontDataUrl`/`cMapUrl` so that
non-embedded fonts (esp. CJK) and Adobe CMaps resolve locally instead of
failing or reaching out to a remote host.

Vite has no built-in way to copy a whole directory tree as a build-time
asset transform (`new URL(file, import.meta.url)` only works per file), so
these are checked in under `public/` instead, which Vite copies to
`dist/pdfjs/` verbatim. Re-copy after bumping the pdfjs-dist version:

  rm -rf public/pdfjs/standard_fonts public/pdfjs/cmaps
  cp -r node_modules/pdfjs-dist/standard_fonts public/pdfjs/standard_fonts
  cp -r node_modules/pdfjs-dist/cmaps public/pdfjs/cmaps
