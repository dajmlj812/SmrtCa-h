import { pool } from '../db/pool.js';
import { getEffectiveValue } from './settings.js';
import { tryMail } from './mailer.js';

/**
 * Backlog (0.13.2) — anomaly detection / alerts.
 *
 * Three rules, each emitting at most one row per (transaction, kind):
 *
 *   1. **large_amount** — single transaction whose absolute spend
 *      exceeds ANOMALY_LARGE_TXN_THRESHOLD_CENTS. Catches "big-ticket
 *      surprise" — annual subscription auto-renew, large medical
 *      bill, fraud test charge.
 *
 *   2. **unusual_at_merchant** — transaction whose amount is
 *      >= ANOMALY_MULTIPLIER × the median spend at the SAME merchant.
 *      Only fires when the merchant has been seen at least 5 times
 *      (statistical confidence floor — a one-shot vendor never has
 *      a "usual" spend). Catches "Starbucks normally $8, this one is
 *      $80" — typical fraud pattern.
 *
 *   3. **duplicate_suspect** — same account + same amount + same
 *      merchant within 24 hours of another transaction. Most banks
 *      already catch true duplicates via FITID dedup; this surfaces
 *      LIKELY double-charges (split bills, retry-after-decline, etc.).
 *
 * The scanner is intentionally LAZY: it inserts only NEW rows
 * (ON CONFLICT DO NOTHING on the (transaction_id, kind) unique).
 * Re-running on an already-scanned dataset is free.
 */

export interface ScanResult {
  enabled: boolean;
  scanned: number;
  newAlerts: number;
  byKind: Record<string, number>;
}

interface AnomalyConfig {
  enabled: boolean;
  largeThresholdCents: number;
  multiplier: number;
  emailTo: string;
}

async function loadConfig(): Promise<AnomalyConfig> {
  const enabledStr = (await getEffectiveValue('ANOMALY_ENABLED')).toLowerCase();
  const enabled =
    enabledStr === 'true' || enabledStr === '1' || enabledStr === 'yes';
  const thresholdStr = await getEffectiveValue('ANOMALY_LARGE_TXN_THRESHOLD_CENTS');
  const largeThresholdCents = Number(thresholdStr) || 50_000;
  const mulStr = await getEffectiveValue('ANOMALY_MULTIPLIER');
  const mul = Number(mulStr);
  const multiplier = Number.isFinite(mul) && mul >= 1.5 ? mul : 3;
  const emailTo = (await getEffectiveValue('ANOMALY_EMAIL_TO')).trim();
  return { enabled, largeThresholdCents, multiplier, emailTo };
}

interface InsertedAlert {
  id: string;
  transaction_id: string;
  kind: string;
  severity: string;
  message: string;
}

/**
 * Scan all (or a specific subset of) the tenant's transactions for
 * anomalies. Inserts rows into anomaly_alerts; returns counts. Pass
 * `txnIds = null` to scan everything; pass a list to scope to e.g.
 * a freshly-imported batch.
 */
