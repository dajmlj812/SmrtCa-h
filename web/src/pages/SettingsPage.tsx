import { useEffect, useState } from 'react';
import { api, type AiModelOption, type AppSetting } from '../api';

const AI_PROVIDERS = ['none', 'rules', 'claude', 'ollama'];

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
        SECTIONS.map((section) => (
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
              {section.keys.map((key) => {
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
            </div>
          </div>
        ))
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

  function commit() {
    if (value.trim() === '') return;
    if (!confirmMatch) return;
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
                type={setting.is_secret ? 'password' : 'text'}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                placeholder={
                  setting.is_secret ? 'paste new value' : 'new value'
                }
                autoFocus
              />
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
                disabled={!confirmMatch || value.trim() === ''}
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
