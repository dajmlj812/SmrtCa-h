import { defineConfig, devices } from '@playwright/test';
import { config as loadEnv } from 'dotenv';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Derive the isolated e2e database URL from the repo-root .env credentials.
// The database itself is created by `setup-db.mjs`, which the `test` script
// runs before Playwright starts the API server.
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });
const baseDbUrl =
  process.env.DATABASE_URL ??
  'postgres://smrtcash:smrtcash_dev_pw@localhost:5432/smrtcash';
const e2eDatabaseUrl = baseDbUrl.replace(/\/[^/?]+(\?|$)/, '/smrtcash_e2e$1');

// Keep e2e attachments in a temp directory so they never mix with the dev
// server's `<repo>/data/attachments` files. Cleaned by setup-db.mjs.
const e2eAttachmentsDir = join(tmpdir(), 'smrtcash-e2e-attachments');
process.env.E2E_ATTACHMENTS_DIR = e2eAttachmentsDir;

// The e2e stack runs on its own ports so it never collides with a normal
// `npm run dev` session (API 4000 / web 5173).
const API_PORT = '4100';
const WEB_PORT = '5174';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { open: 'never' }]],
  // global-setup drives /api/auth/setup once and saves the cookie so all
  // specs start already authenticated. Without this, every spec would
  // bounce to the setup page.
  globalSetup: fileURLToPath(new URL('./global-setup.ts', import.meta.url)),
  use: {
    baseURL: `http://localhost:${WEB_PORT}`,
    trace: 'on-first-retry',
    storageState: fileURLToPath(
      new URL('./storage-state.json', import.meta.url),
    ),
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: [
    {
      command: 'npm run dev --prefix ../server',
      env: {
        DATABASE_URL: e2eDatabaseUrl,
        PORT: API_PORT,
        NODE_ENV: 'test',
        ATTACHMENTS_DIR: e2eAttachmentsDir,
      },
      url: `http://localhost:${API_PORT}/api/health`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: 'npm run dev --prefix ../web',
      env: {
        VITE_API_PROXY: `http://localhost:${API_PORT}`,
        VITE_PORT: WEB_PORT,
      },
      url: `http://localhost:${WEB_PORT}`,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