export async function scanTransactionsForAnomalies(
  tenantId: string,
  txnIds: string[] | null = null,
): Promise<ScanResult> {
  const cfg = await loadConfig();
  if (!cfg.enabled) {
    return { enabled: false, scanned: 0, newAlerts: 0, byKind: {} };
  }

  // Always bind $2 to txnIds (NULL when scanning everything) so the
  // parameter positions never shift. Filter tolerates NULL.
  const txnFilterSql = `AND ($2::uuid[] IS NULL OR t.id = ANY($2::uuid[]))`;
  const txnIdsArg: string[] | null = txnIds === null ? null : txnIds;

  const scanned = await pool.query<{ c: string }>(
    `SELECT count(*)::text AS c
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        ${txnFilterSql}`,
    [tenantId, txnIdsArg],
  );
  const inserted: InsertedAlert[] = [];

  // ── 1. large_amount ────────────────────────────────────────
  const large = await pool.query<InsertedAlert>(
    `INSERT INTO anomaly_alerts
       (tenant_id, transaction_id, kind, severity, message, details)
     SELECT $1, t.id, 'large_amount',
            CASE WHEN abs(t.amount_cents) >= $3 * 2 THEN 'high' ELSE 'warn' END,
            'Large transaction: ' ||
              to_char(t.amount_cents::numeric / 100.0, 'FM"$"999,999,999.00') ||
              ' at ' || COALESCE(t.normalized_merchant, t.raw_description, '(unknown)'),
            jsonb_build_object(
              'amount_cents', t.amount_cents,
              'threshold_cents', $3,
              'merchant', COALESCE(t.normalized_merchant, t.raw_description),
              'date', t.txn_date::text
            )
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1
        ${txnFilterSql}
        AND t.amount_cents <= -$3
     ON CONFLICT (transaction_id, kind) DO NOTHING
     RETURNING id, transaction_id, kind, severity, message`,
    [tenantId, txnIdsArg, cfg.largeThresholdCents],
  );
  inserted.push(...large.rows);

  // ── 2. unusual_at_merchant ─────────────────────────────────
  // Compare each transaction's absolute amount to the median of
  // its merchant (only when merchant has >= 5 historical txns).
  const unusual = await pool.query<InsertedAlert>(
    `WITH merchant_stats AS (
       SELECT COALESCE(t.normalized_merchant, t.raw_description) AS merchant,
              percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(t.amount_cents))
                AS median_abs,
              count(*) AS n
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
        GROUP BY COALESCE(t.normalized_merchant, t.raw_description)
        -- >= 6 so that 5 PRIOR observations + the candidate outlier
        -- pass the gate. The outlier itself is in the GROUP BY so
        -- a literal "seen 5 times" check would let a 5-txn merchant's
        -- first big charge fire as soon as it landed.
        HAVING count(*) >= 6
     )
     INSERT INTO anomaly_alerts
       (tenant_id, transaction_id, kind, severity, message, details)
     SELECT $1, t.id, 'unusual_at_merchant', 'warn',
            'Unusually large at ' || ms.merchant || ': ' ||
              to_char(t.amount_cents::numeric / 100.0, 'FM"$"999,999,999.00') ||
              ' (median ' ||
              to_char(ms.median_abs::numeric / 100.0, 'FM"$"999,999,999.00') ||
              ')',
            jsonb_build_object(
              'amount_cents', t.amount_cents,
              'merchant', ms.merchant,
              'median_abs_cents', round(ms.median_abs)::bigint,
              'multiplier', $3::numeric,
              'sample_size', ms.n
            )
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN merchant_stats ms
         ON ms.merchant = COALESCE(t.normalized_merchant, t.raw_description)
      WHERE a.tenant_id = $1
        ${txnFilterSql}
        AND t.amount_cents < 0
        AND abs(t.amount_cents) >= ms.median_abs * $3
        AND ms.median_abs > 0
     ON CONFLICT (transaction_id, kind) DO NOTHING
     RETURNING id, transaction_id, kind, severity, message`,
    [tenantId, txnIdsArg, cfg.multiplier],
  );
  inserted.push(...unusual.rows);

  // ── 3. duplicate_suspect ──────────────────────────────────
  // Pair-up same account + same amount + same merchant within 24h.
  // Self-join produces both (A,B) and (B,A); we only flag the
  // SECOND one (later created_at) so each pair surfaces once.
  const dups = await pool.query<InsertedAlert>(
    `INSERT INTO anomaly_alerts
       (tenant_id, transaction_id, kind, severity, message, details)
     SELECT $1, t2.id, 'duplicate_suspect', 'warn',
            'Possible duplicate at ' ||
              COALESCE(t2.normalized_merchant, t2.raw_description) ||
              ': ' ||
              to_char(t2.amount_cents::numeric / 100.0, 'FM"$"999,999,999.00') ||
              ' twice within 24h',
            jsonb_build_object(
              'amount_cents', t2.amount_cents,
              'merchant', COALESCE(t2.normalized_merchant, t2.raw_description),
              'other_transaction_id', t1.id,
              'other_date', t1.txn_date::text
            )
       FROM transactions t2
       JOIN accounts a ON a.id = t2.account_id
       JOIN transactions t1
         ON t1.account_id = t2.account_id
        AND t1.amount_cents = t2.amount_cents
        AND COALESCE(t1.normalized_merchant, t1.raw_description)
            = COALESCE(t2.normalized_merchant, t2.raw_description)
        AND t1.id <> t2.id
        AND t1.created_at < t2.created_at
        AND t2.created_at - t1.created_at < interval '24 hours'
      WHERE a.tenant_id = $1
        AND ($2::uuid[] IS NULL OR t2.id = ANY($2::uuid[]))
        AND t2.amount_cents < 0
     ON CONFLICT (transaction_id, kind) DO NOTHING
     RETURNING id, transaction_id, kind, severity, message`,
    [tenantId, txnIdsArg],
  );
  inserted.push(...dups.rows);

  const byKind: Record<string, number> = {};
  for (const r of inserted) byKind[r.kind] = (byKind[r.kind] ?? 0) + 1;

  // SMTP digest — best-effort, non-blocking failure. Sends one email
  // per scan, not per alert, to avoid mail-bombing on a big import.
  if (inserted.length > 0 && cfg.emailTo) {
    const lines = inserted.map((a) => `[${a.severity.toUpperCase()}] ${a.message}`);
    void tryMail({
      to: cfg.emailTo,
      subject: `SmrtCash: ${inserted.length} new anomal${inserted.length === 1 ? 'y' : 'ies'} detected`,
      text:
        `SmrtCash detected ${inserted.length} new anomal${inserted.length === 1 ? 'y' : 'ies'} in your transactions:\n\n` +
        lines.join('\n') +
        '\n\nVisit /anomalies to review or dismiss them.',
    }).catch(() => {
      /* swallow — mailer logs internally */
    });
  }

  return {
    enabled: true,
    scanned: Number(scanned.rows[0]!.c),
    newAlerts: inserted.length,
    byKind,
  };
}
