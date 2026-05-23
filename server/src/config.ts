import { config as loadEnv } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

// The repo-root .env is shared by docker-compose and the server.
// This file lives at server/src (dev) or server/dist (built) — both are one
// directory below server/, so the repo root is always two levels up.
const here = dirname(fileURLToPath(import.meta.url));
loadEnv({ path: resolve(here, '../../.env') });

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

export type AiProvider = 'none' | 'rules' | 'claude' | 'ollama';

import { randomBytes } from 'node:crypto';

function ephemeralSecret(): string {
  // Last-resort: a per-process secret so the server still boots without
  // SESSION_SECRET set. Sessions don't survive a restart in that case, which
  // is acceptable for dev but logged as a warning in non-test runs.
  return randomBytes(32).toString('hex');
}

/**
 * Parse a 32-byte AES key supplied as base64 (preferred) or hex (also
 * accepted). Returns null when the env var is unset — attachment encryption
 * is opt-in for backward compatibility with existing plaintext files.
 */
function parseAttachmentKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // base64 first (32 bytes -> 44 chars w/ padding or 43 w/o).
  if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
    const b = Buffer.from(trimmed, 'base64');
    if (b.length === 32) return b;
  }
  if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
    return Buffer.from(trimmed, 'hex');
  }
  throw new Error(
    'ATTACHMENT_ENCRYPTION_KEY must be 32 bytes as base64 (44 chars) or hex (64 chars).',
  );
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  nodeEnv: process.env.NODE_ENV ?? 'development',
  databaseUrl: required('DATABASE_URL'),
  ai: {
    provider: (process.env.AI_PROVIDER ?? 'rules') as AiProvider,
    anthropicApiKey: process.env.ANTHROPIC_API_KEY ?? '',
    anthropicModel: process.env.ANTHROPIC_MODEL ?? 'claude-haiku-4-5',
    ollamaBaseUrl: process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434',
    ollamaModel: process.env.OLLAMA_MODEL ?? 'llama3.1',
  },
  // Filesystem root for attachment storage. Defaults to <repo>/data/attachments.
  attachmentsDir: process.env.ATTACHMENTS_DIR
    ? resolve(process.env.ATTACHMENTS_DIR)
    : resolve(here, '../../data/attachments'),
  // Encryption key for at-rest attachment encryption. Optional —
  // when unset, new uploads are stored in plaintext (the pre-Phase-5
  // behavior).
  attachmentEncryptionKey: parseAttachmentKey(
    process.env.ATTACHMENT_ENCRYPTION_KEY,
  ),
  // Optional: free key from https://www.eia.gov/opendata/register.php
  // Used by the fuel-price fetcher; manual prices win when set.
  eiaApiKey: process.env.EIA_API_KEY ?? '',
  auth: {
    // Used by @fastify/cookie to sign the session-id cookie. Required for
    // sessions to survive process restarts; an ephemeral one is generated
    // otherwise (dev convenience only). `||` (not `??`) so that an empty
    // string from docker-compose interpolation falls through the same as
    // unset — @fastify/cookie throws on an empty secret.
    sessionSecret: process.env.SESSION_SECRET || ephemeralSecret(),
    sessionSecretEphemeral: !process.env.SESSION_SECRET,
    sessionMaxAgeMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    // Set `secure: true` on cookies when a TLS-terminating proxy is in
    // front. Defaults to inferring from NODE_ENV — only active in production.
    cookieSecure:
      process.env.COOKIE_SECURE === '1' ||
      process.env.NODE_ENV === 'production',
  },
};
