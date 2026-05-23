import { config } from '../config.js';
import { pool, query } from '../db/pool.js';

/**
 * Runtime-editable settings layer. Read priority is:
 *   1. app_settings table (set via the GUI)
 *   2. process.env (set via .env)
 *   3. hard-coded default (where applicable)
 *
 * A non-null DB value always wins; clear it via `clearSetting()` to fall
 * back to the env value.
 *
 * Two classes of keys:
 *
 *  - **Live keys** (AI provider, AI model, AI API keys, EIA key) —
 *    mutating these takes effect on the next call that reads `config`.
 *    `applyHotMutation()` updates the in-memory `config` object so AI
 *    factory functions see the new value without a restart.
 *
 *  - **Boot keys** (SESSION_SECRET, ATTACHMENT_ENCRYPTION_KEY) — only
 *    read once at process start. Mutating these requires a server
 *    restart; the API returns `restart_required: true` so the UI can
 *    surface the prompt.
 */

/**
 * Per-key metadata. `superOnly: true` means only super_admins can see,
 * edit, or clear this setting — covers SMTP, backups, security keys,
 * and the email base URL (all platform-level concerns).
 */
export const KNOWN_SETTINGS = [
  // AI provider — live, super-admin only (0.9.3). One Anthropic / Ollama
  // configuration is shared across all tenants; per-tenant overrides are
  // queued for a later release.
  { key: 'AI_PROVIDER', isSecret: false, restartRequired: false, superOnly: true, label: 'AI provider' },
  { key: 'ANTHROPIC_API_KEY', isSecret: true, restartRequired: false, superOnly: true, label: 'Anthropic API key' },
  { key: 'ANTHROPIC_MODEL', isSecret: false, restartRequired: false, superOnly: true, label: 'Anthropic model' },
  { key: 'OLLAMA_BASE_URL', isSecret: false, restartRequired: false, superOnly: true, label: 'Ollama base URL' },
  { key: 'OLLAMA_MODEL', isSecret: false, restartRequired: false, superOnly: true, label: 'Ollama model' },
  // Fuel-price source — live, super-admin only (0.9.3).
  { key: 'EIA_API_KEY', isSecret: true, restartRequired: false, superOnly: true, label: 'EIA API key' },
  // Savings suggestion tuning — live, super-admin only (0.9.3).
  // Used by the budget wizard as global defaults; per-tenant overrides
  // are queued for a later release.
  { key: 'SAVINGS_INCOME_PCT', isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — % of income' },
  { key: 'SAVINGS_LEFTOVER_PCT', isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — % of leftover' },
  // Backup config — super-admin only
  { key: 'BACKUP_ENABLED', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — enabled' },
  { key: 'BACKUP_FREQUENCY', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — frequency' },
  { key: 'BACKUP_TIME', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — time (HH:MM, 24h)' },
  { key: 'BACKUP_RETENTION_DAYS', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — retention (days)' },
  { key: 'BACKUP_DIR', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — directory' },
  { key: 'BACKUP_SECONDARY_DIR', isSecret: false, restartRequired: false, superOnly: true, label: 'Backup — secondary off-server directory' },
  // SMTP — super-admin only
  { key: 'SMTP_HOST', isSecret: false, restartRequired: false, superOnly: true, label: 'SMTP host' },
  { key: 'SMTP_PORT', isSecret: false, restartRequired: false, superOnly: true, label: 'SMTP port' },
  { key: 'SMTP_USER', isSecret: false, restartRequired: false, superOnly: true, label: 'SMTP username' },
  { key: 'SMTP_PASS', isSecret: true, restartRequired: false, superOnly: true, label: 'SMTP password' },
  { key: 'SMTP_FROM', isSecret: false, restartRequired: false, superOnly: true, label: 'SMTP from address' },
  { key: 'SMTP_SECURE', isSecret: false, restartRequired: false, superOnly: true, label: 'SMTP TLS-on-connect (port 465)' },
  // App base URL — for outgoing email links. Super-admin only.
  { key: 'APP_BASE_URL', isSecret: false, restartRequired: false, superOnly: true, label: 'App base URL (for email links)' },
  // Security — super-admin only, restart required
  { key: 'SESSION_SECRET', isSecret: true, restartRequired: true, superOnly: true, label: 'Session secret' },
  { key: 'ATTACHMENT_ENCRYPTION_KEY', isSecret: true, restartRequired: true, superOnly: true, label: 'Attachment encryption key' },
] as const;

export type SettingKey = (typeof KNOWN_SETTINGS)[number]['key'];

const KEY_INDEX = new Map(KNOWN_SETTINGS.map((s) => [s.key, s]));

export function isKnownSetting(key: string): key is SettingKey {
  return KEY_INDEX.has(key as SettingKey);
}

export function settingMeta(key: SettingKey): (typeof KNOWN_SETTINGS)[number] {
  return KEY_INDEX.get(key)!;
}

interface SettingRow {
  key: string;
  value: string | null;
  is_secret: boolean;
  updated_at: string;
}

export async function getDbValue(key: SettingKey): Promise<string | null> {
  const r = await pool.query<{ value: string | null }>(
    `SELECT value FROM app_settings WHERE key = $1`,
    [key],
  );
  if (r.rowCount === 0) return null;
  return r.rows[0]!.value;
}

/** DB value with env fallback. Returns empty string if neither is set. */
export async function getEffectiveValue(key: SettingKey): Promise<string> {
  const db = await getDbValue(key);
  if (db !== null && db !== '') return db;
  return process.env[key] ?? '';
}

export async function setDbValue(
  key: SettingKey,
  value: string,
): Promise<SettingRow> {
  const meta = settingMeta(key);
  const r = await query<SettingRow>(
    `INSERT INTO app_settings (key, value, is_secret)
     VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE
       SET value = EXCLUDED.value,
           is_secret = EXCLUDED.is_secret,
           updated_at = now()
     RETURNING key, value, is_secret, updated_at`,
    [key, value, meta.isSecret],
  );
  return r.rows[0]!;
}

export async function clearSetting(key: SettingKey): Promise<void> {
  await query(`DELETE FROM app_settings WHERE key = $1`, [key]);
}

export async function listAllSettings(): Promise<SettingRow[]> {
  const r = await query<SettingRow>(
    `SELECT key, value, is_secret, updated_at FROM app_settings`,
  );
  return r.rows;
}

/** Mask the tail of a secret value for display. */
export function maskValue(value: string): string {
  if (!value) return '';
  if (value.length <= 4) return '••••';
  return '••••' + value.slice(-4);
}

/**
 * On boot: load every known setting from the DB and override the
 * matching config slot. Called once before Fastify registers the cookie
 * plugin / attachment storage so they pick up the runtime-set values.
 */
export async function applyBootSettings(): Promise<void> {
  for (const meta of KNOWN_SETTINGS) {
    const dbVal = await getDbValue(meta.key);
    if (dbVal === null || dbVal === '') continue;
    applyToConfig(meta.key, dbVal);
  }
}

/**
 * Live-update the in-memory `config` object. Called immediately after a
 * PUT /api/settings/:key write so subsequent AI/fuel calls see the new
 * value. Restart-required keys still get applied here (no harm) but the
 * Fastify plugins that captured them at boot won't notice — that's why
 * the API response carries restart_required.
 */
export function applyToConfig(key: SettingKey, value: string): void {
  switch (key) {
    case 'AI_PROVIDER':
      // Trust the value — narrow validation happens in the API handler.
      (config.ai as { provider: string }).provider = value;
      break;
    case 'ANTHROPIC_API_KEY':
      config.ai.anthropicApiKey = value;
      break;
    case 'ANTHROPIC_MODEL':
      config.ai.anthropicModel = value;
      break;
    case 'OLLAMA_BASE_URL':
      config.ai.ollamaBaseUrl = value;
      break;
    case 'OLLAMA_MODEL':
      config.ai.ollamaModel = value;
      break;
    case 'EIA_API_KEY':
      (config as { eiaApiKey: string }).eiaApiKey = value;
      break;
    case 'SESSION_SECRET':
      // Captured by @fastify/cookie at registration — restart required
      // for the new secret to take effect on cookie signing. We still
      // update the in-memory value so the next process boot uses it.
      config.auth.sessionSecret = value;
      break;
    case 'ATTACHMENT_ENCRYPTION_KEY':
      // Same story — the buffer was parsed at boot. We could re-parse
      // here but the routes that READ encrypted attachments use the
      // already-captured value. Restart required.
      try {
        const trimmed = value.trim();
        if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
          const b = Buffer.from(trimmed, 'base64');
          if (b.length === 32) {
            (config as { attachmentEncryptionKey: Buffer | null }).attachmentEncryptionKey = b;
          }
        } else if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          (config as { attachmentEncryptionKey: Buffer | null }).attachmentEncryptionKey =
            Buffer.from(trimmed, 'hex');
        }
      } catch {
        /* tolerate parse failure; restart will fix */
      }
      break;
  }
}
