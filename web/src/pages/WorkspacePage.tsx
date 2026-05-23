import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  api,
  type Invitation,
  type MeResponse,
  type Member,
} from '../api';

/**
 * /workspace — tenant administration: members + invitations.
 *
 * Auth providers moved to /system (super-admin only) in 0.9.2; SMTP /
 * Backups / Health / Security are likewise super-admin scoped now.
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
          {isAdmin && <PortabilitySection />}
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
  const [permissions, setPermissions] = useState<
    Map<string, 'read' | 'read_write'>
  >(new Map());
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
        setPermissions(
          new Map(current.map((c) => [c.account_id, c.permission])),
        );
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : 'Load failed'))
      .finally(() => setLoading(false));
  }, [tenantId, member.user_id]);

  function toggleAccount(id: string) {
    setPermissions((prev) => {
      const next = new Map(prev);
      if (next.has(id)) next.delete(id);
      else next.set(id, 'read_write');
      return next;
    });
  }

  function setPerm(id: string, p: 'read' | 'read_write') {
    setPermissions((prev) => new Map(prev).set(id, p));
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const accounts = [...permissions.entries()].map(([accountId, permission]) => ({
        accountId,
        permission,
      }));
      await api.setMemberAccounts(tenantId, member.user_id, accounts);
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
              Check the accounts this member can see. For each one, pick
              read-only (view) or read+write (can edit). Leaving every box
              unchecked makes a spouse fully unrestricted (legacy
              behavior); a child with no checks sees nothing.
            </p>
            <div style={{ maxHeight: 320, overflowY: 'auto', margin: '8px 0' }}>
              {allAccounts.map((a) => {
                const perm = permissions.get(a.id);
                return (
                  <div
                    key={a.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '4px 0',
                    }}
                  >
                    <label style={{ flex: 1 }}>
                      <input
                        type="checkbox"
                        checked={perm !== undefined}
                        onChange={() => toggleAccount(a.id)}
                      />{' '}
                      {a.name}
                    </label>
                    <select
                      value={perm ?? 'read_write'}
                      disabled={perm === undefined}
                      onChange={(e) =>
                        setPerm(a.id, e.target.value as 'read' | 'read_write')
                      }
                      style={{ fontSize: 13 }}
                    >
                      <option value="read_write">read + write</option>
                      <option value="read">read only</option>
                    </select>
                  </div>
                );
              })}
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

/**
 * 0.13.0 — data-portability section. Admin-only.
 *
 * One button. Triggers /api/portability/export, the browser handles
 * the download. After a successful run, shows the response's row
 * counts so the user knows what they got.
 */
function PortabilitySection() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCounts, setLastCounts] = useState<Record<string, number> | null>(
    null,
  );
  const [lastBytes, setLastBytes] = useState<number | null>(null);

  async function runExport() {
    setBusy(true);
    setError(null);
    setLastCounts(null);
    setLastBytes(null);
    try {
      const res = await fetch('/api/portability/export', {
        method: 'GET',
        credentials: 'same-origin',
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(text || `Export failed (${res.status})`);
      }
      const countsHeader = res.headers.get('X-Smrtcash-Counts');
      const counts = countsHeader
        ? (JSON.parse(countsHeader) as Record<string, number>)
        : null;
      const dispo = res.headers.get('Content-Disposition') ?? '';
      const filename =
        dispo.match(/filename="([^"]+)"/)?.[1] ?? 'smrtcash-export.tar.gz';
      const blob = await res.blob();
      setLastBytes(blob.size);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      setLastCounts(counts);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Export failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="card row-gap" style={{ marginTop: 24 }}>
      <div className="section-title">Data portability</div>
      <p className="muted">
        Download a portable archive of <strong>everything</strong> in this
        tenant — accounts, transactions, categories, budgets, goals, bills,
        holdings, attachments. Structured JSON inside a <code>.tar.gz</code>{' '}
        you can re-import or open in any tool. Encrypted credentials
        (OFX-DC, Plaid tokens) are stripped — secrets don't travel.
      </p>
      {error && <div className="banner error">{error}</div>}
      {lastCounts && (
        <div className="banner info">
          Exported{' '}
          {lastBytes ? `${(lastBytes / 1024).toFixed(1)} KB` : 'archive'} —{' '}
          {lastCounts.accounts ?? 0} accounts,{' '}
          {lastCounts.transactions ?? 0} transactions,{' '}
          {lastCounts.categories ?? 0} categories,{' '}
          {lastCounts.attachments ?? 0} attachments.
        </div>
      )}
      <div>
        <button className="btn" onClick={() => void runExport()} disabled={busy}>
          {busy ? 'Exporting…' : 'Export all my data'}
        </button>
      </div>
    </div>
  );
}
