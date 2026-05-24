import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, type SystemSubscriptionRow } from '../api';
import { AuthProvidersSection } from '../components/AuthProvidersSection';
import { ExchangeRatesSection } from '../components/ExchangeRatesSection';
import { AutoSyncSection } from '../components/AutoSyncSection';

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
 * /system — super-admin console. Three tabs:
 *
 *   overview     — list tenants with safe stats (counts only — never
 *                  balances or transaction descriptions). Create new
 *                  tenants. Invite a tenant admin. Manage super-admin
 *                  operators.
 *
 *   subscriptions — 0.16.1 — every tenant's billing state on one
 *                  screen. Grant courtesy access, force-sync from
 *                  Stripe, or force-cancel locally. All actions
 *                  audit-log.
 *
 *   audit        — chronological log of mutating actions across the
 *                  platform. Filterable by tenant + action.
 *
 * Super-admin sessions never have a tenant context, so every link
 * here is system-scoped. There are no links into a tenant's data —
 * by design.
 */

export function SystemPage({
  tab,
}: {
  tab: 'overview' | 'audit' | 'subscriptions';
}) {
  if (tab === 'audit') return <AuditTab />;
  if (tab === 'subscriptions') return <SubscriptionsTab />;
  return <OverviewTab />;
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

      <ExchangeRatesSection />

      <AutoSyncSection />

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

// ── 0.16.1: Subscriptions tab ─────────────────────────────────

type StatusFilter = 'all' | 'paying' | 'trialing' | 'past_due' | 'none';
type PlanKey = 'starter' | 'plus' | 'family';

function isPaying(s: SystemSubscriptionRow['status']): boolean {
  return s === 'trialing' || s === 'active' || s === 'past_due';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

function SubscriptionsTab() {
  const [rows, setRows] = useState<SystemSubscriptionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [filter, setFilter] = useState<StatusFilter>('all');
  const [searchText, setSearchText] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [grantTarget, setGrantTarget] = useState<SystemSubscriptionRow | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.systemListSubscriptions();
      setRows(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (filter === 'paying' && !isPaying(r.status)) return false;
      if (filter === 'trialing' && r.status !== 'trialing') return false;
      if (filter === 'past_due' && r.status !== 'past_due') return false;
      if (filter === 'none' && r.status !== null) return false;
      if (searchText.trim() !== '') {
        const q = searchText.trim().toLowerCase();
        const hay = `${r.tenant_name} ${r.tenant_slug} ${r.stripe_customer_id ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [rows, filter, searchText]);

  const summary = useMemo(() => {
    const out = {
      total: rows.length,
      paying: 0,
      trialing: 0,
      past_due: 0,
      none: 0,
    };
    for (const r of rows) {
      if (isPaying(r.status)) out.paying++;
      if (r.status === 'trialing') out.trialing++;
      if (r.status === 'past_due') out.past_due++;
      if (r.status === null) out.none++;
    }
    return out;
  }, [rows]);

  async function syncFromStripe(row: SystemSubscriptionRow) {
    if (!row.stripe_subscription_id) return;
    setBusy(`sync-${row.tenant_id}`);
    setError(null);
    setSuccess(null);
    try {
      await api.systemSyncSubscription(row.tenant_id);
      setSuccess(`Synced ${row.tenant_name} from Stripe.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(null);
    }
  }

  async function forceCancel(row: SystemSubscriptionRow) {
    if (
      !confirm(
        `Force-cancel ${row.tenant_name}'s subscription LOCALLY?\n\n` +
          `This clears the row in our database but does NOT touch Stripe. ` +
          `If Stripe still considers their subscription active you must cancel it ` +
          `from the Stripe dashboard separately, or the next webhook will recreate the row.`,
      )
    )
      return;
    setBusy(`del-${row.tenant_id}`);
    setError(null);
    setSuccess(null);
    try {
      await api.systemForceCancelSubscription(row.tenant_id);
      setSuccess(`Cleared local subscription for ${row.tenant_name}.`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Subscriptions</h1>
          <div className="subtitle">
            Every tenant's billing state. Actions audit-log. Stripe stays
            the source of truth — use <em>Sync</em> after a webhook miss
            rather than hand-editing.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {success && <div className="banner success">{success}</div>}

      <div className="health-counts" style={{ marginBottom: 16 }}>
        <span className="health-count">
          <strong>{summary.total}</strong> tenants
        </span>
        <span className="health-count">
          <strong>{summary.paying}</strong> paying
        </span>
        <span className="health-count">
          <strong>{summary.trialing}</strong> trialing
        </span>
        <span className="health-count">
          <strong>{summary.past_due}</strong> past due
        </span>
        <span className="health-count">
          <strong>{summary.none}</strong> no plan
        </span>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 }}>
        <select
          value={filter}
          onChange={(e) => setFilter(e.target.value as StatusFilter)}
        >
          <option value="all">All ({summary.total})</option>
          <option value="paying">Paying ({summary.paying})</option>
          <option value="trialing">Trialing ({summary.trialing})</option>
          <option value="past_due">Past due ({summary.past_due})</option>
          <option value="none">No plan ({summary.none})</option>
        </select>
        <input
          type="search"
          placeholder="Search name / slug / Stripe customer id…"
          value={searchText}
          onChange={(e) => setSearchText(e.target.value)}
          style={{ flex: 1, maxWidth: 360 }}
        />
        <button className="btn secondary" type="button" onClick={() => void load()}>
          Refresh
        </button>
      </div>

      {loading ? (
        <p className="empty">Loading…</p>
      ) : filtered.length === 0 ? (
        <p className="empty">No tenants match the current filter.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Tenant</th>
                <th>Plan</th>
                <th>Status</th>
                <th>Trial end</th>
                <th>Renews</th>
                <th>Stripe customer</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <tr key={r.tenant_id}>
                  <td>
                    <div>
                      <strong>{r.tenant_name}</strong>
                    </div>
                    <div className="muted small">
                      {r.tenant_slug} · {r.member_count} member
                      {r.member_count === 1 ? '' : 's'}
                    </div>
                  </td>
                  <td>{r.plan_id ?? <span className="muted">—</span>}</td>
                  <td>
                    {r.status ? (
                      <span className={`pill ${pillClass(r.status)}`}>
                        {r.status.replace(/_/g, ' ')}
                        {r.cancel_at_period_end && ' · ending'}
                      </span>
                    ) : (
                      <span className="muted">No subscription</span>
                    )}
                  </td>
                  <td>{formatDate(r.trial_end)}</td>
                  <td>{formatDate(r.current_period_end)}</td>
                  <td>
                    {r.stripe_customer_id ? (
                      <code style={{ fontSize: '0.85em' }}>{r.stripe_customer_id}</code>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      type="button"
                      disabled={busy !== null}
                      onClick={() => setGrantTarget(r)}
                    >
                      Grant
                    </button>
                    {r.stripe_subscription_id && (
                      <button
                        className="btn small secondary"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void syncFromStripe(r)}
                      >
                        {busy === `sync-${r.tenant_id}` ? 'Syncing…' : 'Sync'}
                      </button>
                    )}
                    {r.status && (
                      <button
                        className="btn small danger"
                        type="button"
                        disabled={busy !== null}
                        onClick={() => void forceCancel(r)}
                      >
                        {busy === `del-${r.tenant_id}` ? 'Cancelling…' : 'Force cancel'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {grantTarget && (
        <GrantModal
          row={grantTarget}
          onClose={() => setGrantTarget(null)}
          onGranted={() => {
            setGrantTarget(null);
            setSuccess(`Granted subscription to ${grantTarget.tenant_name}.`);
            void load();
          }}
        />
      )}
    </div>
  );
}

function pillClass(status: NonNullable<SystemSubscriptionRow['status']>): string {
  switch (status) {
    case 'trialing':
    case 'active':
      return 'pos';
    case 'past_due':
    case 'incomplete':
    case 'unpaid':
      return 'warn';
    case 'canceled':
    case 'incomplete_expired':
    case 'paused':
      return 'muted';
    default:
      return 'muted';
  }
}

function GrantModal({
  row,
  onClose,
  onGranted,
}: {
  row: SystemSubscriptionRow;
  onClose: () => void;
  onGranted: () => void;
}) {
  const [plan, setPlan] = useState<PlanKey>('plus');
  const [days, setDays] = useState(30);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      await api.systemGrantSubscription(row.tenant_id, {
        plan,
        days,
        reason: reason.trim() || undefined,
      });
      onGranted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Grant failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>Grant courtesy subscription</h2>
        <p className="muted">
          Tenant: <strong>{row.tenant_name}</strong>
        </p>
        <p className="muted small">
          Writes a local <code>subscriptions</code> row with status{' '}
          <code>active</code> and the chosen period. Does not touch Stripe.
          If the tenant later goes through Checkout the webhook overwrites
          this row.
        </p>
        {err && <div className="banner error">{err}</div>}
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="grant-plan">Plan</label>
            <select
              id="grant-plan"
              value={plan}
              onChange={(e) => setPlan(e.target.value as PlanKey)}
            >
              <option value="starter">Starter</option>
              <option value="plus">Plus</option>
              <option value="family">Family</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="grant-days">Days</label>
            <input
              id="grant-days"
              type="number"
              min={1}
              max={365}
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              required
            />
            <div className="hint">1–365 days.</div>
          </div>
          <div className="field">
            <label htmlFor="grant-reason">Reason (optional, audit-logged)</label>
            <input
              id="grant-reason"
              type="text"
              placeholder="e.g. apology credit, contest prize, internal demo"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="row-actions" style={{ marginTop: 12 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Granting…' : 'Grant'}
            </button>
            <button
              className="btn secondary"
              type="button"
              onClick={onClose}
              disabled={submitting}
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
