import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import {
  type DetectedFrequency,
  type RecurringInput,
  detectRecurring,
} from '../domain/recurring.js';

const SUGGESTION_COLUMNS = `id, kind, name, normalized_key, amount_cents,
  detected_frequency, sample_txn_ids, confidence, status, resolved_to_id,
  ai_refined, created_at, resolved_at`;

const FREQ_TO_BILL: Record<DetectedFrequency, string | null> = {
  weekly: 'weekly',
  biweekly: 'biweekly',
  semimonthly: 'monthly', // bills schema doesn't have semimonthly — fold to monthly
  monthly: 'monthly',
  yearly: 'yearly',
  'one-time': 'one-time',
  unknown: 'monthly',
};
const FREQ_TO_INCOME: Record<DetectedFrequency, string | null> = {
  weekly: 'weekly',
  biweekly: 'biweekly',
  semimonthly: 'monthly',
  monthly: 'monthly',
  yearly: 'yearly',
  'one-time': null, // recurring_income has no one-time
  unknown: 'monthly',
};

export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  // Run detection and write new suggestions. Already-pending or already-
  // confirmed keys are skipped; rejected keys stay rejected so the user
  // isn't pestered.
  app.post('/api/recurring/detect', async () => {
    const txns = await pool.query<RecurringInput>(
      `SELECT id, to_char(txn_date, 'YYYY-MM-DD') AS date, amount_cents,
              normalized_merchant, raw_description
         FROM transactions
        WHERE transfer_group_id IS NULL
        ORDER BY txn_date DESC`,
    );
    const suggestions = detectRecurring(txns.rows);

    // Skip keys that are already in a live/rejected state for the same kind.
    const existing = await pool.query<{ kind: string; normalized_key: string; status: string }>(
      `SELECT kind, normalized_key, status FROM recurring_suggestions
        WHERE status IN ('pending','confirmed','rejected','snoozed')`,
    );
    const seen = new Set(
      existing.rows.map((r) => `${r.kind}:${r.normalized_key.toUpperCase()}`),
    );

    let inserted = 0;
    for (const s of suggestions) {
      const dedupKey = `${s.kind}:${s.normalizedKey.toUpperCase()}`;
      if (seen.has(dedupKey)) continue;
      await query(
        `INSERT INTO recurring_suggestions
           (kind, name, normalized_key, amount_cents, detected_frequency,
            sample_txn_ids, confidence)
         VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7)`,
        [
          s.kind,
          s.name,
          s.normalizedKey,
          s.amountCents,
          s.detectedFrequency,
          s.sampleTxnIds,
          s.confidence,
        ],
      );
      inserted++;
    }
    return {
      scanned: txns.rowCount,
      candidates: suggestions.length,
      inserted,
      skipped: suggestions.length - inserted,
    };
  });

  app.get<{ Querystring: { status?: string } }>(
    '/api/recurring/suggestions',
    async (req) => {
      const status = (req.query.status ?? 'pending').trim();
      const allowed = ['pending', 'confirmed', 'rejected', 'snoozed', 'all'];
      const filter = allowed.includes(status) ? status : 'pending';
      const r = await query(
        filter === 'all'
          ? `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
              ORDER BY created_at DESC`
          : `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
              WHERE status = $1
              ORDER BY confidence DESC, created_at DESC`,
        filter === 'all' ? [] : [filter],
      );
      return { status: filter, suggestions: r.rows };
    },
  );

  // Confirm a suggestion. Body may override name and frequency. Creates a
  // matching bills or recurring_income row and links via resolved_to_id.
  app.post<{ Params: { id: string } }>(
    '/api/recurring/suggestions/:id/confirm',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const body = (req.body ?? {}) as {
        name?: unknown;
        frequency?: unknown;
        nextDate?: unknown;
      };
      const sugRes = await query<{
        id: string;
        kind: 'bill' | 'income';
        name: string;
        amount_cents: number;
        detected_frequency: DetectedFrequency;
        status: string;
        sample_txn_ids: string[];
      }>(
        `SELECT id, kind, name, amount_cents, detected_frequency, status,
                sample_txn_ids
           FROM recurring_suggestions WHERE id = $1`,
        [req.params.id],
      );
      if (sugRes.rowCount === 0) {
        return reply.code(404).send({ error: 'Suggestion not found' });
      }
      const sug = sugRes.rows[0]!;
      if (sug.status !== 'pending' && sug.status !== 'snoozed') {
        return reply
          .code(409)
          .send({ error: `Suggestion is already ${sug.status}` });
      }

      const finalName =
        typeof body.name === 'string' && body.name.trim() !== ''
          ? body.name.trim()
          : sug.name;
      const incomingFreq =
        typeof body.frequency === 'string'
          ? (body.frequency as DetectedFrequency)
          : sug.detected_frequency;

      // Pick the next due/expected date. Prefer caller-supplied,
      // otherwise derive: most-recent sample date + one cadence step.
      const nextDate =
        typeof body.nextDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(body.nextDate)
          ? body.nextDate
          : await deriveNextDate(sug.sample_txn_ids, incomingFreq);
      if (!nextDate) {
        return reply.code(400).send({
          error:
            'Could not derive a next date from sample transactions — pass nextDate explicitly',
        });
      }

      const targetFreq =
        sug.kind === 'bill'
          ? FREQ_TO_BILL[incomingFreq]
          : FREQ_TO_INCOME[incomingFreq];
      if (!targetFreq) {
        return reply.code(400).send({
          error: `Frequency '${incomingFreq}' is not valid for ${sug.kind}s`,
        });
      }

      const result = await withTransaction(async (client) => {
        let resolvedId: string;
        if (sug.kind === 'bill') {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO bills (name, amount_cents, frequency, next_due_date)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [finalName, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO recurring_income (name, amount_cents, frequency, next_expected_date)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [finalName, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        }
        await client.query(
          `UPDATE recurring_suggestions
              SET status = 'confirmed',
                  resolved_to_id = $1,
                  resolved_at = now()
            WHERE id = $2`,
          [resolvedId, sug.id],
        );
        return { resolvedId };
      });

      const updated = await query(
        `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions WHERE id = $1`,
        [sug.id],
      );
      return {
        suggestion: updated.rows[0],
        resolvedId: result.resolvedId,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/recurring/suggestions/:id/reject',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const r = await query(
        `UPDATE recurring_suggestions
            SET status = 'rejected', resolved_at = now()
          WHERE id = $1 AND status IN ('pending','snoozed')
       RETURNING ${SUGGESTION_COLUMNS}`,
        [req.params.id],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Suggestion not found or not pending' });
      }
      return { suggestion: r.rows[0] };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/recurring/suggestions/:id/snooze',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const r = await query(
        `UPDATE recurring_suggestions
            SET status = 'snoozed', resolved_at = now()
          WHERE id = $1 AND status = 'pending'
       RETURNING ${SUGGESTION_COLUMNS}`,
        [req.params.id],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Suggestion not found or not pending' });
      }
      return { suggestion: r.rows[0] };
    },
  );
}

async function deriveNextDate(
  sampleTxnIds: string[],
  frequency: DetectedFrequency,
): Promise<string | null> {
  if (sampleTxnIds.length === 0) return null;
  const r = await pool.query<{ d: string }>(
    `SELECT to_char(MAX(txn_date), 'YYYY-MM-DD') AS d
       FROM transactions WHERE id = ANY($1::uuid[])`,
    [sampleTxnIds],
  );
  const last = r.rows[0]?.d ?? null;
  if (!last) return null;
  const [y, m, d] = last.split('-').map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  switch (frequency) {
    case 'weekly':
      dt.setUTCDate(dt.getUTCDate() + 7);
      break;
    case 'biweekly':
      dt.setUTCDate(dt.getUTCDate() + 14);
      break;
    case 'semimonthly':
    case 'monthly':
      dt.setUTCMonth(dt.getUTCMonth() + 1);
      break;
    case 'yearly':
      dt.setUTCFullYear(dt.getUTCFullYear() + 1);
      break;
    case 'one-time':
    case 'unknown':
      // Use the last date + 30 days as a placeholder; the caller can edit.
      dt.setUTCDate(dt.getUTCDate() + 30);
      break;
  }
  return dt.toISOString().slice(0, 10);
}
