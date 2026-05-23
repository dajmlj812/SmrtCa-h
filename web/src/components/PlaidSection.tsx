import { useEffect, useState } from 'react';
import {
  api,
  type Account,
  type PlaidAccountInfo,
  type PlaidItemSummary,
  type PlaidItemWithLinks,
} from '../api';
import { formatDate } from '../format';

/**
 * Phase 8.2 (0.11.2) — Plaid section on the Connections page.
 *
 * Renders only when `/api/plaid/status` reports enabled=true (i.e. a
 * super-admin has turned PLAID_ENABLED on and provided client_id +
 * secret + env). When disabled, the parent page hides this section
 * entirely — Plaid is invisible to tenants until they're opted in.
 *
 * The browser-side Plaid Link widget is loaded from cdn.plaid.com on
 * demand the first time the user clicks "Connect via Plaid". This is
 * the only external dependency in the entire app, and it only loads
 * if the user actively initiates a connection.
 */

interface PlaidLinkHandler {
  open: () => void;
}

interface PlaidLinkOptions {
  token: string;
  onSuccess: (publicToken: string) => void;
  onExit?: (err: unknown) => void;
}

declare global {
  interface Window {
    Plaid?: {
      create: (opts: PlaidLinkOptions) => PlaidLinkHandler;
    };
  }
}

const PLAID_LINK_SRC = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';

function loadPlaidLink(): Promise<NonNullable<Window['Plaid']>> {
  return new Promise((resolve, reject) => {
    if (window.Plaid) {
      resolve(window.Plaid);
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${PLAID_LINK_SRC}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => {
        if (window.Plaid) resolve(window.Plaid);
        else reject(new Error('Plaid Link did not register on window'));
      });
      existing.addEventListener('error', () =>
        reject(new Error('Failed to load Plaid Link script')),
      );
      return;
    }
    const script = document.createElement('script');
    script.src = PLAID_LINK_SRC;
    script.async = true;
    script.onload = () => {
      if (window.Plaid) resolve(window.Plaid);
      else reject(new Error('Plaid Link did not register on window'));
    };
    script.onerror = () => reject(new Error('Failed to load Plaid Link script'));
    document.head.appendChild(script);
  });
}

