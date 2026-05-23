import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  type AuthProviderConfig,
  type Invitation,
  type MeResponse,
  type Member,
} from '../api';

/**
 * /workspace — tenant administration: members, invitations, and the
 * configured auth providers. Visible to admins + owners.
 *
 * The page composes three independent sections so a permissions issue
 * (e.g. non-owner can't edit providers) only disables that section.
 */

export function WorkspacePage() {
  const [me, setMe] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function loadMe() {
    try {
      const r = await api.authMe();
      setMe(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load profile');
    }
  }
  useEffect(() => {
    void loadMe();
  }, []);

  const activeTenant = useMemo(() => {
    if (!me) return null;
    return (
      me.memberships.find((m) => m.tenant_id === me.active_tenant_id) ?? null
    );
  }, [me]);
  const myRole = activeTenant?.role ?? null;
  // Phase 9: roles collapse to admin / spouse / child. Admin is the
  // only role that can manage members + providers; spouse and child
  // are functionally restricted within the tenant.
  const isAdmin = myRole === 'admin';
  const isOwner = myRole === 'admin'; // kept for the JSX below; semantically "is the manager"

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Workspace</h1>
          <div className="subtitle">
            {activeTenant ? (
              <>
                Managing <strong>{activeTenant.tenant_name}</strong> ·{' '}
                you are a <strong>{activeTenant.role}</strong>
              </>
            ) : (
              'No active workspace'
            )}
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {!me || !activeTenant ? (
        <p className="empty">Loading…</p>
      ) : (
        <>
          <MembersSection
            tenantId={activeTenant.tenant_id}
            canManage={isOwner}
            currentUserId={me.user.id}
          />
          <InvitationsSection
            tenantId={activeTenant.tenant_id}
            canManage={isAdmin}
          />
          <AuthProvidersSection canManage={isOwner} />
        </>
      )}
    </div>
  );
}

