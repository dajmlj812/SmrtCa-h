import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  api,
  type Account,
  type PayoffPlan,
  type PayoffResponse,
} from '../api';
import { formatCents } from '../format';

/**
 * 0.18.6 — Debt payoff planning page.
 *
 * Lists every loan / credit_card account with a positive balance,
 * lets the user fill in any missing APR + min-payment values
 * inline (PATCH /api/accounts/:id), and computes both snowball
 * and avalanche projections with a configurable "extra per month".
 */
export function DebtPayoffPage() {
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [plan, setPlan] = useState<PayoffResponse | null>(null);
  const [extraDollars, setExtraDollars] = useState('0');
  const [loading, setLoading] = useState(true);
  const [computing, setComputing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<'snowball' | 'avalanche'>(
    'avalanche',
  );

  const debtAccounts = useMemo(
    () =>
      accounts.filter(
        (a) =>
          (a.type === 'loan' || a.type === 'credit_card') &&
          Math.abs(a.balance_cents) > 0,
      ),
    [accounts],
  );

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setAccounts(await api.listAccounts());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Load failed');
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function compute() {
    setComputing(true);
    setError(null);
    try {
      const cents = Math.round(Number(extraDollars || '0') * 100);
      const r = await api.computeDebtPayoff({
        extraCents: Number.isFinite(cents) && cents >= 0 ? cents : 0,
      });
      setPlan(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compute failed');
    } finally {
      setComputing(false);
    }
  }

  async function patchAccount(id: string, body: {
    interest_rate_apr?: number | null;
    min_payment_cents?: number | null;
  }) {
    try {
      await api.updateAccount(id, body);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Update failed');
    }
  }

  const active: PayoffPlan | null =
    plan === null
      ? null
      : strategy === 'snowball'
        ? plan.snowball
        : plan.avalanche;

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Debt payoff</h1>
          <div className="subtitle">
            Snowball (smallest balance first) vs. avalanche (highest APR
            first), computed against your loan and credit-card accounts.
          </div>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="empty">Loading accounts…</p>
      ) : debtAccounts.length === 0 ? (
        <div className="card">
          <p className="muted">
            No loan or credit-card accounts with a balance. Add one on{' '}
            <Link to="/accounts">Accounts</Link>, then come back here.
          </p>
        </div>
      ) : (
        <>
          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ marginTop: 0 }}>Your debt accounts</h2>
            <p className="muted small">
              Fill in APR and minimum payment for each account so the
              calculator has something to work with. Edits save immediately.
            </p>
            <table className="apikeys-table">
              <thead>
                <tr>
                  <th>Account</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                  <th style={{ textAlign: 'right' }}>APR %</th>
                  <th style={{ textAlign: 'right' }}>Min payment</th>
                </tr>
              </thead>
              <tbody>
                {debtAccounts.map((a) => (
                  <tr key={a.id}>
                    <td>
                      <strong>{a.name}</strong>{' '}
                      <span className="muted small">({a.type})</span>
                    </td>
                    <td className="num neg">
                      {formatCents(-Math.abs(a.balance_cents))}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={a.interest_rate_apr ?? ''}
                        placeholder="e.g. 24.99"
                        style={{ width: 90, textAlign: 'right' }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const next = v === '' ? null : Number(v);
                          if (next !== (a.interest_rate_apr ?? null)) {
                            void patchAccount(a.id, { interest_rate_apr: next });
                          }
                        }}
                      />
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <input
                        type="number"
                        step="0.01"
                        defaultValue={
                          a.min_payment_cents !== null
                            ? (a.min_payment_cents / 100).toFixed(2)
                            : ''
                        }
                        placeholder="e.g. 35.00"
                        style={{ width: 100, textAlign: 'right' }}
                        onBlur={(e) => {
                          const v = e.target.value.trim();
                          const next =
                            v === '' ? null : Math.round(Number(v) * 100);
                          if (next !== (a.min_payment_cents ?? null)) {
                            void patchAccount(a.id, { min_payment_cents: next });
                          }
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card" style={{ marginBottom: 16 }}>
            <h2 style={{ marginTop: 0 }}>Run the plan</h2>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-end', flexWrap: 'wrap' }}>
              <div className="field" style={{ marginBottom: 0 }}>
                <label htmlFor="extra">Extra per month (above minimums)</label>
                <input
                  id="extra"
                  type="number"
                  step="0.01"
                  value={extraDollars}
                  onChange={(e) => setExtraDollars(e.target.value)}
                  style={{ width: 120 }}
                />
              </div>
              <button
                className="btn"
                type="button"
                onClick={() => void compute()}
                disabled={computing}
              >
                {computing ? 'Computing…' : 'Compute plan'}
              </button>
            </div>
          </div>

          {plan && plan.missing_data.length > 0 && (
            <div className="banner warn" style={{ marginBottom: 16 }}>
              Missing {plan.missing_data.length} account
              {plan.missing_data.length === 1 ? "'s" : 's'} data —{' '}
              {plan.missing_data
                .map((m) => `${m.name} (${m.missing.join(', ')})`)
                .join('; ')}
              . These are excluded from the plan until you fill them in
              above.
            </div>
          )}

          {active && (
            <div className="card">
              <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 12 }}>
                <h2 style={{ margin: 0 }}>Plan</h2>
                <div className="tab-strip">
                  <button
                    type="button"
                    className={`tab ${strategy === 'avalanche' ? 'active' : ''}`}
                    onClick={() => setStrategy('avalanche')}
                  >
                    Avalanche (highest APR)
                  </button>
                  <button
                    type="button"
                    className={`tab ${strategy === 'snowball' ? 'active' : ''}`}
                    onClick={() => setStrategy('snowball')}
                  >
                    Snowball (smallest balance)
                  </button>
                </div>
              </div>

              {active.unpayable ? (
                <div className="banner error">
                  Even with current minimums + your extra, at least one debt
                  isn't being paid down (minimum doesn't cover monthly
                  interest). Increase the extra or raise the minimum on the
                  flagged accounts.
                </div>
              ) : (
                <>
                  <div className="cashflow-milestones" style={{ marginBottom: 16 }}>
                    <div className="milestone milestone-up">
                      <div className="milestone-label">Months</div>
                      <div className="milestone-value">{active.monthsToPayoff}</div>
                    </div>
                    <div className="milestone milestone-down">
                      <div className="milestone-label">Total interest</div>
                      <div className="milestone-value">
                        {formatCents(active.totalInterestCents)}
                      </div>
                    </div>
                    <div className="milestone milestone-up">
                      <div className="milestone-label">Total paid</div>
                      <div className="milestone-value">
                        {formatCents(active.totalPaidCents)}
                      </div>
                    </div>
                  </div>

                  <table className="apikeys-table">
                    <thead>
                      <tr>
                        <th>Account</th>
                        <th style={{ textAlign: 'right' }}>Paid off in</th>
                        <th style={{ textAlign: 'right' }}>Interest paid</th>
                        <th style={{ textAlign: 'right' }}>Total paid</th>
                      </tr>
                    </thead>
                    <tbody>
                      {active.perAccount.map((p) => (
                        <tr key={p.accountId}>
                          <td>{p.name}</td>
                          <td style={{ textAlign: 'right' }}>{p.monthsToPayoff} mo</td>
                          <td style={{ textAlign: 'right' }} className="num neg">
                            {formatCents(p.interestPaidCents)}
                          </td>
                          <td style={{ textAlign: 'right' }}>
                            {formatCents(p.totalPaidCents)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
