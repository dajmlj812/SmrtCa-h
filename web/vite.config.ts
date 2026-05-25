import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The API proxy target and dev-server port are env-driven so that the
// end-to-end test harness can run an isolated stack on different ports
// without colliding with a normal `npm run dev` session.
const apiProxyTarget = process.env.VITE_API_PROXY ?? 'http://localhost:4000';
const port = Number(process.env.VITE_PORT ?? 5173);

// 0.18.2 — inject the package version at build time so the
// sidebar/auth footers stop drifting from the actual release.
const pkg = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf-8'),
) as { version: string };

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  server: {
    port,
    proxy: {
      '/api': apiProxyTarget,
    },
    fs: {
      // Allow importing the legal markdown drafts from ../docs/legal/.
      // The .md files are the single source of truth (what the
      // reviewing attorney edits); the React pages import them via
      // ?raw so we never have to hand-sync content.
      allow: ['..'],
    },
  },
});
