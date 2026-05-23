import { request, type FullConfig } from '@playwright/test';
import { fileURLToPath } from 'node:url';

/**
 * Runs once before any spec — drives the first-boot setup flow so every
 * test starts already authenticated. The resulting cookie is persisted to
 * storage-state.json which Playwright loads into each browser context.
 */
export const E2E_PASSWORD = 'e2e-test-password-correct-horse';
export const STORAGE_STATE_PATH = fileURLToPath(
  new URL('./storage-state.json', import.meta.url),
);

export default async function globalSetup(config: FullConfig): Promise<void> {
  // The first project's baseURL points at the running web server.
  const baseURL = config.projects[0]!.use.baseURL!;
  const ctx = await request.newContext({ baseURL });

  // Setup is idempotent at this point — setup-db.mjs truncated everything
  // before the API booted, so no user exists yet.
  const res = await ctx.post('/api/auth/setup', {
    data: { password: E2E_PASSWORD },
  });
  if (!res.ok()) {
    throw new Error(
      `e2e setup failed (${res.status()}): ${await res.text()}`,
    );
  }

  await ctx.storageState({ path: STORAGE_STATE_PATH });
  await ctx.dispose();
}
