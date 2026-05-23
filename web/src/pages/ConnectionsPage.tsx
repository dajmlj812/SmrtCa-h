import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Account,
  type OfxDcAccountType,
  type OfxDcConnection,
  type OfxDcConnectionInput,
} from '../api';
import { formatDate } from '../format';
import { PlaidSection } from '../components/PlaidSection';

/**
 * Phase 8.1 (0.11.1) — Bank Connections via OFX Direct Connect.
 *
 * Connections are tenant-scoped. Tenant admins manage them; spouses
 * can run Sync / Test but can't create or edit. Children never see
 * the page (the nav link is gated upstream).
 *
 * Resolving the OFX coordinates (URL / Org / FID) for a given bank
 * is the user's job — https://www.ofxhome.com keeps an updated list.
 */

const ACCT_TYPES: OfxDcAccountType[] = [
  'CHECKING',
  'SAVINGS',
  'MONEYMRKT',
  'CREDITLINE',
  'CREDITCARD',
];

const EMPTY_FORM: OfxDcConnectionInput = {
  accountId: '',
  name: '',
  ofxUrl: '',
  ofxOrg: '',
  ofxFid: '',
  ofxAppId: 'QWIN',
  ofxAppVersion: '2700',
  intuBid: '',
  username: '',
  password: '',
  bankAcctId: '',
  bankAcctType: 'CHECKING',
  bankId: '',
  enabled: true,
};

