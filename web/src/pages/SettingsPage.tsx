import { useEffect, useState } from 'react';
import { api, type AiModelOption, type AppSetting } from '../api';

const AI_PROVIDERS = ['none', 'rules', 'claude', 'ollama'];

// 0.18.12 — mirror of the server's URL_TYPED_KEYS so the UI can
// validate inline before the server rejects the save. Keep this
// list in sync with server/src/routes/settings.ts.
const URL_TYPED_KEYS = new Set<string>([
  'PUBLIC_BASE_URL',
  'SUPPORT_URL',
  'OLLAMA_BASE_URL',
]);

/**
 * 0.18.12 — client-side mirror of validateUrlSetting. Returns a
 * hint string when the value looks wrong; null when it's fine.
 * The server runs the same checks at write time — this is just
 * a feedback loop so the user isn't surprised by a 400.
 */
function checkUrlHint(value: string): string | null {
  const v = value.trim();
  if (v === '') return null; // empty handled separately (Save disabled)
  let parsed: URL;
  try {
    parsed = new URL(v);
  } catch {
    return 'This doesn’t look like a valid URL (e.g. https://example.com).';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `URL must start with http:// or https:// (got "${parsed.protocol}").`;
  }
  if (parsed.username !== '' || parsed.password !== '') {
    return 'There’s an "@" before the host — that’s almost always a typo of "." in a hostname.';
  }
  return null;
}

