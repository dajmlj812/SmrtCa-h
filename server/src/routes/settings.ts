import type { FastifyInstance } from 'fastify';
import {
  KNOWN_SETTINGS,
  type SettingKey,
  applyToConfig,
  clearSetting,
  getDbValue,
  isKnownSetting,
  maskValue,
  setDbValue,
  settingMeta,
} from '../domain/settings.js';

interface PublicSettingRow {
  key: string;
  label: string;
  is_secret: boolean;
  restart_required: boolean;
  /** Display-safe representation. For secrets this is the masked tail. */
  display_value: string;
  /** True when the DB has a value (vs. just falling back to env). */
  configured_in_gui: boolean;
  /** True when process.env carries a non-empty value for this key. */
  env_fallback_present: boolean;
  updated_at: string | null;
}

const AI_PROVIDERS = ['none', 'rules', 'claude', 'ollama'];

async function buildRow(meta: (typeof KNOWN_SETTINGS)[number]): Promise<PublicSettingRow> {
  const dbValue = await getDbValue(meta.key);
  const envValue = process.env[meta.key] ?? '';
  const effective = dbValue !== null && dbValue !== '' ? dbValue : envValue;
  return {
    key: meta.key,
    label: meta.label,
    is_secret: meta.isSecret,
    restart_required: meta.restartRequired,
    display_value: meta.isSecret ? maskValue(effective) : effective,
    configured_in_gui: dbValue !== null && dbValue !== '',
    env_fallback_present: envValue !== '',
    updated_at: null,
  };
}

export async function settingsRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/settings', async () => {
    const rows = await Promise.all(KNOWN_SETTINGS.map((m) => buildRow(m)));
    return { settings: rows };
  });

  app.put<{ Params: { key: string } }>(
    '/api/settings/:key',
    async (req, reply) => {
      const key = req.params.key.toUpperCase();
      if (!isKnownSetting(key)) {
        return reply.code(400).send({ error: `Unknown setting: ${key}` });
      }
      const body = (req.body ?? {}) as { value?: unknown };
      if (typeof body.value !== 'string') {
        return reply.code(400).send({ error: 'value must be a string' });
      }
      const value = body.value.trim();
      if (value === '') {
        return reply
          .code(400)
          .send({ error: 'Use DELETE /api/settings/:key to clear, not an empty PUT' });
      }
      const meta = settingMeta(key);

      // Per-key sanity checks.
      if (key === 'AI_PROVIDER' && !AI_PROVIDERS.includes(value)) {
        return reply
          .code(400)
          .send({ error: `AI_PROVIDER must be one of: ${AI_PROVIDERS.join(', ')}` });
      }
      if (key === 'ATTACHMENT_ENCRYPTION_KEY') {
        const trimmed = value;
        // Check hex first — it's the more specific format (exactly 64 chars
        // of [0-9a-f]). Base64 chars are a superset, so a 64-char hex
        // value also matches the base64 regex but decodes to 48 bytes
        // and would falsely fail a base64-first check.
        const looksHex = /^[0-9a-fA-F]{64}$/.test(trimmed);
        if (looksHex) {
          // 64 hex chars = 32 bytes, validated by the regex.
        } else if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
          const b = Buffer.from(trimmed, 'base64');
          if (b.length !== 32) {
            return reply.code(400).send({
              error: 'ATTACHMENT_ENCRYPTION_KEY base64 must decode to 32 bytes',
            });
          }
        } else {
          return reply.code(400).send({
            error:
              'ATTACHMENT_ENCRYPTION_KEY must be 32 bytes encoded as base64 (~44 chars) or hex (64 chars)',
          });
        }
      }
      if (key === 'SESSION_SECRET' && value.length < 16) {
        return reply
          .code(400)
          .send({ error: 'SESSION_SECRET must be at least 16 characters' });
      }

      await setDbValue(key, value);
      applyToConfig(key, value);
      return {
        ok: true,
        restart_required: meta.restartRequired,
      };
    },
  );

  app.delete<{ Params: { key: string } }>(
    '/api/settings/:key',
    async (req, reply) => {
      const key = req.params.key.toUpperCase();
      if (!isKnownSetting(key)) {
        return reply.code(400).send({ error: `Unknown setting: ${key}` });
      }
      await clearSetting(key as SettingKey);
      // For live keys, clearing means "revert to env" — restore env value
      // to the in-memory config so the next call sees the env fallback.
      const meta = settingMeta(key as SettingKey);
      if (!meta.restartRequired) {
        applyToConfig(key as SettingKey, process.env[key] ?? '');
      }
      return reply.code(204).send();
    },
  );

  // Model picker — given an AI provider, return the model options.
  // Claude is a fixed list with per-model cost notes; Ollama queries the
  // configured base URL's /api/tags and falls back to a curated list.
  app.get<{ Querystring: { provider?: string } }>(
    '/api/settings/ai-models',
    async (req) => {
      const provider = (req.query.provider ?? '').toLowerCase();
      if (provider === 'claude') {
        return {
          provider,
          models: [
            {
              id: 'claude-haiku-4-5',
              label: 'Haiku 4.5',
              recommended: true,
              note: '~$0.001 / normalization batch · best price-perf for SmrtCash',
            },
            {
              id: 'claude-sonnet-4-6',
              label: 'Sonnet 4.6',
              recommended: false,
              note: '~$0.005 / batch · sharper on edge cases (ambiguous merchants)',
            },
            {
              id: 'claude-opus-4-7',
              label: 'Opus 4.7',
              recommended: false,
              note: '~$0.025 / batch · overkill for transaction normalization',
            },
          ],
        };
      }
      if (provider === 'ollama') {
        const cfg = (await import('../config.js')).config;
        const base = cfg.ai.ollamaBaseUrl ?? 'http://localhost:11434';
        const fallback = [
          { id: 'llama3.1', label: 'llama3.1 (8B)', recommended: true, note: 'small + fast; recommended local default' },
          { id: 'llama3.1:70b', label: 'llama3.1:70b', recommended: false, note: 'bigger; needs ~40GB RAM' },
          { id: 'qwen2.5', label: 'qwen2.5', recommended: false, note: 'alt small model' },
        ];
        try {
          const res = await fetch(`${base.replace(/\/$/, '')}/api/tags`, {
            signal: AbortSignal.timeout(2000),
          });
          if (!res.ok) throw new Error(`Ollama responded ${res.status}`);
          const body = (await res.json()) as { models?: Array<{ name: string }> };
          const installed = body.models ?? [];
          if (installed.length === 0) {
            return {
              provider,
              models: fallback,
              note: 'no local models installed — install via `ollama pull <model>`',
            };
          }
          const recommendedName = installed[0]?.name ?? '';
          return {
            provider,
            models: installed.map((m) => ({
              id: m.name,
              label: m.name,
              recommended: m.name === recommendedName,
              note:
                m.name === recommendedName
                  ? 'first installed; reasonable default'
                  : '',
            })),
          };
        } catch (err) {
          return {
            provider,
            models: fallback,
            note: `Could not reach Ollama at ${base}: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }
      return { provider, models: [] };
    },
  );

  // Restart endpoint — used to apply restart-required settings. In Docker
  // the supervisor (`restart: unless-stopped`) brings the process back up;
  // in `npm run dev` the watcher restarts on next file change, otherwise
  // the operator restarts the process manually.
  app.post('/api/admin/restart', async (req, reply) => {
    req.log.warn('Operator-initiated restart via /api/admin/restart');
    reply.send({ restarting: true });
    // Give the response a moment to flush before exiting.
    setTimeout(() => process.exit(0), 250);
  });
}
