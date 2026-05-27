import { useEffect, useState, type FormEvent } from 'react';
import { api, type Warranty, type WarrantyInput } from '../api';
import { formatCents } from '../format';

/**
 * 0.21.2 — receipt → warranty tracking page.
 *
 * Lists every warrantied purchase the user has logged, sorted by
 * upcoming expiry. The daily insights scheduler emits a card for
 * anything within 30 days; this page is the read+manage surface.
 */

type FilterStatus = 'all' | 'active' | 'expiring' | 'expired';

export function WarrantiesPage() {
  const [filter, setFilter] = useState<FilterStatus>('all');
  const [items, setItems] = useState<Warranty[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editing, setEditing] = useState<Warranty | null>(null);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.listWarranties(
        filter === 'all' ? undefined : filter,
      );
      setItems(r.warranties);
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

  const summary = {
    active: items.filter((w) => !w.expired).length,
    expiring: items.filter((w) => w.expiring_soon).length,
    expired: items.filter((w) => w.expired).length,
    coveredCents: items
      .filter((w) => !w.expired && w.purchase_cents)
      .reduce((s, w) => s + (w.purchase_cents ?? 0), 0),
  };

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Warranties</h1>
          <div className="subtitle">
            Track warranty / return windows for things you've bought.
            Anything expiring in the next 30 days surfaces as a
            dashboard card the day before it lapses.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="warranty-filter">Show</label>
            <select
              id="warranty-filter"
              value={filter}
              onChange={(e) => setFilter(e.target.value as FilterStatus)}
            >
              <option value="all">All</option>
              <option value="active">Active</option>
              <option value="expiring">Expiring &lt; 30 days</option>
              <option value="expired">Expired</option>
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
            Add warranty
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
        <Summary label="Active" value={String(summary.active)} />
        <Summary
          label="Expiring soon"
          value={String(summary.expiring)}
          tone={summary.expiring > 0 ? 'neg' : undefined}
        />
        <Summary label="Expired" value={String(summary.expired)} />
        <Summary
          label="Covered value"
          value={formatCents(summary.coveredCents)}
          tone="pos"
        />
      </div>

      {loading && items.length === 0 && <p className="empty">Loading…</p>}
      {!loading && items.length === 0 && (
        <p className="empty">
          No warranties logged yet. Add your first receipt to start tracking.
        </p>
      )}

      {items.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="txn-table">
            <thead>
              <tr>
                <th>Item</th>
                <th>Vendor</th>
                <th>Purchased</th>
                <th>Covered until</th>
                <th className="num">Purchase</th>
                <th>Status</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td><strong>{w.item}</strong></td>
                  <td>{w.vendor ?? '—'}</td>
                  <td>{w.purchase_date}</td>
                  <td>{w.warranty_until}</td>
                  <td className="num">
                    {w.purchase_cents != null
                      ? formatCents(w.purchase_cents)
                      : '—'}
                  </td>
                  <td>
                    {w.expired ? (
                      <span className="pill neg">Expired</span>
                    ) : w.expiring_soon ? (
                      <span className="pill warn">Expiring soon</span>
                    ) : (
                      <span className="pill pos">Active</span>
                    )}
                  </td>
                  <td>
                    <button
                      className="btn-link"
                      type="button"
                      onClick={() => {
                        setEditing(w);
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
                        if (!confirm('Delete this warranty?')) return;
                        await api.deleteWarranty(w.id);
                        void reload();
                      }}
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

      {showForm && (
        <WarrantyForm
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

function WarrantyForm({
  initial,
  onClose,
  onSaved,
}: {
  initial: Warranty | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [item, setItem] = useState(initial?.item ?? '');
  const [vendor, setVendor] = useState(initial?.vendor ?? '');
  const [purchaseDate, setPurchaseDate] = useState(
    initial?.purchase_date ?? new Date().toISOString().slice(0, 10),
  );
  const [warrantyUntil, setWarrantyUntil] = useState(initial?.warranty_until ?? '');
  const [purchaseDollars, setPurchaseDollars] = useState(
    initial?.purchase_cents != null
      ? (initial.purchase_cents / 100).toFixed(2)
      : '',
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      if (!item.trim()) throw new Error('Item is required');
      if (!warrantyUntil) throw new Error('Warranty end date is required');
      let cents: number | null = null;
      if (purchaseDollars.trim()) {
        const n = Number(purchaseDollars);
        if (!Number.isFinite(n) || n < 0) throw new Error('Purchase price must be ≥ 0');
        cents = Math.round(n * 100);
      }
      const body: WarrantyInput = {
        item: item.trim(),
        vendor: vendor.trim() || null,
        purchaseDate,
        warrantyUntil,
        purchaseCents: cents,
        notes: notes.trim() || null,
      };
      if (initial) {
        await api.updateWarranty(initial.id, body);
      } else {
        await api.createWarranty(body);
      }
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <form className="modal" onSubmit={submit} style={{ maxWidth: 480 }}>
        <h2>{initial ? 'Edit warranty' : 'New warranty'}</h2>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label>Item</label>
          <input
            type="text"
            value={item}
            onChange={(e) => setItem(e.target.value)}
            placeholder="e.g. LG OLED TV"
            required
          />
        </div>
        <div className="field">
          <label>Vendor / brand (optional)</label>
          <input
            type="text"
            value={vendor}
            onChange={(e) => setVendor(e.target.value)}
          />
        </div>
        <div className="field">
          <label>Purchase date</label>
          <input
            type="date"
            value={purchaseDate}
            onChange={(e) => setPurchaseDate(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Covered until</label>
          <input
            type="date"
            value={warrantyUntil}
            onChange={(e) => setWarrantyUntil(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Purchase price (optional)</label>
          <input
            type="number"
            step="0.01"
            min="0"
            value={purchaseDollars}
            onChange={(e) => setPurchaseDollars(e.target.value)}
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
            {submitting ? 'Saving…' : 'Save warranty'}
          </button>
        </div>
      </form>
    </div>
  );
}

function Summary({
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
