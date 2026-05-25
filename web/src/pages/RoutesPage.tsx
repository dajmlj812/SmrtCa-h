import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type Account,
  type CommuteRoute,
  type RouteAssignment,
  type Vehicle,
} from '../api';
import { formatCents } from '../format';

export function RoutesPage() {
  const [routes, setRoutes] = useState<CommuteRoute[]>([]);
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  // 0.17.20
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [r, v, a] = await Promise.all([
        api.listCommuteRoutes(),
        api.listVehicles(),
        api.listAccounts(),
      ]);
      setRoutes(r);
      setVehicles(v);
      setAccounts(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  async function setRouteAccount(id: string, accountId: string | null) {
    try {
      await api.updateCommuteRoute(id, { accountId });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Account update failed');
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function toggle(route: CommuteRoute) {
    try {
      await api.updateCommuteRoute(route.id, { active: !route.active });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function remove(route: CommuteRoute) {
    if (!window.confirm(`Delete route "${route.name}"?`)) return;
    try {
      await api.deleteCommuteRoute(route.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  async function saveAssignments(
    route: CommuteRoute,
    assignments: Array<{ vehicleId: string; crossingsPerWeek: number }>,
  ) {
    try {
      await api.setRouteAssignments(route.id, assignments);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Assignments save failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Commute routes</h1>
          <div className="subtitle">
            Routes drive both fuel and tolls in the budget wizard. Each route
            stores a distance and an optional per-crossing toll; assignments
            say how many times per week each vehicle takes it.
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
        <p className="empty">No routes yet.</p>
      ) : (
        <div className="route-list">
          {routes.map((r) => (
            <RouteCard
              key={r.id}
              route={r}
              vehicles={vehicles}
              accounts={accounts}
              onToggle={() => void toggle(r)}
              onDelete={() => void remove(r)}
              onSaveAssignments={(a) => void saveAssignments(r, a)}
              onSetAccount={(aId) => void setRouteAccount(r.id, aId)}
            />
          ))}
        </div>
      )}

      {showAdd && (
        <NewRouteForm
          vehicles={vehicles}
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

function RouteCard({
  route,
  vehicles,
  accounts,
  onToggle,
  onDelete,
  onSaveAssignments,
  onSetAccount,
}: {
  route: CommuteRoute;
  vehicles: Vehicle[];
  accounts: Account[];
  onToggle: () => void;
  onDelete: () => void;
  onSaveAssignments: (
    a: Array<{ vehicleId: string; crossingsPerWeek: number }>,
  ) => void;
  onSetAccount: (accountId: string | null) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Array<{ vehicleId: string; crossingsPerWeek: number }>>(
    () =>
      route.assignments.map((a) => ({
        vehicleId: a.vehicle_id,
        crossingsPerWeek: a.crossings_per_week,
      })),
  );

  const totalCrossings = route.assignments.reduce(
    (acc, a) => acc + a.crossings_per_week,
    0,
  );
  const weeklyToll = (route.toll_per_crossing_cents ?? 0) * totalCrossings;

  function update(vehicleId: string, crossings: number) {
    setDraft((prev) => {
      const existing = prev.find((p) => p.vehicleId === vehicleId);
      if (crossings === 0) {
        return prev.filter((p) => p.vehicleId !== vehicleId);
      }
      if (existing) {
        return prev.map((p) =>
          p.vehicleId === vehicleId ? { ...p, crossingsPerWeek: crossings } : p,
        );
      }
      return [...prev, { vehicleId, crossingsPerWeek: crossings }];
    });
  }

  function commit() {
    onSaveAssignments(draft);
    setEditing(false);
  }

  return (
    <div className={`card route-card ${route.active ? '' : 'muted-row'}`}>
      <div className="route-card-head">
        <div>
          <strong>{route.name}</strong>
          <span className="muted route-card-meta">
            {Number(route.distance_miles).toFixed(1)} mi
            {route.toll_per_crossing_cents !== null && (
              <> · {formatCents(route.toll_per_crossing_cents)}/crossing</>
            )}
          </span>
        </div>
        <div className="route-card-actions">
          <select
            value={route.account_id ?? ''}
            onChange={(e) =>
              onSetAccount(e.target.value === '' ? null : e.target.value)
            }
            style={{ fontSize: '0.9em', maxWidth: 180 }}
            title="Account this route's tolls belong to"
          >
            <option value="">— No account —</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
          <button className="btn-link" type="button" onClick={onToggle}>
            {route.active ? 'Disable' : 'Enable'}
          </button>
          <button className="btn-link danger" type="button" onClick={onDelete}>
            Delete
          </button>
        </div>
      </div>

      <div className="route-card-body">
        <div className="route-summary">
          <span className="muted">Total weekly crossings </span>
          <strong>{totalCrossings}</strong>
          {route.toll_per_crossing_cents !== null && (
            <>
              {' · '}
              <span className="muted">Weekly toll </span>
              <strong>{formatCents(weeklyToll)}</strong>
            </>
          )}
        </div>

        {!editing ? (
          <div className="route-assignments">
            {route.assignments.length === 0 ? (
              <span className="muted">No vehicle assignments yet</span>
            ) : (
              route.assignments.map((a: RouteAssignment) => (
                <span key={a.id} className="pill">
                  {a.vehicle_name ?? '—'}: {a.crossings_per_week}/wk
                </span>
              ))
            )}
            <button
              className="btn-link"
              type="button"
              onClick={() => setEditing(true)}
            >
              Edit assignments
            </button>
          </div>
        ) : (
          <div className="route-assignments-edit">
            {vehicles.map((v) => {
              const current =
                draft.find((d) => d.vehicleId === v.id)?.crossingsPerWeek ?? 0;
              return (
                <label key={v.id} className="route-assignment-row">
                  <span>{v.name}</span>
                  <input
                    type="number"
                    min="0"
                    step="0.5"
                    value={current}
                    onChange={(e) => update(v.id, Number(e.target.value) || 0)}
                  />
                  <span className="muted">/wk</span>
                </label>
              );
            })}
            <div className="route-edit-actions">
              <button className="btn small" type="button" onClick={commit}>
                Save
              </button>
              <button
                className="btn secondary small"
                type="button"
                onClick={() => {
                  setEditing(false);
                  setDraft(
                    route.assignments.map((a) => ({
                      vehicleId: a.vehicle_id,
                      crossingsPerWeek: a.crossings_per_week,
                    })),
                  );
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function NewRouteForm({
  vehicles,
  onClose,
  onSaved,
}: {
  vehicles: Vehicle[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [distance, setDistance] = useState('');
  const [toll, setToll] = useState('');
  const [hasToll, setHasToll] = useState(false);
  const [assignments, setAssignments] = useState<Record<string, number>>({});
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const tollCents = hasToll ? Math.round(Number(toll) * 100) : null;
      await api.createCommuteRoute({
        name: name.trim(),
        distanceMiles: Number(distance) || 0,
        tollPerCrossingCents: tollCents,
        assignments: Object.entries(assignments)
          .filter(([, c]) => c > 0)
          .map(([vehicleId, crossingsPerWeek]) => ({
            vehicleId,
            crossingsPerWeek,
          })),
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
          <h2>New commute route</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="r-name">Name</label>
              <input
                id="r-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="To office"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="r-dist">Distance (miles, one-way)</label>
              <input
                id="r-dist"
                type="number"
                step="0.1"
                min="0"
                value={distance}
                onChange={(e) => setDistance(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label>
                <input
                  type="checkbox"
                  checked={hasToll}
                  onChange={(e) => setHasToll(e.target.checked)}
                />{' '}
                This route has a toll
              </label>
            </div>
            {hasToll && (
              <div className="field">
                <label htmlFor="r-toll">Toll per crossing ($)</label>
                <input
                  id="r-toll"
                  type="number"
                  step="0.01"
                  min="0"
                  value={toll}
                  onChange={(e) => setToll(e.target.value)}
                />
              </div>
            )}
          </div>
          <div className="section-title" style={{ marginTop: 16 }}>
            Vehicle assignments
          </div>
          {vehicles.length === 0 ? (
            <p className="muted">Add a vehicle first (Vehicles page) to assign crossings.</p>
          ) : (
            vehicles.map((v) => (
              <div key={v.id} className="route-assignment-row">
                <span>{v.name}</span>
                <input
                  type="number"
                  min="0"
                  step="0.5"
                  value={assignments[v.id] ?? 0}
                  onChange={(e) =>
                    setAssignments((prev) => ({
                      ...prev,
                      [v.id]: Number(e.target.value) || 0,
                    }))
                  }
                />
                <span className="muted">crossings/wk</span>
              </div>
            ))
          )}
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