export function PlaidSection({ accounts }: { accounts: Account[] }) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [environment, setEnvironment] = useState<string | null>(null);
  const [items, setItems] = useState<PlaidItemWithLinks[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [pendingItem, setPendingItem] = useState<{
    item: PlaidItemSummary;
    accounts: PlaidAccountInfo[];
    mapping: Record<string, string>;
  } | null>(null);

  async function refresh() {
    const status = await api.plaidStatus();
    setEnabled(status.enabled);
    setEnvironment(status.environment);
    if (status.enabled) {
      try {
        setItems(await api.plaidListItems());
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Failed to list Plaid items');
      }
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

  async function startLinkFlow() {
    setBusy('link');
    setError(null);
    setInfo(null);
    try {
      const { link_token } = await api.plaidLinkToken();
      const Plaid = await loadPlaidLink();
      const handler = Plaid.create({
        token: link_token,
        onSuccess: (publicToken) => {
          void completeLink(publicToken);
        },
        onExit: (err) => {
          if (err) setError('Plaid Link cancelled or failed');
        },
      });
      handler.open();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start Plaid Link');
    } finally {
      setBusy(null);
    }
  }

  async function completeLink(publicToken: string) {
    setBusy('exchange');
    setError(null);
    try {
      const r = await api.plaidExchange(publicToken);
      setPendingItem({
        item: r.item,
        accounts: r.accounts,
        mapping: Object.fromEntries(r.accounts.map((a) => [a.account_id, ''])),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Token exchange failed');
    } finally {
      setBusy(null);
    }
  }

  async function saveMapping() {
    if (!pendingItem) return;
    const links = Object.entries(pendingItem.mapping)
      .filter(([, accountId]) => accountId !== '')
      .map(([plaidAccountId, accountId]) => {
        const p = pendingItem.accounts.find((a) => a.account_id === plaidAccountId)!;
        return {
          plaidAccountId,
          accountId,
          plaidAccountName: p.name,
          plaidAccountMask: p.mask ?? undefined,
          plaidAccountType: p.type,
          plaidAccountSubtype: p.subtype ?? undefined,
        };
      });
    if (links.length === 0) {
      setError('Map at least one account before saving.');
      return;
    }
    setBusy('link-accounts');
    try {
      await api.plaidLinkAccounts(pendingItem.item.id, links);
      setPendingItem(null);
      setInfo(`Linked ${links.length} account(s).`);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to save mapping');
    } finally {
      setBusy(null);
    }
  }

  async function onSync(itemId: string) {
    setBusy(`sync-${itemId}`);
    setError(null);
    try {
      const r = await api.plaidSyncItem(itemId);
      if (r.ok) {
        setInfo(
          `Sync OK — imported ${r.importedCount ?? 0}, skipped ${r.skippedCount ?? 0}${
            r.unmappedCount ? `, unmapped ${r.unmappedCount}` : ''
          }`,
        );
      } else {
        setError(`Sync failed: ${r.error}`);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sync failed');
    } finally {
      setBusy(null);
    }
  }

  async function onDelete(itemId: string) {
    if (
      !confirm(
        'Remove this Plaid connection? The bank link will be detached on the Plaid side.',
      )
    )
      return;
    setBusy(`delete-${itemId}`);
    try {
      await api.plaidDeleteItem(itemId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  if (enabled === null) return null;
  if (!enabled) return null;

  return (
    <div className="card row-gap" style={{ marginTop: 24 }}>
      <div className="section-title">
        Plaid {environment && <span className="muted">({environment})</span>}
      </div>
      <p className="muted">
        Plaid links your bank account through their cloud service.
        Transactions are pulled into SmrtCash through their API; your
        credentials are entered directly into Plaid's widget and never
        touch this server.
      </p>

      {error && <div className="banner error">{error}</div>}
      {info && <div className="banner info">{info}</div>}

      {!pendingItem && (
        <div>
          <button
            className="btn"
            onClick={() => void startLinkFlow()}
            disabled={busy !== null}
          >
            {busy === 'link' || busy === 'exchange'
              ? 'Opening Plaid Link…'
              : 'Connect via Plaid'}
          </button>
        </div>
      )}

      {pendingItem && (
        <div className="card">
          <div className="section-title">
            Map Plaid accounts to SmrtCash accounts
          </div>
          {pendingItem.accounts.map((a) => (
            <div key={a.account_id} className="form-grid">
              <div className="field">
                <label>
                  {a.name}
                  {a.mask ? ` ····${a.mask}` : ''}{' '}
                  <span className="muted">({a.type}/{a.subtype ?? '?'})</span>
                </label>
                <select
                  value={pendingItem.mapping[a.account_id] ?? ''}
                  onChange={(e) =>
                    setPendingItem({
                      ...pendingItem,
                      mapping: {
                        ...pendingItem.mapping,
                        [a.account_id]: e.target.value,
                      },
                    })
                  }
                >
                  <option value="">— Skip this account —</option>
                  {accounts.map((sa) => (
                    <option key={sa.id} value={sa.id}>
                      {sa.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          ))}
          <div>
            <button
              className="btn"
              onClick={() => void saveMapping()}
              disabled={busy !== null}
            >
              {busy === 'link-accounts' ? 'Saving…' : 'Save mapping'}
            </button>
            <button
              className="btn secondary"
              style={{ marginLeft: 8 }}
              onClick={() => setPendingItem(null)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {items.length > 0 && (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Institution</th>
                <th>Linked accounts</th>
                <th>Last sync</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((it) => (
                <tr key={it.id}>
                  <td>{it.institution_name ?? it.institution_id ?? '—'}</td>
                  <td>
                    {it.links.length === 0 ? (
                      <span className="muted">none mapped</span>
                    ) : (
                      it.links.map((l) => (
                        <div key={l.plaid_account_id}>
                          {l.plaid_account_name ?? l.plaid_account_id}
                          {l.plaid_account_mask
                            ? ` ····${l.plaid_account_mask}`
                            : ''}
                        </div>
                      ))
                    )}
                  </td>
                  <td>{it.last_sync_at ? formatDate(it.last_sync_at) : '—'}</td>
                  <td>
                    <span
                      className={
                        it.last_sync_status === 'ok'
                          ? 'pill pos'
                          : it.last_sync_status === 'never'
                          ? 'pill muted'
                          : 'pill neg'
                      }
                    >
                      {it.last_sync_status}
                    </span>
                    {it.last_sync_error && (
                      <div className="muted" style={{ fontSize: 12 }}>
                        {it.last_sync_error}
                      </div>
                    )}
                  </td>
                  <td className="row-actions">
                    <button
                      className="btn small"
                      onClick={() => void onSync(it.id)}
                      disabled={busy !== null || it.links.length === 0}
                    >
                      {busy === `sync-${it.id}` ? 'Syncing…' : 'Sync now'}
                    </button>
                    <button
                      className="btn small danger"
                      onClick={() => void onDelete(it.id)}
                      disabled={busy !== null}
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
