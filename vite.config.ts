import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadEnv } from 'vite';
import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { LOCAL_SNAPSHOT_DIR, SNAPSHOT_DIR, SNAPSHOT_FILE_RE, SNAPSHOT_MANIFEST, WPC_FILE_RE } from './src/lib/cache.ts';

const OPEN_METEO = 'https://api.open-meteo.com https://ensemble-api.open-meteo.com https://single-runs-api.open-meteo.com';

/**
 * Content-Security-Policy for the production build (GitHub Pages can't set
 * headers, so it ships as a meta tag). Only same-origin assets/data and the
 * Open-Meteo APIs are allowed. Not applied to the dev server, whose hot
 * reload relies on inline scripts. Snapshot-only builds drop the Open-Meteo
 * hosts, so the browser itself blocks any live call.
 */
const csp = (snapshotOnly: boolean) => [
  "default-src 'self'",
  "script-src 'self'",
  `connect-src 'self'${snapshotOnly ? '' : ` ${OPEN_METEO}`}`,
  "style-src 'self' 'unsafe-inline'", // ECharts SVG and React inline styles
  "img-src 'self' data:",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function cspMeta(snapshotOnly: boolean): Plugin {
  return {
    name: 'csp-meta',
    apply: 'build',
    transformIndexHtml: () => [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(snapshotOnly) }, injectTo: 'head-prepend' }],
  };
}

/**
 * Snapshot-only builds: copy the local forecast snapshot (.cache/fc/, written by
 * `npm run snapshot`) into the build output, since `vite build` empties dist/.
 * Build-only, and inactive unless VITE_SNAPSHOT_ONLY=1. Copies only the manifest
 * and content-addressed snapshot files (Open-Meteo responses and the WPC chances file).
 */
function localSnapshot(snapshotOnly: boolean): Plugin {
  let root = '';
  let outDir = '';
  return {
    name: 'local-snapshot',
    apply: (_config, { command }) => command === 'build' && snapshotOnly,
    configResolved(config) {
      root = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      const src = resolve(root, LOCAL_SNAPSHOT_DIR);
      if (!existsSync(join(src, SNAPSHOT_MANIFEST))) {
        this.warn(`no local snapshot in ${LOCAL_SNAPSHOT_DIR} (run \`npm run snapshot\` once); every forecast will show as not in the snapshot`);
        return;
      }
      const dest = join(outDir, SNAPSHOT_DIR);
      mkdirSync(dest, { recursive: true });
      const files = readdirSync(src).filter((f) => f === SNAPSHOT_MANIFEST || SNAPSHOT_FILE_RE.test(f) || WPC_FILE_RE.test(f));
      for (const f of files) copyFileSync(join(src, f), join(dest, f));
      this.info(`copied ${files.length} snapshot files from ${LOCAL_SNAPSHOT_DIR} to ${join(outDir, SNAPSHOT_DIR)}`);
    },
  };
}

// Dev/preview servers bind to loopback only.
export default defineConfig(({ mode }) => {
  const snapshotOnly = loadEnv(mode, process.cwd(), 'VITE_').VITE_SNAPSHOT_ONLY === '1';
  return {
    base: './',
    plugins: [react(), tailwindcss(), cspMeta(snapshotOnly), localSnapshot(snapshotOnly)],
    server: { host: '127.0.0.1', port: 5173, strictPort: true },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true },
    test: { environment: 'node', include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'] },
  };
});