const SECTIONS: Array<{ title: string; subtitle: string; keys: string[] }> = [
  {
    title: 'AI Provider',
    subtitle:
      'Drives transaction normalization and receipt OCR. Changes take effect on the next AI call.',
    keys: [
      'AI_PROVIDER',
      'ANTHROPIC_API_KEY',
      'ANTHROPIC_MODEL',
      'OLLAMA_BASE_URL',
      'OLLAMA_MODEL',
    ],
  },
  {
    title: 'External APIs',
    subtitle:
      'Optional integrations. Leave blank to use manual entry only.',
    keys: ['EIA_API_KEY'],
  },
  {
    title: 'SMTP — outbound email',
    subtitle:
      'Powers invitation emails (and future password resets / alerts). Leave blank to disable — invites still work via copy-link.',
    keys: [
      'SMTP_HOST',
      'SMTP_PORT',
      'SMTP_USER',
      'SMTP_PASS',
      'SMTP_FROM',
      'SMTP_SECURE',
      'APP_BASE_URL',
    ],
  },
  // 0.16.3 — Stripe + SaaS toggles. STRIPE_SECRET_KEY rotates
  // live; PUBLIC_SIGNUP_ENABLED + STRIPE_AUTOMATIC_TAX are simple
  // boolean flags. STRIPE_PUBLIC_BASE_URL is the base for Stripe
  // Checkout success/cancel + every transactional email link.
  {
    title: 'Stripe + SaaS',
    subtitle:
      'Stripe API keys (rotate live — the SDK client rebuilds on the next call), public-signup toggle, automatic-tax toggle, and the base URL used for Checkout redirects + email links.',
    keys: [
      'STRIPE_SECRET_KEY',
      'STRIPE_WEBHOOK_SECRET',
      'STRIPE_PUBLIC_BASE_URL',
      'STRIPE_AUTOMATIC_TAX',
      'PUBLIC_SIGNUP_ENABLED',
    ],
  },
  // 0.16.3 — Support link surfaced in sidebar footers + on
  // every unauthenticated page (login, signup, forgot/reset).
  // Defaults to https://support.builditsmrt.com/ when nothing
  // is set; operators self-hosting on their own domain can
  // repoint at their own help system.
  {
    title: 'Support & feedback',
    subtitle:
      'Operator-configured help destination — surfaced as "Help & feature requests" in the sidebar and on every unauthenticated page. Clear it to hide the link everywhere.',
    keys: ['SUPPORT_URL'],
  },
  // 0.17.25 — surface Plaid + Anomaly toggles so they can be
  // enabled without editing .env or hand-poking the settings API.
  {
    title: 'Plaid — bank sync',
    subtitle:
      'When enabled, /plaid lets you link accounts and import transactions automatically. PLAID_ENABLED=true requires all four keys to be set. PLAID_ENV is "sandbox" for testing or "production" for live linkage.',
    keys: ['PLAID_ENABLED', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'],
  },
  {
    title: 'Anomaly alerts',
    subtitle:
      'Flags unusual transactions on import — single transactions over the threshold, or merchant-level outliers (N× the median for that merchant). When ANOMALY_EMAIL_TO is set, a digest is mailed; otherwise alerts stay in-app at /anomalies. Defaults: threshold $500, multiplier 5×.',
    keys: [
      'ANOMALY_ENABLED',
      'ANOMALY_LARGE_TXN_THRESHOLD_CENTS',
      'ANOMALY_MULTIPLIER',
      'ANOMALY_EMAIL_TO',
    ],
  },
  {
    title: 'Web session',
    subtitle:
      'Automatically sign out users whose browser has been idle for the configured number of minutes. 0 disables the timer (sessions only end when the user signs out or the cookie expires). Applies to every signed-in user on this instance.',
    keys: ['WEB_INACTIVITY_TIMEOUT_MINUTES'],
  },
  {
    title: 'Security — restart required',
    subtitle:
      'Rotating these breaks things if done wrong. The server must restart for new values to apply.',
    keys: ['SESSION_SECRET', 'ATTACHMENT_ENCRYPTION_KEY'],
  },
];

const DESTRUCTIVE_CONFIRM: Record<string, string> = {
  SESSION_SECRET: 'rotate',
  ATTACHMENT_ENCRYPTION_KEY: 'DESTROY EXISTING',
};

export function SettingsPage() {
  const [settings, setSettings] = useState<AppSetting[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [restarting, setRestarting] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setSettings(await api.listSettings());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load settings');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save(setting: AppSetting, newValue: string) {
    setError(null);
    setSuccess(null);
    try {
      const r = await api.putSetting(setting.key, newValue);
      setSuccess(`${setting.label} saved.`);
      if (r.restart_required) setRestartNeeded(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function clearKey(setting: AppSetting) {
    if (
      !window.confirm(
        `Clear ${setting.label}? ${
          setting.env_fallback_present
            ? "The .env value will take over."
            : 'The feature will be unconfigured.'
        }`,
      )
    ) {
      return;
    }
    setError(null);
    setSuccess(null);
    try {
      await api.clearSetting(setting.key);
      setSuccess(`${setting.label} cleared.`);
      if (setting.restart_required) setRestartNeeded(true);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    }
  }

  async function doRestart() {
    if (
      !window.confirm(
        'Restart the server now? You will be briefly disconnected; if the supervisor (docker compose) is configured to auto-restart, the app will be back in a few seconds.',
      )
    ) {
      return;
    }
    setRestarting(true);
    try {
      await api.restartServer();
      // The server is about to exit; give it a moment, then reload.
      setTimeout(() => window.location.reload(), 2000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Restart failed');
      setRestarting(false);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Settings</h1>
          <div className="subtitle">
            Manage runtime configuration without editing <code>.env</code> on
            the server.
          </div>
        </div>
        {restartNeeded && (
          <button
            className="btn danger"
            type="button"
            disabled={restarting}
            onClick={() => void doRestart()}
          >
            {restarting ? 'Restarting…' : 'Restart server'}
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {success && <div className="banner success">{success}</div>}
      {restartNeeded && !restarting && (
        <div className="banner warning">
          One or more changes require a server restart to take effect.
          Click <strong>Restart server</strong> when you're ready.
        </div>
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : (
        <>
          {SECTIONS.map((section) => {
            // Server filters out super-only keys for tenant admins. If
            // none of this section's keys came back, skip the whole
            // section so we don't render an empty card.
            const visibleKeys = section.keys.filter((k) =>
              settings.some((s) => s.key === k),
            );
            if (visibleKeys.length === 0) return null;
            return (
              <div key={section.title} className="page-section">
                <div className="page-section-head">
                  <div>
                    <h2>{section.title}</h2>
                    <div className="muted" style={{ fontSize: 13 }}>
                      {section.subtitle}
                    </div>
                  </div>
                </div>
                <div className="card settings-list">
                  {visibleKeys.map((key) => {
                    const setting = settings.find((s) => s.key === key);
                    if (!setting) return null;
                    return (
                      <SettingRow
                        key={setting.key}
                        setting={setting}
                        onSave={(v) => void save(setting, v)}
                        onClear={() => void clearKey(setting)}
                      />
                    );
                  })}
                  {section.title.startsWith('SMTP') && <SmtpTestPanel />}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
}

function SmtpTestPanel() {
  const [to, setTo] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{
    ok: boolean;
    text: string;
  } | null>(null);

  async function run() {
    if (to.trim() === '') return;
    setBusy(true);
    setResult(null);
    try {
      const r = await api.smtpTest(to.trim());
      if (r.ok) {
        setResult({ ok: true, text: `Sent (Message-Id ${r.message_id ?? '—'})` });
      } else {
        setResult({
          ok: false,
          text: `Failed at ${r.stage ?? '?'}: ${r.reason ?? 'unknown'}`,
        });
      }
    } catch (e) {
      setResult({ ok: false, text: e instanceof Error ? e.message : 'Test failed' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="smtp-test-row">
      <input
        type="email"
        placeholder="Send a test message to…"
        value={to}
        onChange={(e) => setTo(e.target.value)}
        disabled={busy}
      />
      <button
        className="btn"
        type="button"
        onClick={() => void run()}
        disabled={busy || to.trim() === ''}
      >
        {busy ? 'Sending…' : 'Send test'}
      </button>
      {result && (
        <span className={result.ok ? 'pill status-keep-pill' : 'pill status-cancel-pill'}>
          {result.text}
        </span>
      )}
    </div>
  );
}

function SettingRow({
  setting,
  onSave,
  onClear,
}: {
  setting: AppSetting;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [confirmText, setConfirmText] = useState('');

  const destructiveConfirm = DESTRUCTIVE_CONFIRM[setting.key];
  const confirmRequired = !!destructiveConfirm && setting.configured_in_gui;
  const confirmMatch = !confirmRequired || confirmText === destructiveConfirm;

  // 0.18.12 — inline URL hint for URL-typed keys. Save is
  // blocked when the hint is non-null.
  const isUrlKey = URL_TYPED_KEYS.has(setting.key);
  const urlHint = isUrlKey ? checkUrlHint(value) : null;

  function commit() {
    if (value.trim() === '') return;
    if (!confirmMatch) return;
    if (urlHint !== null) return;
    onSave(value.trim());
    setEditing(false);
    setValue('');
    setConfirmText('');
  }

  return (
    <div className="settings-row">
      <div className="settings-row-label">
        <div className="settings-row-name">
          {setting.label}
          {setting.is_secret && <span className="pill secret-pill">secret</span>}
          {setting.restart_required && (
            <span className="pill warn-pill">restart</span>
          )}
        </div>
        <div className="muted settings-row-key">{setting.key}</div>
      </div>

      <div className="settings-row-value">
        {editing ? (
          <div className="settings-edit">
            {setting.key === 'AI_PROVIDER' ? (
              <select value={value} onChange={(e) => setValue(e.target.value)}>
                <option value="">— Pick one —</option>
                {AI_PROVIDERS.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : setting.key === 'ANTHROPIC_MODEL' ? (
              <AiModelPicker provider="claude" value={value} onChange={setValue} />
            ) : setting.key === 'OLLAMA_MODEL' ? (
              <AiModelPicker provider="ollama" value={value} onChange={setValue} />
            ) : (
              <input
                type={
                  setting.is_secret
                    ? 'password'
                    : isUrlKey
                      ? 'url'
                      : 'text'
                }
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  setting.is_secret
                    ? 'paste new value'
                    : isUrlKey
                      ? 'https://example.com'
                      : 'new value'
                }
                autoFocus
              />
            )}
            {urlHint !== null && (
              <div className="hint warn">{urlHint}</div>
            )}
            {setting.key === 'EIA_API_KEY' && (
              <div className="muted" style={{ fontSize: 12 }}>
                Need a key?{' '}
                <a
                  href="https://www.eia.gov/opendata/register.php"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Create one (free)
                </a>{' '}
                — it arrives by email in seconds.
              </div>
            )}
            {confirmRequired && (
              <div className="settings-confirm">
                <span className="muted">
                  Type <code>{destructiveConfirm}</code> to confirm:
                </span>
                <input
                  type="text"
                  value={confirmText}
                  onChange={(e) => setConfirmText(e.target.value)}
                />
              </div>
            )}
            <div className="settings-edit-actions">
              <button
                className="btn small"
                type="button"
                onClick={commit}
                disabled={
                  !confirmMatch || value.trim() === '' || urlHint !== null
                }
              >
                Save
              </button>
              <button
                className="btn secondary small"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setValue('');
                  setConfirmText('');
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <div className="settings-display">
            <span className="settings-display-value">
              {setting.display_value ? (
                <code>{setting.display_value}</code>
              ) : (
                <span className="muted">not configured</span>
              )}
            </span>
            <span className="muted" style={{ fontSize: 11 }}>
              {setting.configured_in_gui
                ? 'set via GUI'
                : setting.env_fallback_present
                  ? 'from .env'
                  : 'no value'}
            </span>
          </div>
        )}
      </div>

      <div className="settings-row-actions">
        {!editing && (
          <button
            className="btn-link"
            type="button"
            onClick={() => setEditing(true)}
          >
            {setting.configured_in_gui ? 'Change' : 'Set'}
          </button>
        )}
        {!editing && setting.configured_in_gui && (
          <button className="btn-link danger" type="button" onClick={onClear}>
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

function AiModelPicker({
  provider,
  value,
  onChange,
}: {
  provider: 'claude' | 'ollama';
  value: string;
  onChange: (v: string) => void;
}) {
  const [models, setModels] = useState<AiModelOption[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const r = await api.aiModels(provider);
        if (cancelled) return;
        setModels(r.models);
        setNote(r.note ?? null);
        // If the field is blank, default to the recommended model.
        if (value === '') {
          const rec = r.models.find((m) => m.recommended);
          if (rec) onChange(rec.id);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider]);

  if (loading) return <span className="muted">Loading models…</span>;
  if (models.length === 0) {
    return (
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="model id"
      />
    );
  }
  return (
    <div className="model-picker">
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        <option value="">— Pick a model —</option>
        {models.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label}
            {m.recommended ? ' ★' : ''}
          </option>
        ))}
        <option value="__custom__">Custom (type below)…</option>
      </select>
      {value === '__custom__' && (
        <input
          type="text"
          placeholder="enter a custom model id"
          onChange={(e) => onChange(e.target.value)}
          autoFocus
        />
      )}
      {models.find((m) => m.id === value)?.note && (
        <div className="muted" style={{ fontSize: 12 }}>
          {models.find((m) => m.id === value)!.note}
        </div>
      )}
      {note && (
        <div className="muted" style={{ fontSize: 12, fontStyle: 'italic' }}>
          {note}
        </div>
      )}
    </div>
  );
}
