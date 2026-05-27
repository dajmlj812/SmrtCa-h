import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type BillTriageRow } from '../api';
import { formatCents, formatDate } from '../format';

/**
 * 0.22.0 — triage queue surface for the bill matcher.
 *
 * Each row is one (bill, transaction) pair the matcher refused to
 * auto-link. The user accepts / rejects / reassigns; on accept the
 * link is applied (period → paid, cursor advances, category fills
 * if blank). Reason explains why:
 *   ambiguous_vendor   — 2+ bills could own this txn (sibling rows
 *                        share the same transaction_id)
 *   amount_edge        — amount fits but in the outer 25% of band
 *   date_edge          — date in the outer 25% of the window
 *   out_of_tolerance   — vendor + date match but amount doesn't
 *
 * Renders nothing when the queue is empty, so it can sit at the
 * top of /recurring without becoming visual noise.
 */
export function BillTriageQueue({
  onResolved,
}: {
  onResolved?: () => void;
}) {
  const [rows, setRows] = useState<BillTriageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<Record<string, boolean>>({});

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listBillTriage();
      setRows(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load triage');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function resolve(
    id: string,
    resolution: 'accepted' | 'rejected',
  ) {
    setBusy((b) => ({ ...b, [id]: true }));
    try {
      await api.resolveBillTriage(id, resolution);
      await load();
      onResolved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Resolution failed');
    } finally {
      setBusy((b) => {
        const next = { ...b };
        delete next[id];
        return next;
      });
    }
  }

  // Group ambiguous rows by transaction so the user sees "this one
  // transaction has 2 candidate bills" instead of two unrelated rows.
  const grouped = useMemo(() => {
    const byTxn = new Map<string, BillTriageRow[]>();
    for (const r of rows) {
      const arr = byTxn.get(r.transaction_id) ?? [];
      arr.push(r);
      byTxn.set(r.transaction_id, arr);
    }
    return [...byTxn.values()];
  }, [rows]);

  if (loading) return null;
  if (rows.length === 0) return null;

  return (
    <div className="card" style={{ marginBottom: 16, borderLeft: '3px solid var(--warn)' }}>
      <h3 style={{ margin: '0 0 4px' }}>
        Bill matches to review{' '}
        <span className="muted small">({rows.length})</span>
      </h3>
      <p className="muted small" style={{ marginTop: 0 }}>
        The matcher saw transactions that look like bills but wasn't
        confident enough to link automatically. Accept the right one
        below (or reject if it's not the bill).
      </p>
      {error && <div className="banner error">{error}</div>}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
        {grouped.map((group) => (
          <TriageGroup
            key={group[0]!.transaction_id}
            rows={group}
            busy={busy}
            onAccept={(id) => void resolve(id, 'accepted')}
            onReject={(id) => void resolve(id, 'rejected')}
          />
        ))}
      </div>
    </div>
  );
}

function TriageGroup({
  rows,
  busy,
  onAccept,
  onReject,
}: {
  rows: BillTriageRow[];
  busy: Record<string, boolean>;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
}) {
  const txn = rows[0]!;
  const txnAbs = Math.abs(txn.txn_amount_cents);
  return (
    <div
      style={{
        background: 'var(--bg-soft, var(--surface))',
        padding: 10,
        borderRadius: 6,
        border: '1px solid var(--border)',
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>
            {txn.normalized_merchant || txn.raw_description}
          </div>
          <div className="muted small">
            {formatDate(txn.txn_date)} · {formatCents(txnAbs)}
          </div>
        </div>
        {rows.length > 1 && (
          <span
            className="pill"
            style={{
              fontSize: '0.7em',
              padding: '2px 8px',
              background: 'var(--warn-soft)',
              color: 'var(--warn)',
              borderRadius: 999,
              alignSelf: 'flex-start',
            }}
          >
            {rows.length} candidate bills
          </span>
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 10 }}>
        {rows.map((r) => (
          <CandidateRow
            key={r.id}
            row={r}
            busy={busy[r.id] === true}
            onAccept={() => onAccept(r.id)}
            onReject={() => onReject(r.id)}
          />
        ))}
      </div>
    </div>
  );
}

function CandidateRow({
  row,
  busy,
  onAccept,
  onReject,
}: {
  row: BillTriageRow;
  busy: boolean;
  onAccept: () => void;
  onReject: () => void;
}) {
  const reasonLabel = REASON_LABEL[row.reason];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        padding: '6px 8px',
        background: 'var(--surface)',
        borderRadius: 4,
      }}
    >
      <div style={{ minWidth: 0, flex: 1 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <strong>{row.bill_name}</strong>
          <span className="muted small">
            expects {formatCents(row.bill_amount_cents)} ({row.bill_amount_mode})
          </span>
        </div>
        <div className="muted small">
          {reasonLabel} · due {formatDate(row.bill_next_due_date)}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button
          className="btn"
          type="button"
          onClick={onAccept}
          disabled={busy}
          title="This transaction IS this bill — link it"
        >
          {busy ? '…' : 'Accept'}
        </button>
        <button
          className="btn secondary"
          type="button"
          onClick={onReject}
          disabled={busy}
          title="This transaction is NOT this bill"
        >
          Reject
        </button>
      </div>
    </div>
  );
}

const REASON_LABEL: Record<BillTriageRow['reason'], string> = {
  ambiguous_vendor: 'Multiple bills could own this charge',
  amount_edge: 'Amount fits but is near the edge of tolerance',
  date_edge: 'Date is near the edge of the match window',
  out_of_tolerance: 'Amount is outside the bill’s expected band',
};
