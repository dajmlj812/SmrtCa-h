import { useEffect, useState, type FormEvent } from 'react';
import { api } from '../api';
import { AuthProvidersSection } from '../components/AuthProvidersSection';

interface TenantRow {
  id: string;
  name: string;
  slug: string;
  created_at: string;
  member_count: number;
  account_count: number;
  transaction_count: number;
}

interface AuditEntry {
  id: string;
  occurred_at: string;
  tenant_id: string | null;
  actor_user_id: string | null;
  actor_kind: string;
  action: string;
  target_kind: string | null;
  target_id: string | null;
  details: Record<string, unknown>;
}

/**
 * /system — super-admin console. Two tabs:
 *
 *   overview  — list tenants with safe stats (counts only — never
 *               balances or transaction descriptions). Create new
 *               tenants. Invite a tenant admin. Manage super-admin
 *               operators.
 *
 *   audit     — chronological log of mutating actions across the
 *               platform. Filterable by tenant + action.
 *
 * Super-admin sessions never have a tenant context, so every link
 * here is system-scoped. There are no links into a tenant's data —
 * by design.
 */

export function SystemPage({ tab }: { tab: 'overview' | 'audit' }) {
  return tab === 'audit' ? <AuditTab /> : <OverviewTab />;
}

function OverviewTab() {
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [supers, setSupers] = useState<
    Array<{
      id: string;
      email: string | null;
      name: string | null;
      created_at: string;
      last_login_at: string | null;
    }>
  >([]);
  const [tenantUserCount, setTenantUserCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [showTenantForm, setShowTenantForm] = useState(false);
  const [showSuperForm, setShowSuperForm] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [t, u] = await Promise.all([
        api.systemListTenants(),
        api.systemListUsers(),
      ]);
      setTenants(t);
      setSupers(u.super_admins);
      setTenantUserCount(u.tenant_user_count);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function inviteAdmin(tenantId: string) {
    const emailHint = window.prompt(
      'Email of the tenant admin (used as a hint; the link itself is the credential):',
    );
    if (emailHint === null) return;
    try {
      const inv = await api.systemAdminInvite(tenantId, emailHint || undefined);
      const url = `${window.location.origin}/invite/${inv.token}`;
      await navigator.clipboard.writeText(url);
      setSuccess(`Admin invite copied to clipboard. Expires ${inv.expires_at.slice(0, 10)}.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to create invite');
    }
  }

  async function deleteTenant(t: TenantRow) {
    if (
      !window.confirm(
        `Permanently delete tenant "${t.name}"? This destroys ${t.account_count} account(s) and ${t.transaction_count.toLocaleString()} transaction(s). This cannot be undone.`,
      )
    ) {
      return;
    }
    try {
      await api.systemDeleteTenant(t.id);
      await load();
      setSuccess(`Tenant "${t.name}" deleted.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>System overview</h1>
          <div className="subtitle">
            Platform-wide view. Counts only — financial data lives in tenants
            and is off-limits to super admins.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {success && <div className="banner success">{success}</div>}

      <div className="page-section">
        <div className="page-section-head">
          <h2>Tenants</h2>
          <button
            className="btn"
            type="button"
            onClick={() => setShowTenantForm((s) => !s)}
          >
            {showTenantForm ? 'Cancel' : 'New tenant'}
          </button>
        </div>
        {showTenantForm && (
          <NewTenantForm
            onSaved={() => {
              setShowTenantForm(false);
              void load();
            }}
          />
        )}
        {loading ? (
          <p className="empty">Loading…</p>
        ) : tenants.length === 0 ? (
          <p className="empty">No tenants yet. Click <strong>New tenant</strong>.</p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Slug</th>
                  <th className="num">Members</th>
                  <th className="num">Accounts</th>
                  <th className="num">Transactions</th>
                  <th>Created</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {tenants.map((t) => (
                  <tr key={t.id}>
                    <td>{t.name}</td>
                    <td><code>{t.slug}</code></td>
                    <td className="num">{t.member_count.toLocaleString()}</td>
                    <td className="num">{t.account_count.toLocaleString()}</td>
                    <td className="num">{t.transaction_count.toLocaleString()}</td>
                    <td className="nowrap">{t.created_at.slice(0, 10)}</td>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => void inviteAdmin(t.id)}
                      >
                        Invite admin
                      </button>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void deleteTenant(t)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>Super admins</h2>
          <button
            className="btn"
            type="button"
            onClick={() => setShowSuperForm((s) => !s)}
          >
            {showSuperForm ? 'Cancel' : 'New super admin'}
          </button>
        </div>
        {showSuperForm && (
          <NewSuperForm
            onSaved={() => {
              setShowSuperForm(false);
              void load();
            }}
          />
        )}
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Created</th>
                <th>Last login</th>
              </tr>
            </thead>
            <tbody>
              {supers.map((s) => (
                <tr key={s.id}>
                  <td>{s.email ?? '—'}</td>
                  <td>{s.name ?? '—'}</td>
                  <td className="nowrap">{s.created_at.slice(0, 10)}</td>
                  <td className="nowrap">{s.last_login_at ? s.last_login_at.slice(0, 10) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted" style={{ marginTop: 8 }}>
          {tenantUserCount.toLocaleString()} non-super user{tenantUserCount === 1 ? '' : 's'}
          {' '}across all tenants.
        </p>
      </div>

      <AuthProvidersSection />
    </div>
  );
}

function NewTenantForm({ onSaved }: { onSaved: () => void }) {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.systemCreateTenant({ name: name.trim(), slug: slug.trim() });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ padding: 12 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>Display name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} required />
        </div>
        <div className="field">
          <label>Slug <span className="muted">(URL-safe, lowercase)</span></label>
          <input value={slug} onChange={(e) => setSlug(e.target.value)} required />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create tenant'}
        </button>
      </div>
    </form>
  );
}

function NewSuperForm({ onSaved }: { onSaved: () => void }) {
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.systemCreateSuperAdmin({
        email: email.trim(),
        name: name.trim() || undefined,
        password,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Create failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="card" style={{ padding: 12 }} onSubmit={submit}>
      {error && <div className="banner error">{error}</div>}
      <div className="form-grid">
        <div className="field">
          <label>Email</label>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label>Display name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field">
          <label>Password (≥ 8 chars)</label>
          <input
            type="password"
            value={password}
            minLength={8}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 8 }}>
        <button className="btn" type="submit" disabled={busy}>
          {busy ? 'Creating…' : 'Create super admin'}
        </button>
      </div>
    </form>
  );
}

function AuditTab() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tenantId, setTenantId] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<string>('');

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const opts: { tenantId?: string; action?: string; limit?: number } = {
        limit: 200,
      };
      if (tenantId.trim() !== '') opts.tenantId = tenantId.trim();
      if (actionFilter.trim() !== '') opts.action = actionFilter.trim();
      setEntries(await api.systemListAudit(opts));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load audit log');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Audit log</h1>
          <div className="subtitle">
            Mutating actions across the platform. Most recent first.
          </div>
        </div>
      </div>

      <div className="toolbar">
        <input
          type="text"
          placeholder='Tenant id (or "system")'
          value={tenantId}
          onChange={(e) => setTenantId(e.target.value)}
          style={{ width: 240 }}
        />
        <input
          type="text"
          placeholder="Action (e.g. tenant.create)"
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value)}
          style={{ width: 200 }}
        />
        <button className="btn secondary" type="button" onClick={() => void load()}>
          Apply
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading ? (
        <p className="empty">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="empty">No entries.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>When</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Target</th>
                <th>Tenant</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{e.occurred_at.slice(0, 19).replace('T', ' ')}</td>
                  <td>
                    <span className="pill status-active-pill">{e.actor_kind}</span>
                    {e.actor_user_id && (
                      <code style={{ fontSize: '0.8em', marginLeft: 4 }}>
                        {e.actor_user_id.slice(0, 8)}
                      </code>
                    )}
                  </td>
                  <td><code>{e.action}</code></td>
                  <td>
                    {e.target_kind && (
                      <span className="muted">{e.target_kind} </span>
                    )}
                    {e.target_id && (
                      <code style={{ fontSize: '0.85em' }}>
                        {e.target_id.length > 12 ? e.target_id.slice(0, 8) : e.target_id}
                      </code>
                    )}
                  </td>
                  <td>
                    {e.tenant_id ? (
                      <code style={{ fontSize: '0.8em' }}>{e.tenant_id.slice(0, 8)}</code>
                    ) : (
                      <span className="muted">system</span>
                    )}
                  </td>
                  <td>
                    {Object.keys(e.details).length > 0 && (
                      <code style={{ fontSize: '0.8em' }}>
                        {JSON.stringify(e.details).slice(0, 80)}
                      </code>
                    )}
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
