import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// `base` must match the GitHub Pages sub-path (https://<user>.github.io/<repo>/).
// Override with VITE_BASE=/ for a root-hosted static server.
export default defineConfig({
  base: process.env.VITE_BASE ?? '/pdf-workbench/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    // Everything is bundled locally: no CDN, no runtime fetch of user data.
    rollupOptions: {
      output: {
        manualChunks: {
          pdfjs: ['pdfjs-dist'],
          pdflib: ['pdf-lib', '@pdf-lib/fontkit'],
        },
      },
    },
  },
  worker: { format: 'es' },
});
