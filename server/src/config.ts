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
};
