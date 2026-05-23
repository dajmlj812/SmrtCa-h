import { useEffect, useState, type FormEvent } from 'react';
import {
  api,
  type FuelPrice,
  type Vehicle,
  type VehicleFuelType,
} from '../api';
import { formatCents, formatDate } from '../format';

const FUEL_TYPES: Array<{ value: VehicleFuelType; label: string }> = [
  { value: 'regular', label: 'Regular' },
  { value: 'midgrade', label: 'Mid-grade' },
  { value: 'premium', label: 'Premium' },
  { value: 'diesel', label: 'Diesel' },
  { value: 'electric', label: 'Electric' },
];

export function VehiclesPage() {
  const [vehicles, setVehicles] = useState<Vehicle[]>([]);
  const [prices, setPrices] = useState<FuelPrice[]>([]);
  const [eiaConfigured, setEiaConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [v, p] = await Promise.all([
        api.listVehicles(),
        api.listFuelPrices(),
      ]);
      setVehicles(v);
      setPrices(p.prices);
      setEiaConfigured(p.eiaConfigured);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function refresh() {
    setRefreshing(true);
    setError(null);
    try {
      const s = await api.refreshFuelPrices();
      if (!s.configured) {
        setError(
          'EIA_API_KEY is not set on the server — set a manual price below or configure the key in .env to enable auto-fetch.',
        );
      } else if (s.failed.length > 0) {
        setError(`Refreshed ${s.refreshed.length}; failed: ${s.failed.join(', ')}`);
      }
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed');
    } finally {
      setRefreshing(false);
    }
  }

  async function setManual(grade: string, input: string) {
    const cents = Math.round(Number(input) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Price must be ≥ 0');
      return;
    }
    try {
      await api.setManualFuelPrice(grade, cents);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    }
  }

  async function removeVehicle(v: Vehicle) {
    if (!window.confirm(`Delete ${v.name}?`)) return;
    try {
      await api.deleteVehicle(v.id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Vehicles</h1>
          <div className="subtitle">
            Fleet data drives the fuel column on the AutoMagic budget wizard.
          </div>
        </div>
        <button className="btn" onClick={() => setShowAdd(true)}>
          Add vehicle
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="page-section">
        <div className="page-section-head">
          <h2>Fuel prices</h2>
          <button
            className="btn secondary"
            type="button"
            disabled={refreshing}
            onClick={() => void refresh()}
            title={eiaConfigured ? 'Pull latest from api.eia.gov' : 'EIA_API_KEY not set; will no-op'}
          >
            {refreshing ? 'Refreshing…' : 'Refresh from EIA'}
          </button>
        </div>
        <div className="card">
          <table className="txn-table">
            <thead>
              <tr>
                <th>Grade</th>
                <th className="num">Current ($/gal)</th>
                <th>Source</th>
                <th>Updated</th>
                <th>Set manual</th>
              </tr>
            </thead>
            <tbody>
              {(['regular', 'midgrade', 'premium', 'diesel'] as const).map((grade) => {
                const row = prices.find((p) => p.fuel_type === grade);
                return (
                  <tr key={grade}>
                    <td>{grade}</td>
                    <td className="num">
                      {row ? formatCents(row.price_cents_per_gallon) : '—'}
                    </td>
                    <td>{row?.source ?? '—'}</td>
                    <td className="nowrap muted">
                      {row?.fetched_at ? new Date(row.fetched_at).toLocaleDateString() : '—'}
                    </td>
                    <td>
                      <ManualPriceInput
                        defaultValue={row ? (row.price_cents_per_gallon / 100).toFixed(2) : ''}
                        onCommit={(v) => void setManual(grade, v)}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="page-section">
        <div className="page-section-head">
          <h2>Fleet</h2>
        </div>
        {loading ? (
          <p className="empty">Loading…</p>
        ) : vehicles.length === 0 ? (
          <p className="empty">No vehicles yet. Add one to start the fuel calculator.</p>
        ) : (
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Fuel</th>
                  <th className="num">MPG / kWh/mi</th>
                  <th className="num">Weekly miles</th>
                  <th>Active</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {vehicles.map((v) => (
                  <tr key={v.id}>
                    <td>{v.name}</td>
                    <td>{v.fuel_type}</td>
                    <td className="num">
                      {v.fuel_type === 'electric'
                        ? `${v.kwh_per_mile} kWh/mi · ${formatCents(v.electricity_rate_cents_per_kwh)}/kWh`
                        : `${v.mpg} mpg`}
                    </td>
                    <td className="num">{v.weekly_avg_miles}</td>
                    <td>{v.active ? '✓' : '—'}</td>
                    <td>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void removeVehicle(v)}
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
        <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>
          Created {formatDate(vehicles[0]?.created_at ?? new Date().toISOString())}
        </div>
      </div>

      {showAdd && (
        <NewVehicleForm
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

function ManualPriceInput({
  defaultValue,
  onCommit,
}: {
  defaultValue: string;
  onCommit: (value: string) => void;
}) {
  const [value, setValue] = useState(defaultValue);
  return (
    <input
      type="number"
      step="0.01"
      min="0"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => {
        if (value !== defaultValue && value !== '') onCommit(value);
      }}
      style={{ width: 100 }}
    />
  );
}

function NewVehicleForm({
  onClose,
  onSaved,
}: {
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState('');
  const [fuelType, setFuelType] = useState<VehicleFuelType>('regular');
  const [mpg, setMpg] = useState('');
  const [kwhPerMile, setKwhPerMile] = useState('');
  const [elecRate, setElecRate] = useState('');
  const [weeklyMiles, setWeeklyMiles] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      await api.createVehicle({
        name: name.trim(),
        fuelType,
        weeklyAvgMiles: Number(weeklyMiles) || 0,
        ...(fuelType === 'electric'
          ? {
              kwhPerMile: Number(kwhPerMile),
              electricityRateCentsPerKwh: Math.round(Number(elecRate) * 100),
            }
          : { mpg: Number(mpg) }),
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
          <h2>Add vehicle</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="v-name">Name</label>
              <input
                id="v-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="v-fuel">Fuel type</label>
              <select
                id="v-fuel"
                value={fuelType}
                onChange={(e) => setFuelType(e.target.value as VehicleFuelType)}
              >
                {FUEL_TYPES.map((f) => (
                  <option key={f.value} value={f.value}>
                    {f.label}
                  </option>
                ))}
              </select>
            </div>
            {fuelType === 'electric' ? (
              <>
                <div className="field">
                  <label htmlFor="v-kwh">kWh per mile</label>
                  <input
                    id="v-kwh"
                    type="number"
                    step="0.001"
                    min="0"
                    value={kwhPerMile}
                    onChange={(e) => setKwhPerMile(e.target.value)}
                    required
                    placeholder="0.30"
                  />
                </div>
                <div className="field">
                  <label htmlFor="v-rate">$/kWh</label>
                  <input
                    id="v-rate"
                    type="number"
                    step="0.001"
                    min="0"
                    value={elecRate}
                    onChange={(e) => setElecRate(e.target.value)}
                    required
                    placeholder="0.18"
                  />
                </div>
              </>
            ) : (
              <div className="field">
                <label htmlFor="v-mpg">MPG</label>
                <input
                  id="v-mpg"
                  type="number"
                  step="0.1"
                  min="1"
                  value={mpg}
                  onChange={(e) => setMpg(e.target.value)}
                  required
                />
              </div>
            )}
            <div className="field">
              <label htmlFor="v-miles">Weekly avg miles</label>
              <input
                id="v-miles"
                type="number"
                step="1"
                min="0"
                value={weeklyMiles}
                onChange={(e) => setWeeklyMiles(e.target.value)}
                required
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create vehicle'}
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
