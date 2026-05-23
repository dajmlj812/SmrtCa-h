import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type ShareRow,
  type ShareSummaryRow,
  type SplitParticipant,
} from '../api';
import { formatCents, formatDate } from '../format';

/**
 * Phase 9.2 (0.12.2) — Sharing page.
 *
 * Shows net balances per participant + lets the user manage
 * participants and settle individual shares. Per-transaction
 * splitting happens via the SplitTransactionModal on the
 * Transactions page; this page is the dashboard view.
 */

export function SharingPage() {
  const [participants, setParticipants] = useState<SplitParticipant[]>([]);
  const [summary, setSummary] = useState<ShareSummaryRow[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [shares, setShares] = useState<ShareRow[]>([]);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [includeArchived, setIncludeArchived] = useState(false);

  async function refresh() {
    try {
      const [p, s] = await Promise.all([
        api.listSplitParticipants(includeArchived),
        api.sharesSummary(),
      ]);
      setParticipants(p);
      setSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    }
  }

  async function loadShares(participantId: string) {
    setSelectedId(participantId);
    try {
      const rows = await api.listShares({ participantId });
      setShares(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load shares');
    }
  }

  useEffect(() => {
    void refresh();
  }, [includeArchived]);

  async function addParticipant(e: FormEvent) {
    e.preventDefault();
    if (!newName.trim()) return;
    setBusy('add');
    setError(null);
    try {
      await api.createSplitParticipant({ name: newName.trim() });
      setNewName('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Add failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleArchived(p: SplitParticipant) {
    setBusy(`arch-${p.id}`);
    try {
      await api.updateSplitParticipant(p.id, { archived: !p.archived });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    } finally {
      setBusy(null);
    }
  }

  async function deleteParticipant(p: SplitParticipant) {
    if (
      !confirm(
        `Delete ${p.name}? This removes them AND any shares attached to their transactions.`,
      )
    )
      return;
    setBusy(`del-${p.id}`);
    try {
      await api.deleteSplitParticipant(p.id);
      if (selectedId === p.id) {
        setSelectedId(null);
        setShares([]);
      }
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    } finally {
      setBusy(null);
    }
  }

  async function toggleSettled(s: ShareRow) {
    setBusy(`settle-${s.id}`);
    try {
      await api.settleTransactionShare(s.id, !s.settled);
      if (selectedId) await loadShares(selectedId);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Settle failed');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Sharing</h1>
          <div className="subtitle">
            Track who owes whom across split expenses. Positive net = they
            owe you. Negative = you owe them. Use the <strong>Split</strong>{' '}
            button on a transaction to allocate shares.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card row-gap">
        <div className="section-title">Add a participant</div>
        <form onSubmit={addParticipant} className="form-grid">
          <div className="field">
            <label>Name</label>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. Alex"
            />
          </div>
          <div className="field" style={{ alignSelf: 'end' }}>
            <button className="btn" type="submit" disabled={busy === 'add'}>
              {busy === 'add' ? 'Adding…' : 'Add'}
            </button>
          </div>
        </form>
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 16 }}>
        <h2 style={{ margin: 0 }}>Net balances</h2>
        <label className="muted" style={{ marginLeft: 'auto', fontSize: 13 }}>
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
          />{' '}
          Include archived
        </label>
      </div>

      {participants.length === 0 ? (
        <p className="empty">No participants yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Participant</th>
                <th className="num">Net (open)</th>
                <th className="num">Open shares</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {participants.map((p) => {
                const row = summary.find((s) => s.participant_id === p.id);
                const net = Number(row?.net_open_cents ?? 0);
                return (
                  <tr key={p.id} className={selectedId === p.id ? 'row-selected' : ''}>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => void loadShares(p.id)}
                      >
                        {p.name}
                      </button>
                      {p.archived && <span className="muted"> (archived)</span>}
                    </td>
                    <td className={`num ${net < 0 ? 'neg' : net > 0 ? 'pos' : ''}`}>
                      {formatCents(net)}
                    </td>
                    <td className="num">{row?.open_count ?? 0}</td>
                    <td className="row-actions">
                      <button
                        className="btn small secondary"
                        onClick={() => void toggleArchived(p)}
                        disabled={busy === `arch-${p.id}`}
                      >
                        {p.archived ? 'Unarchive' : 'Archive'}
                      </button>
                      <button
                        className="btn small danger"
                        onClick={() => void deleteParticipant(p)}
                        disabled={busy === `del-${p.id}`}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {selectedId && (
        <>
          <h2 style={{ marginTop: 24 }}>
            Shares —{' '}
            {participants.find((p) => p.id === selectedId)?.name ?? 'participant'}
          </h2>
          {shares.length === 0 ? (
            <p className="empty">No shares yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="txn-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Description</th>
                    <th className="num">Their share</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {shares.map((s) => (
                    <tr key={s.id}>
                      <td className="nowrap">{formatDate(s.txn_date)}</td>
                      <td>{s.raw_description}</td>
                      <td className={`num ${s.share_cents < 0 ? 'neg' : 'pos'}`}>
                        {formatCents(s.share_cents)}
                      </td>
                      <td>
                        <span className={s.settled ? 'pill pos' : 'pill muted'}>
                          {s.settled ? 'Settled' : 'Open'}
                        </span>
                      </td>
                      <td>
                        <button
                          className="btn small secondary"
                          onClick={() => void toggleSettled(s)}
                          disabled={busy === `settle-${s.id}`}
                        >
                          {s.settled ? 'Re-open' : 'Settle'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
