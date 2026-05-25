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
import { recordAudit } from '../domain/audit.js';

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

/**
 * 0.18.12 — keys whose values must parse as URLs. Validated at
 * write time with the WHATWG URL parser. A failure here returns
 * 400 with an actionable message; a *successful* parse still
 * surfaces a warning when the host contains an `@` (RFC-legal
 * in the userinfo position but in practice always a typo of
 * `.` — exactly the bug that drove this slice).
 */
const URL_TYPED_KEYS = new Set<SettingKey>([
  'PUBLIC_BASE_URL',
  'SUPPORT_URL',
  'OLLAMA_BASE_URL',
]);

export function validateUrlSetting(
  key: string,
  value: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return `${key} must be a valid URL (e.g. "https://example.com"). Got: "${value}"`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `${key} must use http: or https: (got "${parsed.protocol}")`;
  }
  // An `@` in the host portion is RFC-legal as userinfo
  // (`user@host`) but in our settings context is almost always
  // a typo of `.`. The smrtcash-test deploy bug that motivated
  // this entire slice was exactly this: the operator typed
  // `smrtcash-test@builditsmrt.com` instead of
  // `smrtcash-test.builditsmrt.com`. The parser accepts it, but
  // every outbound flow that built a URL from it broke.
  if (parsed.username !== '' || parsed.password !== '') {
    return `${key} contains an "@" before the host — this is almost always a typo of "."; if you really need HTTP basic-auth in the URL, base64-encode the credential into a header instead`;
  }
  if (parsed.hostname === '') {
    return `${key} has no host. Got: "${value}"`;
  }
  // F-23 (security audit 2026-05-25) — for keys whose value drives a
  // server-initiated fetch (OLLAMA_BASE_URL), refuse private /
  // loopback / link-local / metadata-service IPs at save time.
  // SUPPORT_URL is displayed but not fetched, so it's exempt.
  // PUBLIC_BASE_URL goes in email/redirect links — also not fetched
  // server-side. Only OLLAMA_BASE_URL is fetched, but checking all
  // three URL-typed keys is cheap defense-in-depth.
  if (key === 'OLLAMA_BASE_URL' || key === 'PUBLIC_BASE_URL') {
    const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
    if (isInternalIpLiteral(host)) {
      return `${key} host ${host} is in a private/loopback IP range — refusing.`;
    }
  }
  return null;
}

// Inline copy of the IPv4/IPv6 private-range check so we don't have
// to import url-safety into this hot path. Same logic, no DNS work
// (the async fetch-time path in url-safety.ts handles DNS rebinding).
function isInternalIpLiteral(host: string): boolean {
  // Quick reject if not an IP literal.
  const isV4 = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  const isV6 = /:/.test(host);
  if (!isV4 && !isV6) return false;
  if (isV4) {
    const [a, b] = host.split('.').map(Number) as [number, number, number, number];
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
  }
  const norm = host.toLowerCase();
  if (norm === '::1' || norm === '::' || norm.startsWith('fe8') || norm.startsWith('fe9') ||
      norm.startsWith('fea') || norm.startsWith('feb') || norm.startsWith('fc') || norm.startsWith('fd')) {
    return true;
  }
  return false;
}

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
      // 0.18.12 — URL-typed keys must parse as a real URL. Catches
      // typos like `@` for `.` (RFC-legal in the userinfo position
      // but almost always a typo) that previously took hours to
      // diagnose because the symptoms looked like SMTP relay
      // mangling. See docs/SAAS_DEPLOY.md § 7 for the war story.
      if (URL_TYPED_KEYS.has(key)) {
        const err = validateUrlSetting(key, value);
        if (err) return reply.code(400).send({ error: err });
      }

      // Capture pre-write value for the audit diff. For secrets we
      // only log the masked tail (last 4 chars) so plaintext never
      // lands in audit_log — operators see "key rotated from
      // ●●●●xyz9 to ●●●●ab12" which is enough to identify which
      // value was where, without exposing either secret.
      const oldValue = await getDbValue(key);
      await setDbValue(key, value);
      applyToConfig(key, value);
      await recordAudit({
        actorUserId: req.user?.id ?? null,
        actorKind: req.user?.isSuperAdmin ? 'super_admin' : 'tenant_user',
        action: 'setting.changed',
        targetKind: 'setting',
        targetId: key,
        details: {
          previousValue: oldValue === null
            ? null
            : meta.isSecret ? maskValue(oldValue) : oldValue,
          newValue: meta.isSecret ? maskValue(value) : value,
          isSecret: meta.isSecret,
          restartRequired: meta.restartRequired,
        },
      });
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
      const oldValue = await getDbValue(key as SettingKey);
      await clearSetting(key as SettingKey);
      // For live keys, clearing means "revert to env" — restore env value
      // to the in-memory config so the next call sees the env fallback.
      if (!meta.restartRequired) {
        applyToConfig(key as SettingKey, process.env[key] ?? '');
      }
      await recordAudit({
        actorUserId: req.user?.id ?? null,
        actorKind: req.user?.isSuperAdmin ? 'super_admin' : 'tenant_user',
        action: 'setting.cleared',
        targetKind: 'setting',
        targetId: key,
        details: {
          previousValue: oldValue === null
            ? null
            : meta.isSecret ? maskValue(oldValue) : oldValue,
          isSecret: meta.isSecret,
          restartRequired: meta.restartRequired,
        },
      });
      return reply.code(204).send();
    },
  );

  // Model picker — given an AI provider, return the model options.
  // Claude is a fixed list with per-model cost notes; Ollama queries the
  // configured base URL's /api/tags and falls back to a curated list.
  app.get<{ Querystring: { provider?: string } }>(
    '/api/settings/ai-models',
    async (req, reply) => {
      if (!requireSuperAdmin(req, reply)) return;
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
