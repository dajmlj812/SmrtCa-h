import { useEffect, useState, type FormEvent } from 'react';
import { api, type AuthProviderConfig } from '../api';

/**
 * Auth provider management — super-admin only (0.9.2).
 *
 * Listed configs come from `auth_provider_configs`. Local password
 * isn't shown (it's implicit). OIDC configs can be added from a preset
 * (Google / Microsoft / GitHub — discovery URL is hardcoded) or as a
 * generic IdP with a user-supplied discovery URL. SAML configs are
 * accepted in the schema but their begin() throws "not implemented"
 * until the SAML provider lands.
 */
export function AuthProvidersSection() {
  const [providers, setProviders] = useState<AuthProviderConfig[]>([]);
  const [presets, setPresets] = useState<
    Array<{ slug: string; displayName: string; discoveryUrl: string }>
  >([]);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.listAuthProviderConfigs();
      setProviders(r.providers);
      setPresets(r.presets ?? []);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load providers');
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function toggle(id: string, enabled: boolean) {
    try {
      await api.updateAuthProviderConfig(id, { enabled });
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Toggle failed');
    }
  }
  async function remove(id: string) {
    if (!window.confirm('Remove this auth provider?')) return;
    try {
      await api.deleteAuthProviderConfig(id);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Remove failed');
    }
  }

  return (
    <div className="page-section">
      <div className="page-section-head">
        <h2>Auth providers</h2>
        <button className="btn" type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : 'Add provider'}
        </button>
      </div>
      {err && <div className="banner error">{err}</div>}
      <div className="banner info">
        Local email + password is always available and isn't listed here.
        Add OIDC providers (Google / Microsoft / GitHub / any spec-compliant
        IdP) so members across all tenants can sign in with SSO. SAML is
        queued for a later release.
      </div>
      {showForm && (
        <ProviderForm
          presets={presets}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      {providers.length === 0 ? (
        <p className="empty">No providers configured.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Display name</th>
                <th>Kind</th>
                <th>Slug</th>
                <th>Enabled</th>
                <th>Updated</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.display_name}</td>
                  <td>{p.kind}</td>
                  <td>
                    <code>{p.slug}</code>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      onChange={(e) => void toggle(p.id, e.target.checked)}
                    />
                  </td>
                  <td className="nowrap">{p.updated_at.slice(0, 10)}</td>
                  <td>
                    <button
                      className="btn-link danger"
                      type="button"
                      onClick={() => void remove(p.id)}
                    >
                      Remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ProviderForm({
  presets,
  onSaved,
}: {
  presets: Array<{ slug: string; displayName: string; discoveryUrl: string }>;
  onSaved: () => void;
}) {
  const [presetSlug, setPresetSlug] = useState<string>(presets[0]?.slug ?? '');
  const [useGeneric, setUseGeneric] = useState(false);
  const [genericSlug, setGenericSlug] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [redirectUri, setRedirectUri] = useState(
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/auth/oidc/<slug>/callback`
      : '',
  );
  const [discoveryUrl, setDiscoveryUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      const slug = useGeneric ? genericSlug.trim() : presetSlug;
      if (slug === '') {
        throw new Error('Pick a preset or set a custom slug');
      }
      const cfg: Record<string, unknown> = {
        client_id: clientId.trim(),
        client_secret: clientSecret.trim(),
        redirect_uri: redirectUri.replace('<slug>', slug),
      };
      if (useGeneric) {
        if (!discoveryUrl.trim().startsWith('http')) {
          throw new Error('Discovery URL must be an http(s) URL');
        }
        cfg.discovery_url = discoveryUrl.trim();
      }
      const finalDisplay =
        displayName.trim() ||
        (useGeneric
          ? slug
          : presets.find((p) => p.slug === slug)?.displayName ?? slug);
      await api.createAuthProviderConfig({
        kind: 'oidc',
        slug,
        displayName: finalDisplay,
        enabled: false,
        config: cfg,
      });
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" style={{ padding: 12 }} onSubmit={submit}>
      {err && <div className="banner error">{err}</div>}
      <div className="field">
        <label>
          <input
            type="radio"
            checked={!useGeneric}
            onChange={() => setUseGeneric(false)}
          />{' '}
          Use a preset (Google / Microsoft / GitHub)
        </label>
        {!useGeneric && (
          <select
            value={presetSlug}
            onChange={(e) => setPresetSlug(e.target.value)}
            style={{ marginLeft: 20, marginTop: 4 }}
          >
            {presets.map((p) => (
              <option key={p.slug} value={p.slug}>
                {p.displayName}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="field">
        <label>
          <input
            type="radio"
            checked={useGeneric}
            onChange={() => setUseGeneric(true)}
          />{' '}
          Generic OIDC (Okta, Authentik, Keycloak, Azure AD, etc.)
        </label>
        {useGeneric && (
          <div style={{ marginLeft: 20, marginTop: 4 }}>
            <input
              type="text"
              placeholder="slug (e.g. okta-prod)"
              value={genericSlug}
              onChange={(e) => setGenericSlug(e.target.value)}
              style={{ marginBottom: 4 }}
            />
            <input
              type="url"
              placeholder="Discovery URL (https://issuer/.well-known/openid-configuration)"
              value={discoveryUrl}
              onChange={(e) => setDiscoveryUrl(e.target.value)}
            />
          </div>
        )}
      </div>
      <div className="form-grid">
        <div className="field">
          <label>Display name</label>
          <input
            type="text"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="optional override"
          />
        </div>
        <div className="field">
          <label>Client ID</label>
          <input
            type="text"
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Client secret</label>
          <input
            type="password"
            value={clientSecret}
            onChange={(e) => setClientSecret(e.target.value)}
            required
          />
        </div>
        <div className="field" style={{ gridColumn: 'span 2' }}>
          <label>
            Redirect URI{' '}
            <span className="muted">
              (register this exact URL with the IdP; replace &lt;slug&gt;)
            </span>
          </label>
          <input
            type="url"
            value={redirectUri}
            onChange={(e) => setRedirectUri(e.target.value)}
            required
          />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'Saving…' : 'Save provider (disabled by default)'}
        </button>
      </div>
    </form>
  );
}
