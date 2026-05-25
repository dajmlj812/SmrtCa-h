import { config } from '../config.js';
import { pool, query } from '../db/pool.js';
import { _resetStripeClientForTests } from '../billing/stripe.js';

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
  // Multi-currency display (0.10.0). Money is stored in each account's
  // own currency; dashboards convert to this one for cross-account
  // totals. Default USD when unset.
  { key: 'DISPLAY_CURRENCY', isSecret: false, restartRequired: false, superOnly: true, label: 'Display currency (ISO 4217)' },
  { key: 'FX_PROVIDER', isSecret: false, restartRequired: false, superOnly: true, label: 'FX rate provider' },
  // Savings suggestion tuning — live, super-admin only (0.9.3).
  // Used by the budget wizard as global defaults; per-tenant overrides
  // are queued for a later release.
  { key: 'SAVINGS_INCOME_PCT', isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — % of income (legacy)' },
  { key: 'SAVINGS_LEFTOVER_PCT', isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — % of leftover (legacy)' },
  // 0.17.22 — three configurable percentages of post-deduction
  // leftover used by the savings suggestion chips. Defaults 25/50/75
  // if unset; per-wizard-run overrides supersede.
  { key: 'SAVINGS_PCT_LOW',  isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — low % chip (default 25)' },
  { key: 'SAVINGS_PCT_MID',  isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — mid % chip (default 50)' },
  { key: 'SAVINGS_PCT_HIGH', isSecret: false, restartRequired: false, superOnly: true, label: 'Savings — high % chip (default 75)' },
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
  // 0.18.8 — unified public base URL. Replaces APP_BASE_URL +
  // STRIPE_PUBLIC_BASE_URL (both retired). Used by every outgoing
  // link: email verification, password reset, invitations, dunning,
  // Stripe Checkout redirects, all of it. Migration 048 backfills
  // from whichever old key was set.
  { key: 'PUBLIC_BASE_URL', isSecret: false, restartRequired: false, superOnly: true, label: 'Public base URL (for email links + Stripe redirects)' },
  // Security — super-admin only, restart required
  { key: 'SESSION_SECRET', isSecret: true, restartRequired: true, superOnly: true, label: 'Session secret' },
  { key: 'ATTACHMENT_ENCRYPTION_KEY', isSecret: true, restartRequired: true, superOnly: true, label: 'Attachment encryption key' },
  // Anomaly alerts (backlog 0.13.2). Scanner runs after every import
  // + manually via /api/anomalies/scan. SMTP digest is optional —
  // empty ANOMALY_EMAIL_TO keeps alerts in-app only.
  { key: 'ANOMALY_ENABLED', isSecret: false, restartRequired: false, superOnly: true, label: 'Anomaly alerts — enabled' },
  { key: 'ANOMALY_LARGE_TXN_THRESHOLD_CENTS', isSecret: false, restartRequired: false, superOnly: true, label: 'Anomaly — single-transaction threshold (cents)' },
  { key: 'ANOMALY_MULTIPLIER', isSecret: false, restartRequired: false, superOnly: true, label: 'Anomaly — outlier multiplier (×median at merchant)' },
  { key: 'ANOMALY_EMAIL_TO', isSecret: false, restartRequired: false, superOnly: true, label: 'Anomaly — digest email recipient (optional)' },
  // Crypto price feed (backlog 0.13.3). 'coingecko' = free public API;
  // 'manual' disables auto-fetch so the user enters prices by hand.
  { key: 'CRYPTO_PRICE_PROVIDER', isSecret: false, restartRequired: false, superOnly: true, label: 'Crypto price provider (coingecko / manual)' },
  // Auto-sync (Phase 8.3 / 0.11.3) — periodic background fetch of
  // every enabled OFX-DC connection + Plaid item. Disabled by default;
  // tenant admins still trigger /sync manually until the super-admin
  // turns this on.
  { key: 'AUTO_SYNC_ENABLED', isSecret: false, restartRequired: false, superOnly: true, label: 'Auto sync — enabled' },
  { key: 'AUTO_SYNC_FREQUENCY', isSecret: false, restartRequired: false, superOnly: true, label: 'Auto sync — frequency' },
  { key: 'AUTO_SYNC_TIME', isSecret: false, restartRequired: false, superOnly: true, label: 'Auto sync — time (HH:MM, 24h)' },
  // Plaid (Phase 8.2 / 0.11.2) — DISABLED BY DEFAULT. Plaid is the
  // only data source that leaves the fully-local model: enabling it
  // sends bank credentials through Plaid's servers. Super-admin-only;
  // all PLAID_* keys must be set AND PLAID_ENABLED=true for any
  // server-side code path to run.
  { key: 'PLAID_ENABLED', isSecret: false, restartRequired: false, superOnly: true, label: 'Plaid — enabled' },
  { key: 'PLAID_CLIENT_ID', isSecret: false, restartRequired: false, superOnly: true, label: 'Plaid — client_id' },
  { key: 'PLAID_SECRET', isSecret: true, restartRequired: false, superOnly: true, label: 'Plaid — secret' },
  { key: 'PLAID_ENV', isSecret: false, restartRequired: false, superOnly: true, label: 'Plaid — environment (sandbox/production)' },
  // Stripe + SaaS toggles (0.16.3) — super-admin only.
  //
  // STRIPE_SECRET_KEY changes invalidate the cached Stripe SDK
  // client (see applyToConfig below) so a rotation takes effect
  // on the next API call without a restart. STRIPE_WEBHOOK_SECRET
  // is read at signature-verify time so no caching issue there.
  //
  // PUBLIC_SIGNUP_ENABLED and STRIPE_AUTOMATIC_TAX are simple
  // boolean toggles previously read from process.env; flipping
  // them in the DB now takes effect on the next request.
  { key: 'STRIPE_SECRET_KEY', isSecret: true, restartRequired: false, superOnly: true, label: 'Stripe — secret key (sk_…)' },
  { key: 'STRIPE_WEBHOOK_SECRET', isSecret: true, restartRequired: false, superOnly: true, label: 'Stripe — webhook signing secret (whsec_…)' },
  { key: 'STRIPE_AUTOMATIC_TAX', isSecret: false, restartRequired: false, superOnly: true, label: 'Stripe — automatic tax (true/false)' },
  { key: 'PUBLIC_SIGNUP_ENABLED', isSecret: false, restartRequired: false, superOnly: true, label: 'Public signup at /signup (true/false)' },
  // Support / feedback URL (0.16.3). Surfaced in sidebar footers
  // and on login/signup pages so users always know where to ask
  // for help and file feature requests. Defaults to the BITS
  // hosted support page; operators self-hosting on their own
  // domain can repoint at their own help system.
  { key: 'SUPPORT_URL', isSecret: false, restartRequired: false, superOnly: true, label: 'Support / feature-request URL' },
  // 0.18.3 — web idle-timeout. Read by the React app on auth and
  // turned into an "inactivity → auto-logout" timer. Value is
  // minutes; 0 disables the timer entirely (the prior behavior).
  // Super-admin owns this because it's a security-policy decision
  // applied across every user on the instance.
  { key: 'WEB_INACTIVITY_TIMEOUT_MINUTES', isSecret: false, restartRequired: false, superOnly: true, label: 'Web — idle auto-logout (minutes; 0 = disabled)' },
] as const;

/**
 * 0.16.3 — default values applied when neither the DB nor the
 * environment has a setting. Right now only SUPPORT_URL has a
 * meaningful default (the public BITS support portal); every
 * other key falls back to empty / off, which is the safe choice
 * for self-host deployments that may not want that surface.
 */
export const SETTING_DEFAULTS: Partial<Record<SettingKey, string>> = {
  SUPPORT_URL: 'https://support.builditsmrt.com/',
};

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

/**
 * DB value with env fallback, then default. Returns empty string
 * if none of the three are set. Default tier added 0.16.3 so
 * keys like SUPPORT_URL ship with a sensible value out of the
 * box without forcing every install to set an env var.
 */
export async function getEffectiveValue(key: SettingKey): Promise<string> {
  const db = await getDbValue(key);
  if (db !== null && db !== '') return db;
  const env = process.env[key];
  if (env !== undefined && env !== '') return env;
  return SETTING_DEFAULTS[key] ?? '';
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

export interface PlaidConfig {
  clientId: string;
  secret: string;
  environment: 'sandbox' | 'development' | 'production';
}

/**
 * Returns the active Plaid configuration when PLAID_ENABLED=true and
 * client_id + secret + env are all set; otherwise null. Every server-
 * side Plaid code path consults this gate before doing anything.
 */
export async function getPlaidConfig(): Promise<PlaidConfig | null> {
  const enabled = (await getEffectiveValue('PLAID_ENABLED')).trim().toLowerCase();
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') return null;
  const clientId = (await getEffectiveValue('PLAID_CLIENT_ID')).trim();
  const secret = (await getEffectiveValue('PLAID_SECRET')).trim();
  const env = (await getEffectiveValue('PLAID_ENV')).trim().toLowerCase();
  if (!clientId || !secret) return null;
  const environment =
    env === 'production' ? 'production' : env === 'development' ? 'development' : 'sandbox';
  return { clientId, secret, environment };
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
      //
      // Hex check first: a 64-char hex string also matches the base64
      // regex below and would decode to 48 bytes (wrong answer). Hex
      // is the stricter format so it goes first.
      try {
        const trimmed = value.trim();
        if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
          (config as { attachmentEncryptionKey: Buffer | null }).attachmentEncryptionKey =
            Buffer.from(trimmed, 'hex');
        } else if (/^[A-Za-z0-9+/]+=*$/.test(trimmed)) {
          const b = Buffer.from(trimmed, 'base64');
          if (b.length === 32) {
            (config as { attachmentEncryptionKey: Buffer | null }).attachmentEncryptionKey = b;
          }
        }
      } catch {
        /* tolerate parse failure; restart will fix */
      }
      break;
    case 'STRIPE_SECRET_KEY':
      // 0.16.3 — Stripe SDK client caches the key on first use; an
      // operator rotating from test to live (or rotating after a
      // leak) needs the cache to drop so the next call rebuilds
      // with the new key. Mirror the value into process.env too so
      // anything still reading raw `process.env.STRIPE_SECRET_KEY`
      // sees the update.
      process.env.STRIPE_SECRET_KEY = value;
      _resetStripeClientForTests();
      break;
    case 'STRIPE_WEBHOOK_SECRET':
    case 'STRIPE_AUTOMATIC_TAX':
    case 'PUBLIC_SIGNUP_ENABLED':
    case 'PUBLIC_BASE_URL':
    case 'SUPPORT_URL':
      // Read fresh from getEffectiveValue() each request; no
      // caching, so a DB write takes effect immediately. We still
      // mirror to process.env for any third-party code that might
      // be looking there.
      process.env[key] = value;
      break;
  }
}
