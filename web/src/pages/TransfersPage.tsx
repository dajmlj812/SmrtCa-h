import { useEffect, useState } from 'react';
import { api, type Transfer, type DetectTransfersSummary } from '../api';
import { formatCents, formatDate } from '../format';

export function TransfersPage() {
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [detecting, setDetecting] = useState(false);
  const [lastDetect, setLastDetect] = useState<DetectTransfersSummary | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setTransfers(await api.listTransfers());
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load transfers');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function runDetect() {
    setDetecting(true);
    setError(null);
    try {
      const summary = await api.detectTransfers();
      setLastDetect(summary);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Detection failed');
    } finally {
      setDetecting(false);
    }
  }

  async function unlink(groupId: string) {
    if (!window.confirm('Unlink this transfer? Both transactions will go back to counting as spending / income.')) {
      return;
    }
    setError(null);
    try {
      await api.unlinkTransfer(groupId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unlink failed');
    }
  }

  return (
    <div>
      <div className="page-header">
        <div>
          <h1>Transfers</h1>
          <div className="subtitle">
            Internal moves between your own accounts. Linked pairs are excluded
            from spending and income totals.
          </div>
        </div>
        <button className="btn" disabled={detecting} onClick={runDetect}>
          {detecting ? 'Detecting…' : 'Detect transfers'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {lastDetect && (
        <div className="banner success">
          Scanned {lastDetect.scanned} candidate pair(s); created{' '}
          {lastDetect.paired} new transfer{lastDetect.paired === 1 ? '' : 's'}.
        </div>
      )}

      {loading ? (
        <p className="empty">Loading…</p>
      ) : transfers.length === 0 ? (
        <p className="empty">
          No transfers yet. Click <strong>Detect transfers</strong> to pair
          equal-opposite amounts on different accounts within 5 days of each
          other.
        </p>
      ) : (
        <div className="transfer-list">
          {transfers.map((t) => (
            <div key={t.group_id} className="transfer-card">
              <div className="transfer-card-body">
                {t.transactions.map((leg) => (
                  <div key={leg.id} className="transfer-leg">
                    <div className="transfer-leg-date">{formatDate(leg.txn_date)}</div>
                    <div className="transfer-leg-account">{leg.account_name}</div>
                    <div className="transfer-leg-desc">
                      {leg.normalized_merchant ?? leg.raw_description}
                    </div>
                    <div className={`num ${leg.amount_cents < 0 ? 'neg' : 'pos'}`}>
                      {formatCents(leg.amount_cents)}
                    </div>
                  </div>
                ))}
              </div>
              <button
                className="btn danger small"
                type="button"
                onClick={() => void unlink(t.group_id)}
              >
                Unlink
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
