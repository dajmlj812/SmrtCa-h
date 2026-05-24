import type { FastifyInstance } from 'fastify';
import { pool, query, withTransaction } from '../db/pool.js';
import { isUuid } from '../util.js';
import { requireTenant } from '../auth/rbac.js';
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

/**
 * 0.14.1 — every recurring route is per-tenant.
 *
 * /detect SELECTs transactions via an accounts join so the detector
 * only sees the caller's data; new `recurring_suggestions` rows carry
 * `tenant_id` so the listing/confirm path can scope by it.
 * /confirm and the bulk path create `bills` / `recurring_income`
 * rows tagged with the caller's `tenant_id`.
 *
 * Pre-0.14.1 a single /detect call would scan every tenant's
 * transactions and surface their merchants as suggestions visible
 * to anyone with a session.
 */
export async function recurringRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/recurring/detect', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
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
    const suggestions = detectRecurring(txns.rows);

    // Per-tenant dedup on existing keys. Other tenants' rows with the
    // same key don't suppress this tenant's suggestions.
    const existing = await pool.query<{ kind: string; normalized_key: string; status: string }>(
      `SELECT kind, normalized_key, status FROM recurring_suggestions
        WHERE tenant_id = $1
          AND status IN ('pending','confirmed','rejected','snoozed')`,
      [tenantId],
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
           (tenant_id, kind, name, normalized_key, amount_cents,
            detected_frequency, sample_txn_ids, confidence)
         VALUES ($1, $2, $3, $4, $5, $6, $7::uuid[], $8)`,
        [
          tenantId,
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
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const status = (req.query.status ?? 'pending').trim();
      const allowed = ['pending', 'confirmed', 'rejected', 'snoozed', 'all'];
      const filter = allowed.includes(status) ? status : 'pending';
      const r = await query(
        filter === 'all'
          ? `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
              WHERE tenant_id = $1
              ORDER BY created_at DESC`
          : `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
              WHERE tenant_id = $1 AND status = $2
              ORDER BY confidence DESC, created_at DESC`,
        filter === 'all' ? [tenantId] : [tenantId, filter],
      );
      return { status: filter, suggestions: r.rows };
    },
  );

  // Confirm a suggestion. Body may override name and frequency. Creates a
  // matching bills or recurring_income row (tagged with this tenant) and
  // links via resolved_to_id.
  app.post<{ Params: { id: string } }>(
    '/api/recurring/suggestions/:id/confirm',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
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
           FROM recurring_suggestions WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
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

      const nextDate =
        typeof body.nextDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(body.nextDate)
          ? body.nextDate
          : await deriveNextDate(tenantId, sug.sample_txn_ids, incomingFreq);
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
            `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, finalName, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO recurring_income (tenant_id, name, amount_cents, frequency, next_expected_date)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, finalName, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        }
        await client.query(
          `UPDATE recurring_suggestions
              SET status = 'confirmed',
                  resolved_to_id = $1,
                  resolved_at = now()
            WHERE id = $2 AND tenant_id = $3`,
          [resolvedId, sug.id, tenantId],
        );
        return { resolvedId };
      });

      const updated = await query(
        `SELECT ${SUGGESTION_COLUMNS} FROM recurring_suggestions
          WHERE id = $1 AND tenant_id = $2`,
        [sug.id, tenantId],
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
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const r = await query(
        `UPDATE recurring_suggestions
            SET status = 'rejected', resolved_at = now()
          WHERE id = $1 AND tenant_id = $2
            AND status IN ('pending','snoozed')
       RETURNING ${SUGGESTION_COLUMNS}`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Suggestion not found or not pending' });
      }
      return { suggestion: r.rows[0] };
    },
  );

  app.post('/api/recurring/suggestions/bulk', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const body = (req.body ?? {}) as { ids?: unknown; action?: unknown };
    if (!Array.isArray(body.ids) || body.ids.length === 0) {
      return reply.code(400).send({ error: 'ids must be a non-empty array' });
    }
    const action = body.action;
    if (action !== 'confirm' && action !== 'reject' && action !== 'snooze') {
      return reply
        .code(400)
        .send({ error: "action must be one of 'confirm', 'reject', 'snooze'" });
    }
    const ids: string[] = [];
    for (const id of body.ids) {
      if (typeof id !== 'string' || !isUuid(id)) {
        return reply.code(400).send({ error: `Invalid suggestion id: ${String(id)}` });
      }
      ids.push(id);
    }

    if (action === 'reject' || action === 'snooze') {
      const newStatus = action === 'reject' ? 'rejected' : 'snoozed';
      const r = await query(
        `UPDATE recurring_suggestions
            SET status = $1, resolved_at = now()
          WHERE tenant_id = $2
            AND id = ANY($3::uuid[])
            AND status IN ('pending','snoozed')
       RETURNING id`,
        [newStatus, tenantId, ids],
      );
      return { action, updated: r.rowCount ?? 0 };
    }

    // Confirm path — load each (scoped to tenant) and apply detector defaults.
    const rows = await pool.query<{
      id: string;
      kind: 'bill' | 'income';
      name: string;
      amount_cents: number;
      detected_frequency: DetectedFrequency;
      sample_txn_ids: string[];
      status: string;
    }>(
      `SELECT id, kind, name, amount_cents, detected_frequency,
              sample_txn_ids, status
         FROM recurring_suggestions
        WHERE tenant_id = $1
          AND id = ANY($2::uuid[])`,
      [tenantId, ids],
    );

    let confirmed = 0;
    const skipped: Array<{ id: string; reason: string }> = [];
    for (const sug of rows.rows) {
      if (sug.status !== 'pending' && sug.status !== 'snoozed') {
        skipped.push({ id: sug.id, reason: `already ${sug.status}` });
        continue;
      }
      const freqMap =
        sug.kind === 'bill' ? FREQ_TO_BILL : FREQ_TO_INCOME;
      const targetFreq = freqMap[sug.detected_frequency];
      if (!targetFreq) {
        skipped.push({
          id: sug.id,
          reason: `frequency '${sug.detected_frequency}' invalid for ${sug.kind}`,
        });
        continue;
      }
      const nextDate = await deriveNextDate(tenantId, sug.sample_txn_ids, sug.detected_frequency);
      if (!nextDate) {
        skipped.push({ id: sug.id, reason: 'could not derive next date' });
        continue;
      }
      await withTransaction(async (client) => {
        let resolvedId: string;
        if (sug.kind === 'bill') {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, sug.name, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        } else {
          const ins = await client.query<{ id: string }>(
            `INSERT INTO recurring_income (tenant_id, name, amount_cents, frequency, next_expected_date)
             VALUES ($1, $2, $3, $4, $5) RETURNING id`,
            [tenantId, sug.name, sug.amount_cents, targetFreq, nextDate],
          );
          resolvedId = ins.rows[0]!.id;
        }
        await client.query(
          `UPDATE recurring_suggestions
              SET status = 'confirmed', resolved_to_id = $1, resolved_at = now()
            WHERE id = $2 AND tenant_id = $3`,
          [resolvedId, sug.id, tenantId],
        );
      });
      confirmed++;
    }
    return { action: 'confirm', confirmed, skipped };
  });

  app.post<{ Params: { id: string } }>(
    '/api/recurring/suggestions/:id/snooze',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid suggestion id' });
      }
      const r = await query(
        `UPDATE recurring_suggestions
            SET status = 'snoozed', resolved_at = now()
          WHERE id = $1 AND tenant_id = $2 AND status = 'pending'
       RETURNING ${SUGGESTION_COLUMNS}`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Suggestion not found or not pending' });
      }
      return { suggestion: r.rows[0] };
    },
  );
}

/**
 * Tenant-scoped: only sample txn ids that actually belong to this
 * tenant contribute to the derived next-date. A suggestion smuggled
 * in with another tenant's sample_txn_ids would silently return null
 * (caller falls back to the 400 path).
 */
async function deriveNextDate(
  tenantId: string,
  sampleTxnIds: string[],
  frequency: DetectedFrequency,
): Promise<string | null> {
  if (sampleTxnIds.length === 0) return null;
  const r = await pool.query<{ d: string }>(
    `SELECT to_char(MAX(t.txn_date), 'YYYY-MM-DD') AS d
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1 AND t.id = ANY($2::uuid[])`,
    [tenantId, sampleTxnIds],
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
      dt.setUTCDate(dt.getUTCDate() + 30);
      break;
  }
  return dt.toISOString().slice(0, 10);
}