// ── Members ──────────────────────────────────────────────────
function MembersSection({
  tenantId,
  canManage,
  currentUserId,
}: {
  tenantId: string;
  canManage: boolean;
  currentUserId: string;
}) {
  const [members, setMembers] = useState<Member[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [assigningChild, setAssigningChild] = useState<Member | null>(null);

  async function load() {
    try {
      const m = await api.listMembers(tenantId);
      setMembers(m);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load members');
    }
  }
  useEffect(() => {
    void load();
  }, [tenantId]);

  async function remove(userId: string) {
    if (!window.confirm('Remove this member from the workspace?')) return;
    setBusy(true);
    try {
      await api.removeMember(tenantId, userId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Remove failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="page-section">
      <div className="page-section-head">
        <h2>Members</h2>
        <span className="muted">{members.length} total</span>
      </div>
      {err && <div className="banner error">{err}</div>}
      <div className="table-wrap">
        <table className="txn-table">
          <thead>
            <tr>
              <th>Email</th>
              <th>Name</th>
              <th>Role</th>
              <th>Joined</th>
              <th>Last login</th>
              {canManage && <th></th>}
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.user_id}>
                <td>{m.email ?? '—'}</td>
                <td>{m.name ?? '—'}</td>
                <td>
                  <span className={`pill status-${m.role === 'admin' ? 'keep' : m.role === 'child' ? 'review' : 'active'}-pill`}>
                    {m.role}
                  </span>
                </td>
                <td className="nowrap">{m.created_at.slice(0, 10)}</td>
                <td className="nowrap">
                  {m.last_login_at ? m.last_login_at.slice(0, 10) : '—'}
                </td>
                {canManage && (
                  <td>
                    {m.role === 'child' && (
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => setAssigningChild(m)}
                      >
                        Accounts
                      </button>
                    )}
                    {m.user_id !== currentUserId && m.role !== 'admin' && (
                      <button
                        className="btn-link danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(m.user_id)}
                      >
                        Remove
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {assigningChild && (
        <ChildAccountsModal
          tenantId={tenantId}
          member={assigningChild}
          onClose={() => setAssigningChild(null)}
          onSaved={() => setAssigningChild(null)}
        />
      )}
    </div>
  );
}

function ChildAccountsModal({
  tenantId,
  member,
  onClose,
  onSaved,
}: {
  tenantId: string;
  member: Member;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [allAccounts, setAllAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    Promise.all([
      api.listAccounts(),
      api.listMemberAccounts(tenantId, member.user_id),
    ])
      .then(([all, current]) => {
        setAllAccounts(all.map((a) => ({ id: a.id, name: a.name })));
        setSelected(new Set(current.map((c) => c.account_id)));
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false));
  }, [tenantId, member.user_id]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.setMemberAccounts(tenantId, member.user_id, Array.from(selected));
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>Accounts visible to {member.name ?? member.email ?? 'this child'}</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        {error && <div className="banner error">{error}</div>}
        {loading ? (
          <p className="empty">Loading…</p>
        ) : (
          <>
            <p className="muted">
              Children only see transactions on accounts you check below.
              Their copy of the app hides everything else.
            </p>
            <div style={{ maxHeight: 320, overflowY: 'auto', margin: '8px 0' }}>
              {allAccounts.map((a) => (
                <label key={a.id} style={{ display: 'block', padding: '4px 0' }}>
                  <input
                    type="checkbox"
                    checked={selected.has(a.id)}
                    onChange={() => toggle(a.id)}
                  />{' '}
                  {a.name}
                </label>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <button className="btn" type="button" disabled={saving} onClick={() => void save()}>
                {saving ? 'Saving…' : 'Save assignments'}
              </button>
              <button className="btn secondary" type="button" onClick={onClose}>
                Cancel
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ── Invitations ──────────────────────────────────────────────
function InvitationsSection({
  tenantId,
  canManage,
}: {
  tenantId: string;
  canManage: boolean;
}) {
  const [invitations, setInvitations] = useState<Invitation[]>([]);
  const [showForm, setShowForm] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load() {
    try {
      const r = await api.listInvitations(tenantId);
      setInvitations(r);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Failed to load invitations');
    }
  }
  useEffect(() => {
    if (canManage) void load();
  }, [tenantId, canManage]);

  async function revoke(invId: string) {
    if (!window.confirm('Revoke this invitation?')) return;
    try {
      await api.revokeInvitation(tenantId, invId);
      await load();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Revoke failed');
    }
  }

  if (!canManage) return null;

  return (
    <div className="page-section">
      <div className="page-section-head">
        <h2>Invitations</h2>
        <button className="btn" type="button" onClick={() => setShowForm((s) => !s)}>
          {showForm ? 'Cancel' : 'New invite'}
        </button>
      </div>
      {err && <div className="banner error">{err}</div>}
      {showForm && (
        <InviteForm
          tenantId={tenantId}
          onSaved={() => {
            setShowForm(false);
            void load();
          }}
        />
      )}
      {invitations.length === 0 ? (
        <p className="empty">No pending invitations.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Email hint</th>
                <th>Role</th>
                <th>Expires</th>
                <th>Status</th>
                <th>Link</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {invitations.map((inv) => {
                const url = `${window.location.origin}/invite/${inv.token}`;
                const expired = new Date(inv.expires_at).getTime() < Date.now();
                return (
                  <tr key={inv.id}>
                    <td>{inv.email_hint ?? '—'}</td>
                    <td>{inv.role}</td>
                    <td className="nowrap">{inv.expires_at.slice(0, 10)}</td>
                    <td>
                      {inv.accepted_at ? (
                        <span className="pill status-keep-pill">accepted</span>
                      ) : expired ? (
                        <span className="pill status-cancel-pill">expired</span>
                      ) : (
                        <span className="pill status-review-pill">pending</span>
                      )}
                    </td>
                    <td>
                      {inv.accepted_at ? (
                        '—'
                      ) : (
                        <button
                          type="button"
                          className="btn-link"
                          onClick={() => void navigator.clipboard.writeText(url)}
                          title={url}
                        >
                          Copy
                        </button>
                      )}
                    </td>
                    <td>
                      {!inv.accepted_at && (
                        <button
                          className="btn-link danger"
                          type="button"
                          onClick={() => void revoke(inv.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function InviteForm({
  tenantId,
  onSaved,
}: {
  tenantId: string;
  onSaved: () => void;
}) {
  const [emailHint, setEmailHint] = useState('');
  const [role, setRole] = useState<'admin' | 'spouse' | 'child'>('spouse');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const r = await api.createInvitation(tenantId, {
        emailHint: emailHint.trim() || undefined,
        role,
      });
      // When email was requested but didn't send, leave the form open
      // with the reason so the user can decide whether to fix SMTP or
      // fall back to copy-link.
      if (emailHint.trim() && !r.email.sent) {
        setError(
          `Invitation created, but email not sent: ${r.email.reason ?? 'unknown'}. Close this form to copy the link from the list below.`,
        );
        return;
      }
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Create failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="card" style={{ padding: 12 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label htmlFor="inv-email">
            Email hint <span className="muted">(optional, for your records)</span>
          </label>
          <input
            id="inv-email"
            type="email"
            value={emailHint}
            onChange={(e) => setEmailHint(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="inv-role">Role</label>
          <select
            id="inv-role"
            value={role}
            onChange={(e) => setRole(e.target.value as typeof role)}
          >
            <option value="admin">admin (co-manager)</option>
            <option value="spouse">spouse (full access)</option>
            <option value="child">child (own accounts only)</option>
          </select>
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={submitting}>
          {submitting ? 'Creating…' : 'Create invite'}
        </button>
      </div>
    </form>
  );
}

// ── Auth providers ───────────────────────────────────────────
function AuthProvidersSection({ canManage }: { canManage: boolean }) {
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
        {canManage && (
          <button className="btn" type="button" onClick={() => setShowForm((s) => !s)}>
            {showForm ? 'Cancel' : 'Add provider'}
          </button>
        )}
      </div>
      {err && <div className="banner error">{err}</div>}
      <div className="banner info">
        Local email + password is always available and isn't listed here.
        Add OIDC providers (Google / Microsoft / GitHub / any spec-compliant
        IdP) so members can sign in with SSO. SAML is queued for a later
        release.
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
                {canManage && <th></th>}
              </tr>
            </thead>
            <tbody>
              {providers.map((p) => (
                <tr key={p.id}>
                  <td>{p.display_name}</td>
                  <td>{p.kind}</td>
                  <td><code>{p.slug}</code></td>
                  <td>
                    <input
                      type="checkbox"
                      checked={p.enabled}
                      disabled={!canManage}
                      onChange={(e) => void toggle(p.id, e.target.checked)}
                    />
                  </td>
                  <td className="nowrap">{p.updated_at.slice(0, 10)}</td>
                  {canManage && (
                    <td>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void remove(p.id)}
                      >
                        Remove
                      </button>
                    </td>
                  )}
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
        enabled: false, // require explicit toggle after config validation
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
