import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type MileagePurpose,
  type MileageSummary,
  type MileageTrip,
  type MileageTripInput,
} from '../api';
import { formatCents } from '../format';

/**
 * 0.21.0 — IRS-style mileage log.
 *
 * Records date-stamped trips with purpose so the tax-year report
 * can multiply business miles by the standard rate and roll the
 * deduction onto Schedule C line 9. The page surfaces both the
 * year's summary (with current-year rates) and a trip-by-trip
 * editable table.
 */

const PURPOSES: MileagePurpose[] = [
  'business', 'commute', 'charity', 'medical', 'moving', 'personal',
];

interface VehicleOpt {
  id: string;
  name: string;
}

export function MileagePage() {
  const now = new Date();
  const [year, setYear] = useState(now.getUTCFullYear());
  const [trips, setTrips] = useState<MileageTrip[]>([]);
  const [summary, setSummary] = useState<MileageSummary | null>(null);
  const [vehicles, setVehicles] = useState<VehicleOpt[]>([]);
  const [editing, setEditing] = useState<MileageTrip | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    setError(null);
    try {
      const [t, s] = await Promise.all([
        api.listMileage({ year }),
        api.mileageSummary(year),
      ]);
      setTrips(t.trips);
      setSummary(s);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year]);

  useEffect(() => {
    void api
      .listVehicles()
      .then((vs) => setVehicles(vs.map((v) => ({ id: v.id, name: v.name }))))
      .catch(() => undefined);
  }, []);

  const years: number[] = [];
  for (let y = now.getUTCFullYear(); y >= now.getUTCFullYear() - 5; y--) years.push(y);

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Mileage Log</h1>
          <div className="subtitle">
            Date-stamped trips for IRS substantiation. Business miles
            roll onto Schedule C line 9 at the standard rate.
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <div className="field">
            <label htmlFor="mileage-year">Year</label>
            <select
              id="mileage-year"
              value={year}
              onChange={(e) => setYear(Number(e.target.value))}
            >
              {years.map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <a
            href={api.mileageCsvUrl(year)}
            className="btn secondary"
            download
          >
            Download CSV
          </a>
          <button
            className="btn"
            type="button"
            onClick={() => {
              setEditing(null);
              setShowForm(true);
            }}
          >
            Add trip
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {summary && (
        <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
          <SummaryCard
            label="Total miles"
            value={summary.total_miles.toFixed(1)}
          />
          <SummaryCard
            label="Estimated deduction"
            value={formatCents(summary.total_deduction_cents)}
            tone="pos"
          />
          <SummaryCard
            label="Business miles"
            value={
              (summary.by_purpose.find((p) => p.purpose === 'business')?.miles ?? 0)
                .toFixed(1)
            }
          />
          <SummaryCard
            label="Business rate"
            value={`${summary.rates.business.toFixed(1)}¢/mi`}
          />
        </div>
      )}

      {summary && summary.by_purpose.length > 0 && (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="txn-table">
            <thead>
              <tr>
                <th>Purpose</th>
                <th className="num">Miles</th>
                <th className="num">Trips</th>
                <th className="num">Rate (¢/mi)</th>
                <th className="num">Deduction</th>
              </tr>
            </thead>
            <tbody>
              {summary.by_purpose.map((row) => (
                <tr key={row.purpose}>
                  <td><span className="pill">{row.purpose}</span></td>
                  <td className="num">{row.miles.toFixed(1)}</td>
                  <td className="num">{row.trip_count}</td>
                  <td className="num">{row.rate_cents_per_mile.toFixed(1)}</td>
                  <td className="num pos">
                    {row.deduction_cents > 0
                      ? formatCents(row.deduction_cents)
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 style={{ marginTop: 24 }}>Trips in {year}</h2>
      {loading && trips.length === 0 && <p className="empty">Loading…</p>}
      {!loading && trips.length === 0 && (
        <p className="empty">
          No trips logged for {year}. Click <strong>Add trip</strong> to
          record your first one.
        </p>
      )}
      {trips.length > 0 && (
        <div className="table-wrap">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>Purpose</th>
                <th className="num">Miles</th>
                <th>Route</th>
                <th>Vehicle</th>
                <th>Notes</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {trips.map((t) => {
                const vehicle = vehicles.find((v) => v.id === t.vehicle_id);
                return (
                  <tr key={t.id}>
                    <td>{t.trip_date}</td>
                    <td><span className="pill">{t.purpose}</span></td>
                    <td className="num">{t.miles.toFixed(1)}</td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {t.start_location || t.end_location
                        ? `${t.start_location ?? '—'} → ${t.end_location ?? '—'}`
                        : '—'}
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {vehicle?.name ?? '—'}
                    </td>
                    <td className="muted" style={{ fontSize: 13 }}>
                      {t.description ?? ''}
                    </td>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => {
                          setEditing(t);
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
                          if (!confirm('Delete this trip?')) return;
                          await api.deleteMileage(t.id);
                          void reload();
                        }}
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

      {showForm && (
        <TripForm
          initial={editing}
          vehicles={vehicles}
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

function TripForm({
  initial,
  vehicles,
  onClose,
  onSaved,
}: {
  initial: MileageTrip | null;
  vehicles: VehicleOpt[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [tripDate, setTripDate] = useState(initial?.trip_date ?? new Date().toISOString().slice(0, 10));
  const [purpose, setPurpose] = useState<MileagePurpose>(initial?.purpose ?? 'business');
  const [miles, setMiles] = useState(String(initial?.miles ?? ''));
  const [vehicleId, setVehicleId] = useState(initial?.vehicle_id ?? '');
  const [startLocation, setStartLocation] = useState(initial?.start_location ?? '');
  const [endLocation, setEndLocation] = useState(initial?.end_location ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const m = Number(miles);
      if (!Number.isFinite(m) || m < 0) throw new Error('Miles must be ≥ 0');
      const body: MileageTripInput = {
        vehicleId: vehicleId || null,
        tripDate,
        purpose,
        miles: m,
        startLocation: startLocation.trim() || null,
        endLocation: endLocation.trim() || null,
        description: description.trim() || null,
      };
      if (initial) {
        await api.updateMileage(initial.id, body);
      } else {
        await api.createMileage(body);
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
        <h2>{initial ? 'Edit trip' : 'New trip'}</h2>
        {error && <div className="banner error">{error}</div>}
        <div className="field">
          <label>Date</label>
          <input
            type="date"
            value={tripDate}
            onChange={(e) => setTripDate(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Purpose</label>
          <select
            value={purpose}
            onChange={(e) => setPurpose(e.target.value as MileagePurpose)}
          >
            {PURPOSES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Miles</label>
          <input
            type="number"
            step="0.1"
            min="0"
            value={miles}
            onChange={(e) => setMiles(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label>Vehicle (optional)</label>
          <select
            value={vehicleId}
            onChange={(e) => setVehicleId(e.target.value)}
          >
            <option value="">— None —</option>
            {vehicles.map((v) => (
              <option key={v.id} value={v.id}>{v.name}</option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>From (optional)</label>
          <input
            type="text"
            value={startLocation}
            onChange={(e) => setStartLocation(e.target.value)}
            placeholder="e.g. Home"
          />
        </div>
        <div className="field">
          <label>To (optional)</label>
          <input
            type="text"
            value={endLocation}
            onChange={(e) => setEndLocation(e.target.value)}
            placeholder="e.g. Client site"
          />
        </div>
        <div className="field">
          <label>Notes (optional)</label>
          <textarea
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div className="modal-footer">
          <button className="btn secondary" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn" type="submit" disabled={submitting}>
            {submitting ? 'Saving…' : 'Save trip'}
          </button>
        </div>
      </form>
    </div>
  );
}

function SummaryCard({
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
