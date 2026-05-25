import { useEffect, useState } from 'react';
import { api, type ApiKeySummary } from '../api';
import { formatRelative } from '../format';

/**
 * 0.18.4 — embedded inside ProfileModal as the "API keys" section.
 *
 * Renders the caller's existing keys + a one-line "create new" row.
 * The freshly-minted token is shown EXACTLY ONCE (returned by POST
 * and rendered with a Copy button + a red warning). After dismissal
 * the token is unrecoverable — same as GitHub / Stripe.
 */
export function ApiKeysSection() {
  const [keys, setKeys] = useState<ApiKeySummary[] | null>(null);
  const [label, setLabel] = useState('');
  const [creating, setCreating] = useState(false);
  const [revealedToken, setRevealedToken] = useState<{
    token: string;
    label: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function load() {
    try {
      setKeys(await api.listApiKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function create() {
    if (label.trim() === '') {
      setError('Label is required.');
      return;
    }
    setCreating(true);
    setError(null);
    setInfo(null);
    try {
      const r = await api.createApiKey(label.trim());
      setRevealedToken({ token: r.token, label: r.key.label });
      setLabel('');
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(id: string, lbl: string) {
    if (!window.confirm(`Revoke API key "${lbl}"? Any script using it will start getting 401.`)) {
      return;
    }
    setError(null);
    try {
      await api.revokeApiKey(id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  async function copyToken() {
    if (revealedToken === null) return;
    try {
      await navigator.clipboard.writeText(revealedToken.token);
      setInfo('Token copied to clipboard.');
    } catch {
      setError('Clipboard copy failed (browser permission denied).');
    }
  }

  return (
    <div className="apikeys-section">
      <h3>API keys</h3>
      <p className="muted small">
        Read-only access to your own data over HTTP. Send the token as{' '}
        <code>Authorization: Bearer &lt;token&gt;</code>. Only GET requests
        are accepted; mutations always require a session.
      </p>

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner">{info}</div>}

      {revealedToken && (
        <div className="banner warn apikey-reveal">
          <div>
            <strong>{revealedToken.label}</strong> — copy this token now.
            We don't store the raw token; if you lose it, revoke and mint a
            new one.
          </div>
          <code className="apikey-token">{revealedToken.token}</code>
          <div className="apikey-reveal-actions">
            <button
              type="button"
              className="btn secondary"
              onClick={() => void copyToken()}
            >
              Copy token
            </button>
            <button
              type="button"
              className="btn-link"
              onClick={() => setRevealedToken(null)}
            >
              I've saved it — dismiss
            </button>
          </div>
        </div>
      )}

      {keys === null ? (
        <p className="empty">Loading…</p>
      ) : keys.length === 0 ? (
        <p className="empty">No API keys yet.</p>
      ) : (
        <table className="apikeys-table">
          <thead>
            <tr>
              <th>Label</th>
              <th>Prefix</th>
              <th>Last used</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id}>
                <td>{k.label}</td>
                <td><code>{k.key_prefix}…</code></td>
                <td>
                  {k.last_used_at
                    ? formatRelative(k.last_used_at)
                    : 'never'}
                </td>
                <td>
                  {k.revoked_at ? (
                    <span className="muted">revoked</span>
                  ) : (
                    <span className="num pos">active</span>
                  )}
                </td>
                <td>
                  {!k.revoked_at && (
                    <button
                      type="button"
                      className="btn-link danger"
                      onClick={() => void revoke(k.id, k.label)}
                    >
                      Revoke
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="apikeys-create-row">
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Label (e.g. 'home dashboard script')"
          maxLength={200}
        />
        <button
          type="button"
          className="btn"
          onClick={() => void create()}
          disabled={creating || label.trim() === ''}
        >
          {creating ? 'Creating…' : 'Create API key'}
        </button>
      </div>
    </div>
  );
}
