import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// Production-only Content Security Policy. The dev server needs inline scripts
// for React Fast Refresh, so the policy is injected at build time only.
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' http: https: ws:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
].join('; ');

function csp(): Plugin {
  return {
    name: 'nib-csp',
    apply: 'build',
    transformIndexHtml(html) {
      return html.replace(
        '<meta charset="UTF-8" />',
        `<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="${CSP}" />`,
      );
    },
  };
}

// `base: './'` lets the production build load from file:// inside Electron.
export default defineConfig({
  base: './',
  plugins: [react(), csp()],
  server: { port: 5173 },
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
});
