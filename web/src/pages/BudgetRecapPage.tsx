import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { marked } from 'marked';
import { api, type BudgetRecap } from '../api';
import { formatCents } from '../format';

/**
 * 0.21.x — month-end budget recap viewer.
 *
 * Fetches the persisted recap for /:month (YYYY-MM). If it doesn't
 * exist yet, offers a "Generate recap" button that calls the AI
 * pipeline. The narrative is rendered as markdown; the buckets
 * are rendered as a three-column table (hit / under / over).
 */
export function BudgetRecapPage() {
  const { month: monthParam } = useParams<{ month: string }>();
  const navigate = useNavigate();
  const month = (monthParam ?? '').slice(0, 7);
  const [recap, setRecap] = useState<BudgetRecap | null>(null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const r = await api.getBudgetRecap(month);
      setRecap(r);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Load failed';
      if (/no recap/i.test(msg)) {
        setRecap(null);
        setError(null);
      } else {
        setError(msg);
      }
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
      navigate('/monthly-budget');
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  async function generate() {
    setGenerating(true);
    setError(null);
    try {
      const r = await api.generateBudgetRecap(month);
      setRecap(r);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Generation failed');
    } finally {
      setGenerating(false);
    }
  }

  const monthLabel = month
    ? new Date(month + '-01T00:00:00Z').toLocaleString('default', {
        month: 'long',
        year: 'numeric',
        timeZone: 'UTC',
      })
    : '';

  const narrativeHtml = recap
    ? marked.parse(recap.narrative, { async: false })
    : '';

  const hit = recap?.buckets.filter((b) => b.status === 'hit') ?? [];
  const under = recap?.buckets.filter((b) => b.status === 'under') ?? [];
  const over = recap?.buckets.filter((b) => b.status === 'over') ?? [];

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>{monthLabel} budget recap</h1>
          <div className="subtitle">
            Where you hit your targets, where you under-spent, and where
            things went over.{' '}
            <Link to="/monthly-budget">← Back to Monthly budget</Link>
          </div>
        </div>
        {recap && (
          <button
            className="btn secondary"
            type="button"
            disabled={generating}
            onClick={() => void generate()}
            title="Re-run the AI feedback against the latest transaction data"
          >
            {generating ? 'Regenerating…' : 'Regenerate'}
          </button>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {loading && <p className="empty">Loading…</p>}

      {!loading && !recap && (
        <div className="card empty-card">
          <p className="muted">
            No recap generated for {monthLabel} yet.
          </p>
          <button
            className="btn"
            type="button"
            disabled={generating}
            onClick={() => void generate()}
          >
            {generating ? 'Generating…' : '✨ Generate recap'}
          </button>
          <p className="muted small" style={{ marginTop: 8 }}>
            Pulls every monthly-budget row + matched actuals, asks Claude
            for 3–5 paragraphs of feedback. Costs a few cents in API
            tokens.
          </p>
        </div>
      )}

      {recap && (
        <>
          <div className="card-grid" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
            <RecapStat label="Budgeted" value={formatCents(recap.budgeted_cents)} />
            <RecapStat
              label="Spent"
              value={formatCents(recap.actual_cents)}
              tone={recap.actual_cents > recap.budgeted_cents ? 'neg' : 'pos'}
            />
            <RecapStat
              label="Hit / under / over"
              value={`${recap.hit_count} / ${recap.under_count} / ${recap.over_count}`}
            />
            <RecapStat
              label="Net vs budget"
              value={formatCents(
                Math.abs(recap.budgeted_cents - recap.actual_cents),
              )}
              tone={
                recap.actual_cents > recap.budgeted_cents ? 'neg' : 'pos'
              }
            />
          </div>

          <div
            className="card"
            style={{ marginTop: 16 }}
            // narrative is markdown from Claude; rendered via marked.
            // We control the prompt so the content is trusted, and
            // marked() escapes HTML by default.
            // eslint-disable-next-line react/no-danger
            dangerouslySetInnerHTML={{ __html: narrativeHtml }}
          />

          <div className="recap-buckets" style={{ marginTop: 16 }}>
            <BucketTable title="Over budget" tone="neg" buckets={over} />
            <BucketTable title="Under budget" tone="pos" buckets={under} />
            <BucketTable title="Hit budget (±10%)" tone="" buckets={hit} />
          </div>

          <p className="muted small" style={{ marginTop: 16 }}>
            Generated{' '}
            {new Date(recap.generated_at).toLocaleString()}
          </p>
        </>
      )}
    </div>
  );
}

function RecapStat({
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
      <div className="muted small">{label}</div>
      <div
        style={{ fontSize: 22, fontWeight: 700, marginTop: 4 }}
        className={tone === 'pos' ? 'pos' : tone === 'neg' ? 'neg' : ''}
      >
        {value}
      </div>
    </div>
  );
}

function BucketTable({
  title,
  tone,
  buckets,
}: {
  title: string;
  tone: 'pos' | 'neg' | '';
  buckets: import('../api').BudgetRecapBucket[];
}) {
  if (buckets.length === 0) return null;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <h3 className={tone}>{title}</h3>
      <div className="table-wrap">
        <table className="txn-table">
          <thead>
            <tr>
              <th>Category</th>
              <th className="num">Budgeted</th>
              <th className="num">Actual</th>
              <th className="num">Δ</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((b) => (
              <tr key={b.category_name}>
                <td><strong>{b.category_name}</strong></td>
                <td className="num">{formatCents(b.budgeted_cents)}</td>
                <td className="num">{formatCents(b.actual_cents)}</td>
                <td className={`num ${tone}`}>
                  {b.delta_pct >= 0 ? '+' : ''}
                  {b.delta_pct.toFixed(0)}%
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
