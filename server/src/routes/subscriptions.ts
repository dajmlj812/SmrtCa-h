import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { config } from '../config.js';
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
 * Two endpoints:
 *
 *   POST /api/subscriptions/scan
 *     Runs the rules-based recurring detector, persists new bill-kind
 *     suggestions (skipping duplicates and the rejected/confirmed
 *     lists), and — when AI_PROVIDER=claude — asks Claude to filter
 *     down to actual subscriptions. Non-subscriptions get auto-rejected
 *     with a one-line reason; subscriptions get a polished display
 *     name and ai_refined=true.
 *
 *     Returns counts so the page can show "found N subscriptions" and
 *     "auto-rejected M utilities/loans".
 *
 *   GET /api/subscriptions/candidates
 *     Pending bill-kind suggestions. The UI lists them above the
 *     action queue with Confirm / Reject / Snooze controls (those
 *     reuse the existing /api/recurring/suggestions/:id/* endpoints).
 */

const SUGGESTION_COLUMNS = `id, kind, name, normalized_key, amount_cents,
  detected_frequency, sample_txn_ids, confidence, status, resolved_to_id,
  ai_refined, created_at, resolved_at`;

export async function subscriptionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/subscriptions/candidates', async () => {
    const r = await query(
      `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
        WHERE status = 'pending' AND kind = 'bill'
        ORDER BY ai_refined DESC, confidence DESC, created_at DESC`,
    );
    return { candidates: r.rows };
  });

  app.post('/api/subscriptions/scan', async (req, reply) => {
    // 1) Run the rules-based detector and insert new bill-kind suggestions.
    const txns = await pool.query<RecurringInput>(
      `SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS date, amount_cents,
              normalized_merchant, raw_description
         FROM transactions
        WHERE transfer_group_id IS NULL
        ORDER BY txn_date DESC`,
    );
    const ruleHits = detectRecurring(txns.rows).filter((s) => s.kind === 'bill');

    const existing = await pool.query<{ normalized_key: string }>(
      `SELECT normalized_key FROM recurring_suggestions
        WHERE kind = 'bill'
          AND status IN ('pending','confirmed','rejected','snoozed')`,
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
           (kind, name, normalized_key, amount_cents, detected_frequency,
            sample_txn_ids, confidence)
         VALUES ('bill', $1, $2, $3, $4, $5::uuid[], $6)
         RETURNING id`,
        [
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

    // 2) Pick the pending bill-kind suggestions that haven't been
    //    AI-refined yet. New ones from this run + any from a previous
    //    run that didn't get classified (e.g. AI was off then).
    const pending = await pool.query<{
      id: string;
      name: string;
      amount_cents: number;
      detected_frequency: string;
      sample_txn_ids: string[];
    }>(
      `SELECT id, name, amount_cents, detected_frequency, sample_txn_ids
         FROM recurring_suggestions
        WHERE status = 'pending'
          AND kind = 'bill'
          AND ai_refined = false`,
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

    // 3) Pull a handful of raw_descriptions per suggestion for the AI prompt.
    const allSampleIds = pending.rows.flatMap((p) => p.sample_txn_ids ?? []);
    let descByTxnId = new Map<string, string>();
    if (allSampleIds.length > 0) {
      const desc = await pool.query<{ id: string; raw_description: string }>(
        `SELECT id, raw_description FROM transactions
          WHERE id = ANY($1::uuid[])`,
        [allSampleIds],
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

    // 4) Apply verdicts. Subscriptions: rename + ai_refined=true. Non-subs:
    //    status='rejected' with the AI's reason stored on resolved_at.
    let kept = 0;
    let rejected = 0;
    await withTransaction(async (client) => {
      for (const v of verdicts) {
        if (v.isSubscription) {
          await client.query(
            `UPDATE recurring_suggestions
                SET name = $1,
                    ai_refined = true
              WHERE id = $2 AND status = 'pending'`,
            [v.displayName, v.id],
          );
          kept++;
        } else {
          await client.query(
            `UPDATE recurring_suggestions
                SET status = 'rejected',
                    ai_refined = true,
                    resolved_at = now()
              WHERE id = $1 AND status = 'pending'`,
            [v.id],
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
