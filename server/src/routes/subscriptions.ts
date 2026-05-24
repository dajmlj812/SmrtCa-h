import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
import { requireTenant } from '../auth/rbac.js';
import {
  detectRecurring,
  type RecurringInput,
} from '../domain/recurring.js';
import {
  classifySubscriptions,
  type SubscriptionCandidate,
} from '../domain/subscription-ai.js';

/**
 * AI-powered subscription discovery for the Subscriptions page.
 *
 * 0.14.1 — every route here is per-tenant. /scan walks only the
 * caller's transactions via an accounts join; new
 * `recurring_suggestions` rows carry `tenant_id`; the AI-applied
 * verdicts UPDATE is tenant-scoped so a malicious caller can't
 * mass-rename another tenant's suggestions.
 *
 * Two endpoints:
 *
 *   POST /api/subscriptions/scan
 *     Runs the rules-based recurring detector against this tenant,
 *     persists new bill-kind suggestions (skipping duplicates and
 *     the rejected/confirmed lists), and — when AI_PROVIDER=claude
 *     — asks Claude to filter down to actual subscriptions.
 *
 *   GET /api/subscriptions/candidates
 *     Pending bill-kind suggestions for this tenant.
 */

const SUGGESTION_COLUMNS = `id, kind, name, normalized_key, amount_cents,
  detected_frequency, sample_txn_ids, confidence, status, resolved_to_id,
  ai_refined, created_at, resolved_at`;

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/subscriptions/candidates', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const r = await query(
      `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
        WHERE tenant_id = $1
          AND status = 'pending' AND kind = 'bill'
        ORDER BY ai_refined DESC, confidence DESC, created_at DESC`,
      [tenantId],
    );
    return { candidates: r.rows };
  });

  app.post('/api/subscriptions/scan', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    // 1) Run the rules-based detector and insert new bill-kind suggestions.
    const txns = await pool.query<RecurringInput>(
      `SELECT t.id, to_char(t.txn_date, 'YYYY-MM-DD') AS date, t.amount_cents,
              t.normalized_merchant, t.raw_description
         FROM transactions t
         JOIN accounts a ON a.id = t.account_id
        WHERE a.tenant_id = $1
          AND t.transfer_group_id IS NULL
        ORDER BY t.txn_date DESC`,
      [tenantId],
    );
    const ruleHits = detectRecurring(txns.rows).filter((s) => s.kind === 'bill');

    // Tenant-scoped dedup on existing keys.
    const existing = await pool.query<{ normalized_key: string }>(
      `SELECT normalized_key FROM recurring_suggestions
        WHERE tenant_id = $1
          AND kind = 'bill'
          AND status IN ('pending','confirmed','rejected','snoozed')`,
      [tenantId],
    );
    const seen = new Set(
      existing.rows.map((r) => r.normalized_key.toUpperCase()),
    );

    let inserted = 0;
    const insertedIds: string[] = [];
    for (const s of ruleHits) {
      if (seen.has(s.normalizedKey.toUpperCase())) continue;
      const r = await query<{ id: string }>(
        `INSERT INTO recurring_suggestions
           (tenant_id, kind, name, normalized_key, amount_cents,
            detected_frequency, sample_txn_ids, confidence)
         VALUES ($1, 'bill', $2, $3, $4, $5, $6::uuid[], $7)
         RETURNING id`,
        [
          tenantId,
          s.name,
          s.normalizedKey,
          s.amountCents,
          s.detectedFrequency,
          s.sampleTxnIds,
          s.confidence,
        ],
      );
      insertedIds.push(r.rows[0]!.id);
      inserted++;
    }

    // 2) Pick this tenant's pending bill-kind suggestions that haven't
    //    been AI-refined yet.
    const pending = await pool.query<{
      id: string;
      name: string;
      amount_cents: number;
      detected_frequency: string;
      sample_txn_ids: string[];
    }>(
      `SELECT id, name, amount_cents, detected_frequency, sample_txn_ids
         FROM recurring_suggestions
        WHERE tenant_id = $1
          AND status = 'pending'
          AND kind = 'bill'
          AND ai_refined = false`,
      [tenantId],
    );

    if (config.ai.provider !== 'claude' || pending.rowCount === 0) {
      return {
        ai_used: false,
        scanned: txns.rowCount,
        inserted,
        refined: 0,
        kept: 0,
        rejected: 0,
        reason:
          config.ai.provider !== 'claude'
            ? 'Set AI_PROVIDER=claude on the Settings page to filter candidates down to true subscriptions.'
            : undefined,
      };
    }

    // 3) Pull raw_descriptions for the AI prompt — scoped via accounts
    //    join so smuggled sample_txn_ids from another tenant don't
    //    leak their merchant strings.
    const allSampleIds = pending.rows.flatMap((p) => p.sample_txn_ids ?? []);
    let descByTxnId = new Map<string, string>();
    if (allSampleIds.length > 0) {
      const desc = await pool.query<{ id: string; raw_description: string }>(
        `SELECT t.id, t.raw_description FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE a.tenant_id = $1 AND t.id = ANY($2::uuid[])`,
        [tenantId, allSampleIds],
      );
      descByTxnId = new Map(desc.rows.map((r) => [r.id, r.raw_description]));
    }
    const candidates: SubscriptionCandidate[] = pending.rows.map((p) => ({
      id: p.id,
      name: p.name,
      sampleDescriptions: (p.sample_txn_ids ?? [])
        .map((id) => descByTxnId.get(id))
        .filter((d): d is string => Boolean(d)),
      amountCents: Number(p.amount_cents),
      frequency: p.detected_frequency,
    }));

    let verdicts;
    try {
      verdicts = await classifySubscriptions(candidates);
    } catch (err) {
      return reply.code(502).send({
        error:
          err instanceof Error ? err.message : 'AI classification failed',
      });
    }

    // 4) Apply verdicts — UPDATE scoped to tenant so a verdict on
    //    another tenant's id is a no-op.
    let kept = 0;
    let rejected = 0;
    await withTransaction(async (client) => {
      for (const v of verdicts) {
        if (v.isSubscription) {
          await client.query(
            `UPDATE recurring_suggestions
                SET name = $1,
                    ai_refined = true
              WHERE id = $2 AND tenant_id = $3 AND status = 'pending'`,
            [v.displayName, v.id, tenantId],
          );
          kept++;
        } else {
          await client.query(
            `UPDATE recurring_suggestions
                SET status = 'rejected',
                    ai_refined = true,
                    resolved_at = now()
              WHERE id = $1 AND tenant_id = $2 AND status = 'pending'`,
            [v.id, tenantId],
          );
          rejected++;
        }
      }
    });

    return {
      ai_used: true,
      scanned: txns.rowCount,
      inserted,
      refined: verdicts.length,
      kept,
      rejected,
    };
  });
}
