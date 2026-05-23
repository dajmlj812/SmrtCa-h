import { defineConfig } from 'vitest/config';
import { config as loadEnv } from 'dotenv';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Pull DB credentials from the repo-root .env, then redirect every test at an
// isolated `smrtcash_test` database so the suite never touches real data.
loadEnv({ path: fileURLToPath(new URL('../.env', import.meta.url)) });

const baseUrl =
  process.env.DATABASE_URL ??
  'postgres://smrtcash:smrtcash_dev_pw@localhost:5432/smrtcash';
const testDatabaseUrl = baseUrl.replace(/\/[^/?]+(\?|$)/, '/smrtcash_test$1');
const testAttachmentsDir = join(tmpdir(), 'smrtcash-test-attachments');

// Set on the current process so BOTH the global-setup step (main process)
// and the forked test workers see them. Attachments and the DB both have to
// be redirected — neither should ever land on a real path.
process.env.DATABASE_URL = testDatabaseUrl;
process.env.NODE_ENV = 'test';
process.env.ATTACHMENTS_DIR = testAttachmentsDir;
// Drop the aggregate-upload cap to 1 MB so the 413 path is exercisable
// without shipping 100 MB of buffers through app.inject.
const testMaxRequestBytes = String(1024 * 1024);
process.env.ATTACHMENTS_MAX_REQUEST_BYTES = testMaxRequestBytes;
// Deterministic session-cookie signature across the suite.
const testSessionSecret =
  process.env.SESSION_SECRET ??
  'test-session-secret-not-for-production-use-please';
process.env.SESSION_SECRET = testSessionSecret;
// Deterministic 32-byte AES key (hex) so attachment encryption is exercised
// in the suite. NOT a real secret; obviously safe to commit.
const testAttachmentKey =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.ATTACHMENT_ENCRYPTION_KEY = testAttachmentKey;

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    env: {
      DATABASE_URL: testDatabaseUrl,
      NODE_ENV: 'test',
      ATTACHMENTS_DIR: testAttachmentsDir,
      ATTACHMENTS_MAX_REQUEST_BYTES: testMaxRequestBytes,
      SESSION_SECRET: testSessionSecret,
      ATTACHMENT_ENCRYPTION_KEY: testAttachmentKey,
    },
    // DB-backed tests share one database and truncate between tests, so
    // test files must run serially, not in parallel.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
  },
});
