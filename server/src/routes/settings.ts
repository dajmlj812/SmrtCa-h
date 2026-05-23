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
import { tryMail, verifyConnection } from '../domain/mailer.js';
import { requireSuperAdmin } from '../auth/rbac.js';

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
  // List: filter out super-only keys for non-super requesters so a
  // tenant admin's UI never even sees them. Super admins get the full
  // list.
  app.get('/api/settings', async (req) => {
    const isSuper = req.user?.isSuperAdmin === true;
    const visible = KNOWN_SETTINGS.filter((m) => isSuper || !m.superOnly);
    const rows = await Promise.all(visible.map((m) => buildRow(m)));
    return { settings: rows };
  });

  app.put<{ Params: { key: string } }>(
    '/api/settings/:key',
    async (req, reply) => {
      const key = req.params.key.toUpperCase();
      if (!isKnownSetting(key)) {
        return reply.code(400).send({ error: `Unknown setting: ${key}` });
      }
      const meta = settingMeta(key);
      // Super-only gating: even tenant-admins can't touch SMTP_*,
      // BACKUP_*, SESSION_SECRET, ATTACHMENT_ENCRYPTION_KEY, APP_BASE_URL.
      if (meta.superOnly && !req.user?.isSuperAdmin) {
        return reply.code(403).send({ error: 'Super admin only' });
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
      const meta = settingMeta(key as SettingKey);
      if (meta.superOnly && !req.user?.isSuperAdmin) {
        return reply.code(403).send({ error: 'Super admin only' });
      }
      await clearSetting(key as SettingKey);
      // For live keys, clearing means "revert to env" — restore env value
      // to the in-memory config so the next call sees the env fallback.
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

  // SMTP test: verify connection only, then send a one-line test email
  // to the supplied address. Used by the Settings page to confirm SMTP
  // is configured before relying on it for invitations / alerts.
  // Super-admin only — SMTP is platform infrastructure.
  app.post('/api/admin/smtp-test', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    const body = (req.body ?? {}) as { to?: unknown };
    const to = typeof body.to === 'string' ? body.to.trim() : '';
    if (to === '' || !/.+@.+\..+/.test(to)) {
      return reply.code(400).send({ error: 'to must be a valid email address' });
    }
    const verify = await verifyConnection();
    if (!verify.ok) {
      return reply.code(400).send({ ok: false, stage: 'verify', reason: verify.reason });
    }
    const result = await tryMail({
      to,
      subject: 'SmrtCash SMTP test',
      text:
        'This is a SmrtCash SMTP test message.\n\n' +
        'If you can read this, your SMTP configuration is working. ' +
        'Invitations and other outbound messages will use this same path.',
    });
    if (!result.sent) {
      return reply.code(400).send({ ok: false, stage: 'send', reason: result.reason });
    }
    return { ok: true, message_id: result.messageId };
  });

  // Restart endpoint — used to apply restart-required settings. In Docker
  // the supervisor (`restart: unless-stopped`) brings the process back up;
  // in `npm run dev` the watcher restarts on next file change, otherwise
  // the operator restarts the process manually.
  app.post('/api/admin/restart', async (req, reply) => {
    if (!requireSuperAdmin(req, reply)) return;
    req.log.warn('Operator-initiated restart via /api/admin/restart');
    reply.send({ restarting: true });
    // Give the response a moment to flush before exiting.
    setTimeout(() => process.exit(0), 250);
  });
}
