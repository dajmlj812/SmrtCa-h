import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Holding } from '../api';
import { formatCents, formatDate } from '../format';

interface Props {
  accountId: string;
  /** Called whenever holdings change so the parent can refresh the account total. */
  onChanged?: () => void;
}

/** Display 6-decimal numerics without trailing zero noise. */
function fmtQty(q: number): string {
  return q.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

export function HoldingsPanel({ accountId, onChanged }: Props) {
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHoldings(await api.listHoldings(accountId));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load holdings');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function markToMarket(h: Holding) {
    const input = window.prompt(
      `Update last price for ${h.symbol ?? h.name} ($${(h.last_price_cents / 100).toFixed(2)})`,
      (h.last_price_cents / 100).toFixed(2),
    );
    if (input === null) return;
    const cents = Math.round(Number(input) * 100);
    if (!Number.isFinite(cents) || cents < 0) {
      setError('Price must be ≥ 0');
      return;
    }
    try {
      await api.updateHolding(h.id, {
        lastPriceCents: cents,
        lastPriceDate: new Date().toISOString().slice(0, 10),
      });
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  async function remove(h: Holding) {
    if (!window.confirm(`Remove ${h.symbol ?? h.name}?`)) return;
    try {
      await api.deleteHolding(h.id);
      await load();
      onChanged?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Delete failed');
    }
  }

  const total = holdings.reduce(
    (acc, h) => acc + h.market_value_cents,
    0,
  );
  const totalCost = holdings.reduce((acc, h) => acc + h.cost_basis_cents, 0);
  const totalGain = total - totalCost;

  return (
    <div className="card holdings-panel">
      <div className="page-section-head">
        <h2>Holdings</h2>
        <button className="btn" type="button" onClick={() => setShowAdd(true)}>
          Add holding
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : holdings.length === 0 ? (
        <p className="empty">No holdings yet on this account.</p>
      ) : (
        <>
          <div className="holdings-totals">
            <span>
              <span className="muted">Market value </span>
              <strong>{formatCents(total)}</strong>
            </span>
            <span>
              <span className="muted">Cost basis </span>
              <strong>{formatCents(totalCost)}</strong>
            </span>
            <span>
              <span className="muted">Unrealized </span>
              <strong className={totalGain >= 0 ? 'pos' : 'neg'}>
                {formatCents(totalGain)}
              </strong>
            </span>
          </div>
          <div className="table-wrap">
            <table className="txn-table">
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Name</th>
                  <th className="num">Quantity</th>
                  <th className="num">Last price</th>
                  <th className="num">Market value</th>
                  <th className="num">Unrealized</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr key={h.id}>
                    <td>{h.symbol ?? '—'}</td>
                    <td>{h.name}</td>
                    <td className="num">{fmtQty(h.quantity)}</td>
                    <td className="num nowrap">
                      {formatCents(h.last_price_cents)}
                      {h.last_price_date && (
                        <span className="muted" style={{ fontSize: 11, marginLeft: 4 }}>
                          {formatDate(h.last_price_date)}
                        </span>
                      )}
                    </td>
                    <td className="num">{formatCents(h.market_value_cents)}</td>
                    <td className={`num ${h.unrealized_gain_cents >= 0 ? 'pos' : 'neg'}`}>
                      {formatCents(h.unrealized_gain_cents)}
                    </td>
                    <td>
                      <button
                        className="btn-link"
                        type="button"
                        onClick={() => void markToMarket(h)}
                      >
                        Update price
                      </button>
                      <button
                        className="btn-link danger"
                        type="button"
                        onClick={() => void remove(h)}
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
        <NewHoldingForm
          accountId={accountId}
          onClose={() => setShowAdd(false)}
          onSaved={() => {
            setShowAdd(false);
            void load();
            onChanged?.();
          }}
        />
      )}
    </div>
  );
}

function NewHoldingForm({
  accountId,
  onClose,
  onSaved,
}: {
  accountId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [symbol, setSymbol] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('');
  const [costBasis, setCostBasis] = useState('');
  const [lastPrice, setLastPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const q = Number(quantity);
      if (!Number.isFinite(q) || q <= 0) throw new Error('Quantity must be > 0');
      await api.createHolding({
        accountId,
        symbol: symbol.trim() === '' ? undefined : symbol.trim(),
        name: name.trim(),
        quantity: q,
        costBasisCents: Math.round(Number(costBasis || '0') * 100),
        lastPriceCents: Math.round(Number(lastPrice || '0') * 100),
        lastPriceDate: lastPrice ? new Date().toISOString().slice(0, 10) : null,
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
          <h2>Add holding</h2>
          <button className="modal-close" type="button" onClick={onClose}>
            ✕
          </button>
        </header>
        <form onSubmit={submit}>
          {error && <div className="banner error">{error}</div>}
          <div className="form-grid">
            <div className="field">
              <label htmlFor="h-symbol">Symbol (optional)</label>
              <input
                id="h-symbol"
                value={symbol}
                onChange={(e) => setSymbol(e.target.value)}
                placeholder="VOO"
              />
            </div>
            <div className="field">
              <label htmlFor="h-name">Name</label>
              <input
                id="h-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Vanguard S&P 500"
                required
                autoFocus
              />
            </div>
            <div className="field">
              <label htmlFor="h-qty">Quantity</label>
              <input
                id="h-qty"
                type="number"
                step="0.000001"
                min="0.000001"
                value={quantity}
                onChange={(e) => setQuantity(e.target.value)}
                required
              />
            </div>
            <div className="field">
              <label htmlFor="h-cost">Cost basis (total $)</label>
              <input
                id="h-cost"
                type="number"
                step="0.01"
                min="0"
                value={costBasis}
                onChange={(e) => setCostBasis(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="h-price">Current price ($)</label>
              <input
                id="h-price"
                type="number"
                step="0.01"
                min="0"
                value={lastPrice}
                onChange={(e) => setLastPrice(e.target.value)}
              />
            </div>
          </div>
          <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
            <button className="btn" type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : 'Create holding'}
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