export function ConnectionsPage() {
  const [connections, setConnections] = useState<OfxDcConnection[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [form, setForm] = useState<OfxDcConnectionInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function refresh() {
    try {
      const [c, a] = await Promise.all([
        api.listOfxDcConnections(),
        api.listAccounts(),
      ]);
      setConnections(c);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  function startEdit(c: OfxDcConnection) {
    setEditingId(c.id);
    setForm({
      accountId: c.account_id,
      name: c.name,
      ofxUrl: c.ofx_url,
      ofxOrg: c.ofx_org,
      ofxFid: c.ofx_fid,
      ofxAppId: c.ofx_app_id,
      ofxAppVersion: c.ofx_app_version,
      intuBid: c.intu_bid ?? '',
      username: '',
      password: '',
      bankAcctId: c.bank_acct_id,
      bankAcctType: c.bank_acct_type,
      bankId: c.bank_id ?? '',
      enabled: c.enabled,
    });
    setError(null);
    setLastResult(null);
  }

  function resetForm() {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setError(null);
    setLastResult(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy('save');
    try {
      if (editingId) {
        await api.updateOfxDcConnection(editingId, form);
      } else {
        await api.createOfxDcConnection(form);
      }
      resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function onTest(id: string) {
    setBusy(`test-${id}`);
    setLastResult(null);
    try {
      const r = await api.testOfxDcConnection(id);
      setLastResult(
        r.ok
          ? `Test OK — parsed ${r.parsedCount ?? 0} txn(s)`
          : `Test failed: ${r.error}`,
      );
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Test failed';
      setLastResult(`Test failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  async function onSync(id: string) {
    setBusy(`sync-${id}`);
    setLastResult(null);
    try {
      const r = await api.syncOfxDcConnection(id);
      setLastResult(
        r.ok
          ? `Sync OK — imported ${r.importedCount ?? 0}, skipped ${r.skippedCount ?? 0}`
          : `Sync failed: ${r.error}`,
      );
      await refresh();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Sync failed';
      setLastResult(`Sync failed: ${msg}`);
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(id: string) {
    if (!confirm('Delete this bank connection? Synced transactions stay.'))
      return;
    setBusy(`delete-${id}`);
    try {
      await api.deleteOfxDcConnection(id);
      if (editingId === id) resetForm();
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  function statusLabel(s: OfxDcConnection['last_sync_status']): string {
    switch (s) {
      case 'ok':
        return 'OK';
      case 'never':
        return 'Never';
      case 'auth_failed':
        return 'Auth failed';
      case 'http_error':
        return 'HTTP error';
      case 'parse_error':
        return 'Parse error';
      case 'transport_error':
        return 'Transport error';
      default:
        return s;
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Bank Connections</h1>
          <div className="subtitle">
            Pull transactions directly from banks that speak OFX Direct
            Connect. Find your bank's OFX coordinates at{' '}
            <a
              href="https://www.ofxhome.com"
              target="_blank"
              rel="noreferrer"
            >
              ofxhome.com
            </a>
            .
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {lastResult && <div className="banner info">{lastResult}</div>}

      <div className="card row-gap">
        <div className="section-title">
          {editingId ? 'Edit connection' : 'Add a connection'}
        </div>
        <form onSubmit={onSubmit} className="form-grid">
          <div className="field">
            <label>Display name *</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>SmrtCash account *</label>
            <select
              value={form.accountId}
              onChange={(e) => setForm({ ...form, accountId: e.target.value })}
              required
            >
              <option value="">Select…</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>OFX URL *</label>
            <input
              value={form.ofxUrl}
              placeholder="https://ofx.bank.com/eftxweb/access.ofx"
              onChange={(e) => setForm({ ...form, ofxUrl: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>OFX Org *</label>
            <input
              value={form.ofxOrg}
              onChange={(e) => setForm({ ...form, ofxOrg: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>OFX FID *</label>
            <input
              value={form.ofxFid}
              onChange={(e) => setForm({ ...form, ofxFid: e.target.value })}
              required
            />
          </div>
          <div className="field">
            <label>Intuit BID (some banks)</label>
            <input
              value={form.intuBid ?? ''}
              onChange={(e) => setForm({ ...form, intuBid: e.target.value })}
            />
          </div>
          <div className="field">
            <label>App ID</label>
            <input
              value={form.ofxAppId ?? 'QWIN'}
              onChange={(e) => setForm({ ...form, ofxAppId: e.target.value })}
            />
          </div>
          <div className="field">
            <label>App version</label>
            <input
              value={form.ofxAppVersion ?? '2700'}
              onChange={(e) =>
                setForm({ ...form, ofxAppVersion: e.target.value })
              }
            />
          </div>
          <div className="field">
            <label>Bank routing # (bank accts only)</label>
            <input
              value={form.bankId ?? ''}
              onChange={(e) => setForm({ ...form, bankId: e.target.value })}
            />
          </div>
          <div className="field">
            <label>Bank account # *</label>
            <input
              value={form.bankAcctId}
              onChange={(e) =>
                setForm({ ...form, bankAcctId: e.target.value })
              }
              required
            />
          </div>
          <div className="field">
            <label>Bank account type *</label>
            <select
              value={form.bankAcctType}
              onChange={(e) =>
                setForm({
                  ...form,
                  bankAcctType: e.target.value as OfxDcAccountType,
                })
              }
            >
              {ACCT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label>OFX username {editingId ? '' : '*'}</label>
            <input
              value={form.username ?? ''}
              autoComplete="off"
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required={!editingId}
            />
          </div>
          <div className="field">
            <label>
              OFX password {editingId ? '(blank = keep current)' : '*'}
            </label>
            <input
              type="password"
              value={form.password ?? ''}
              autoComplete="new-password"
              onChange={(e) => setForm({ ...form, password: e.target.value })}
              required={!editingId}
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <label>
              <input
                type="checkbox"
                checked={form.enabled ?? true}
                onChange={(e) =>
                  setForm({ ...form, enabled: e.target.checked })
                }
              />{' '}
              Enabled
            </label>
          </div>
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <button className="btn" type="submit" disabled={busy !== null}>
              {busy === 'save'
                ? 'Saving…'
                : editingId
                ? 'Save changes'
                : 'Add connection'}
            </button>
            {editingId && (
              <button
                className="btn secondary"
                type="button"
                style={{ marginLeft: 8 }}
                onClick={resetForm}
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      <div className="section-title" style={{ marginTop: 24 }}>
        Connections
      </div>
      <PlaidSection accounts={accounts} />

      {connections.length === 0 ? (
        <p className="empty">No bank connections yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Bank</th>
                <th>Account</th>
                <th>Last sync</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {connections.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}</td>
                  <td>
                    {c.ofx_org} / {c.ofx_fid}
                  </td>
                  <td>
                    {c.bank_acct_type} ····{c.bank_acct_id.slice(-4)}
                  </td>
                  <td>
                    {c.last_sync_at
                      ? formatDate(c.last_sync_at)
                      : '—'}
                  </td>
                  <td>
                    <span
                      className={
                        c.last_sync_status === 'ok'
                          ? 'pill pos'
                          : c.last_sync_status === 'never'
                          ? 'pill muted'
                          : 'pill neg'
                      }
                    >
                      {statusLabel(c.last_sync_status)}
                    </span>
                    {c.last_sync_error && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {c.last_sync_error}
                      </div>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      onClick={() => void onTest(c.id)}
                      disabled={busy !== null}
                    >
                      {busy === `test-${c.id}` ? 'Testing…' : 'Test'}
                    </button>
                    <button
                      className="btn small"
                      onClick={() => void onSync(c.id)}
                      disabled={busy !== null || !c.enabled}
                    >
                      {busy === `sync-${c.id}` ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button
                      className="btn small secondary"
                      onClick={() => startEdit(c)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => void onDelete(c.id)}
                      disabled={busy !== null}
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
  );
}
