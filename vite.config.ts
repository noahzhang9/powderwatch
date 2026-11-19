import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Content-Security-Policy for the production build (GitHub Pages can't set
 * headers, so it ships as a meta tag). Only same-origin assets/data and the
 * Open-Meteo APIs are allowed. Not applied to the dev server, whose hot
 * reload relies on inline scripts.
 */
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "connect-src 'self' https://api.open-meteo.com https://ensemble-api.open-meteo.com https://single-runs-api.open-meteo.com",
  "style-src 'self' 'unsafe-inline'", // ECharts SVG and React inline styles
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }],
  };
}

// Dev/preview servers bind to loopback only.
export default defineConfig({
  base: './',
  plugins: [react(), tailwindcss(), cspMeta()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  preview: { host: '127.0.0.1', port: 4173, strictPort: true },
  test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
});
