import { useEffect, useState, type FormEvent } from 'react';
import { api, type TollRoute } from '../api';
import { formatCents } from '../format';

export function TollsPage() {
  const [routes, setRoutes] = useState<TollRoute[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setRoutes(await api.listTollRoutes());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(r: TollRoute) {
    try {
      await api.updateTollRoute(r.id, { active: !r.active });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }
  async function remove(r: TollRoute) {
    if (!window.confirm(`Delete ${r.name}?`)) return;
    try {
      await api.deleteTollRoute(r.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const total = routes
    .filter((r) => r.active)
    .reduce((acc, r) => acc + r.weekly_estimate_cents, 0);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Toll routes</h1>
          <div className="subtitle">
            Each route's weekly estimate flows into the AutoMagic wizard's
            Tolls line for every future period.
          </div>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>
          Add route
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : routes.length === 0 ? (
        <p className="empty">No toll routes yet.</p>
      ) : (
        <>
          <div className="card budget-totals">
            <span>
              <span className="muted">Active weekly total </span>
              <strong>{formatCents(total)}</strong>
            </span>
          </div>
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Route</th>
                  <th className="num">Weekly</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {routes.map((r) => (
                  <tr key={r.id} className={r.active ? '' : 'muted-row'}>
                    <td>{r.name}</td>
                    <td className="num">{formatCents(r.weekly_estimate_cents)}</td>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => void toggle(r)}
                      >
                        {r.active ? 'Disable' : 'Enable'}
                      </button>
                    </td>
                    <td>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void remove(r)}
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {showAdd && (
        <NewTollForm
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            void load();
          }}
        />
      )}
    </div>
  );
}

function NewTollForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [weekly, setWeekly] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const cents = Math.round(Number(weekly) * 100);
      if (!Number.isFinite(cents) || cents < 0) throw new Error('Weekly must be ≥ 0');
      await api.createTollRoute({
        name: name.trim(),
        weeklyEstimateCents: cents,
      });
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <header className="modal-header">
          <h2>New toll route</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="t-name">Route name</label>
              <input
                id="t-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Hwy 99 commute"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="t-weekly">Weekly estimate ($)</label>
              <input
                id="t-weekly"
                type="number"
                step="0.01"
                min="0"
                value={weekly}
                onChange={(e) => setWeekly(e.target.value)}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create route'}
            </button>
            <button className="btn secondary" type="button" onClick={onClose}>
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
