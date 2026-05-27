import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type CancellationQueueItem,
  type CancellationQueueInput,
  type CancellationStatus,
} from '../api';
import { formatCents } from '../format';

/**
 * 0.21.6 — manual subscription cancellation queue.
 *
 * Per the legal review on automated cancellations, this page is a
 * tracker, not an automation surface. The user adds things they
 * want to drop, walks through each vendor's cancel flow
 * themselves, and updates the row's status as they go. We
 * surface the cancellation URL when known so the click-through is
 * one tap away.
 */

const STATUS_LABEL: Record<CancellationStatus, string> = {
  queued: 'Queued',
  in_progress: 'In progress',
  done: 'Cancelled',
  couldnt: "Couldn't cancel",
  abandoned: 'Abandoned',
};

const STATUS_TONE: Record<CancellationStatus, string> = {
  queued: '',
  in_progress: 'warn',
  done: 'pos',
  couldnt: 'neg',
  abandoned: '',
};

const NEXT_STATUS: Record<CancellationStatus, CancellationStatus[]> = {
  queued: ['in_progress', 'abandoned'],
  in_progress: ['done', 'couldnt', 'abandoned'],
  done: ['queued'],
  couldnt: ['in_progress', 'abandoned'],
  abandoned: ['queued'],
};

export function CancellationsPage() {
  const [items, setItems] = useState<CancellationQueueItem[]>([]);
  const [filter, setFilter] = useState<'open' | 'closed' | 'all'>('open');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<CancellationQueueItem | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listCancellationQueue(filter === 'all' ? undefined : filter);
      setItems(r.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  const monthlySavings = items
    .filter((i) => i.status === 'done' && i.monthly_cents)
    .reduce((s, i) => s + (i.monthly_cents ?? 0), 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Cancellation queue</h1>
          <div className="subtitle">
            Track subscriptions you're trying to drop. Click the
            vendor's cancel URL, work through their flow yourself,
            and update the status when you're done. SmrtCash does
            not contact vendors on your behalf.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field">
            <label>Show</label>
            <select
              value={filter}
              onChange={(e) => setFilter(e.target.value as 'open' | 'closed' | 'all')}
            >
              <option value="open">Open</option>
              <option value="closed">Closed</option>
              <option value="all">All</option>
            </select>
          </div>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            Add to queue
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
        <Metric
          label="In queue"
          value={String(items.filter((i) => i.status === 'queued' || i.status === 'in_progress').length)}
        />
        <Metric
          label="Cancelled so far"
          value={String(items.filter((i) => i.status === 'done').length)}
        />
        <Metric
          label="Monthly savings"
          value={formatCents(monthlySavings)}
          tone="pos"
        />
      </div>

      {loading && items.length === 0 && <p className="empty">Loading…</p>}
      {!loading && items.length === 0 && (
        <p className="empty" style={{ marginTop: 16 }}>
          Nothing in the queue. Add a service when you want to drop it.
        </p>
      )}

      {items.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="txn-table">
            <thead>
              <tr>
                <th>Service</th>
                <th className="num">Monthly</th>
                <th>Status</th>
                <th>Cancel URL</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((i) => (
                <tr key={i.id}>
                  <td><strong>{i.service_name}</strong></td>
                  <td className="num">
                    {i.monthly_cents != null
                      ? formatCents(i.monthly_cents)
                      : '—'}
                  </td>
                  <td>
                    <span className={`pill ${STATUS_TONE[i.status]}`}>
                      {STATUS_LABEL[i.status]}
                    </span>
                  </td>
                  <td>
                    {i.cancel_url ? (
                      <a href={i.cancel_url} target="_blank" rel="noreferrer">
                        Open
                      </a>
                    ) : (
                      <span className="muted">—</span>
                    )}
                  </td>
                  <td className="muted" style={{ fontSize: 13 }}>
                    {i.notes ?? ''}
                  </td>
                  <td>
                    {NEXT_STATUS[i.status].map((s) => (
                      <button
                        key={s}
                        className="btn-link"
                        type="button"
                        onClick={async () => {
                          await api.updateCancellationQueue(i.id, { status: s });
                          void reload();
                        }}
                      >
                        → {STATUS_LABEL[s]}
                      </button>
                    ))}
                    {' · '}
                    <button
                      className="btn-link"
                      type="button"
                      onClick={() => {
                        setEditing(i);
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                    {' · '}
                    <button
                      className="btn-link"
                      type="button"
                      onClick={async () => {
                        if (!confirm('Remove from queue?')) return;
                        await api.deleteCancellationQueue(i.id);
                        void reload();
                      }}
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

      {showForm && (
        <QueueForm
          initial={editing}
          onClose={() => {
            setShowForm(false);
            setEditing(null);
          }}
          onSaved={() => {
            setShowForm(false);
            setEditing(null);
            void reload();
          }}
        />
      )}
    </div>
  );
}

function QueueForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: CancellationQueueItem | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [serviceName, setServiceName] = useState(initial?.service_name ?? '');
  const [cancelUrl, setCancelUrl] = useState(initial?.cancel_url ?? '');
  const [monthlyDollars, setMonthlyDollars] = useState(
    initial?.monthly_cents != null ? (initial.monthly_cents / 100).toFixed(2) : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setErr(null);
    try {
      if (!serviceName.trim()) throw new Error('Service name is required');
      let cents: number | null = null;
      if (monthlyDollars.trim()) {
        const n = Number(monthlyDollars);
        if (!Number.isFinite(n) || n < 0) throw new Error('Monthly cost must be ≥ 0');
        cents = Math.round(n * 100);
      }
      const body: CancellationQueueInput = {
        serviceName: serviceName.trim(),
        cancelUrl: cancelUrl.trim() || null,
        notes: notes.trim() || null,
        monthlyCents: cents,
      };
      if (initial) {
        await api.updateCancellationQueue(initial.id, body);
      } else {
        await api.createCancellationQueue(body);
      }
      onSaved();
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 480 }}>
        <h2>{initial ? 'Edit cancellation' : 'New cancellation'}</h2>
        {err && <div className="banner error">{err}</div>}
        <div className="field">
          <label>Service name</label>
          <input
            type="text"
            value={serviceName}
            onChange={(e) => setServiceName(e.target.value)}
            placeholder="e.g. Disney+"
            required
          />
        </div>
        <div className="field">
          <label>Cancel URL (optional)</label>
          <input
            type="url"
            value={cancelUrl}
            onChange={(e) => setCancelUrl(e.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="field">
          <label>Monthly cost (optional)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={monthlyDollars}
            onChange={(e) => setMonthlyDollars(e.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="field">
          <label>Notes (optional)</label>
          <textarea
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Metric({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: 'pos' | 'neg';
}) {
  return (
    <div className="card">
      <div className="muted" style={{ fontSize: 13 }}>{label}</div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}
      >
        {value}
      </div>
    </div>
  );
}
