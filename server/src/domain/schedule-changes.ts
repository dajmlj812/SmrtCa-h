import { pool, withTransaction } from '../db/pool.js';

/**
 * 0.18.13 — schedule future-effective changes for bills + recurring
 * income. See migration 056_recurring_schedule_changes.sql for the
 * underlying table.
 *
 * The model is read-time. The parent row (bill or recurring_income)
 * keeps its current amount/frequency. Future changes live in the
 * `recurring_schedule_changes` table with an effective_date. When
 * the date passes, `promoteDueChanges()` updates the parent row and
 * marks the change applied — that promotion is idempotent and safe
 * to call repeatedly.
 *
 * Projections (cash-flow forecast, budget wizard) can either:
 *   • call promoteDueChanges() first and then read the parent rows
 *     (simplest — what the existing routes do), or
 *   • use effectiveAmountAt(item, date) to look up the right value
 *     for a future date without mutating the parent (used by the
 *     forecast projection when looking weeks ahead).
 */

type Frequency = 'monthly' | 'weekly' | 'biweekly' | 'yearly' | 'one-time';

const VALID_FREQUENCIES: Frequency[] = [
  'monthly',
  'weekly',
  'biweekly',
  'yearly',
  'one-time',
];

const YMD = /^\d{4}-\d{2}-\d{2}$/;

export interface ScheduleChange {
  id: string;
  tenant_id: string;
  bill_id: string | null;
  income_id: string | null;
  effective_date: string;
  new_amount_cents: number | null;
  new_frequency: Frequency | null;
  note: string | null;
  applied_at: string | null;
  created_at: string;
  created_by: string | null;
}

export interface ScheduleChangeInput {
  effective_date: string;
  new_amount_cents?: number | null;
  new_frequency?: Frequency | null;
  note?: string | null;
}

const COLUMNS = `id, tenant_id, bill_id, income_id,
  effective_date::text AS effective_date,
  new_amount_cents, new_frequency, note,
  applied_at::text AS applied_at,
  created_at::text AS created_at, created_by`;

export class ScheduleChangeError extends Error {}

function validate(input: ScheduleChangeInput): void {
  if (!YMD.test(input.effective_date)) {
    throw new ScheduleChangeError('effective_date must be YYYY-MM-DD');
  }
  if (input.new_amount_cents == null && input.new_frequency == null) {
    throw new ScheduleChangeError(
      'At least one of new_amount_cents or new_frequency must be set',
    );
  }
  if (input.new_amount_cents != null) {
    if (
      !Number.isInteger(input.new_amount_cents) ||
      input.new_amount_cents <= 0
    ) {
      throw new ScheduleChangeError(
        'new_amount_cents must be a positive integer',
      );
    }
  }
  if (input.new_frequency != null) {
    if (!VALID_FREQUENCIES.includes(input.new_frequency)) {
      throw new ScheduleChangeError(
        `new_frequency must be one of: ${VALID_FREQUENCIES.join(', ')}`,
      );
    }
  }
}

export async function listForBill(
  tenantId: string,
  billId: string,
  opts: { includeApplied?: boolean } = {},
): Promise<ScheduleChange[]> {
  const where = opts.includeApplied
    ? ''
    : 'AND applied_at IS NULL';
  const r = await pool.query<ScheduleChange>(
    `SELECT ${COLUMNS} FROM recurring_schedule_changes
      WHERE tenant_id = $1 AND bill_id = $2 ${where}
      ORDER BY effective_date ASC, created_at ASC`,
    [tenantId, billId],
  );
  return r.rows;
}

export async function listForIncome(
  tenantId: string,
  incomeId: string,
  opts: { includeApplied?: boolean } = {},
): Promise<ScheduleChange[]> {
  const where = opts.includeApplied
    ? ''
    : 'AND applied_at IS NULL';
  const r = await pool.query<ScheduleChange>(
    `SELECT ${COLUMNS} FROM recurring_schedule_changes
      WHERE tenant_id = $1 AND income_id = $2 ${where}
      ORDER BY effective_date ASC, created_at ASC`,
    [tenantId, incomeId],
  );
  return r.rows;
}

export async function addForBill(
  tenantId: string,
  billId: string,
  input: ScheduleChangeInput,
  createdBy: string,
): Promise<ScheduleChange> {
  validate(input);
  const r = await pool.query<ScheduleChange>(
    `INSERT INTO recurring_schedule_changes
       (tenant_id, bill_id, effective_date,
        new_amount_cents, new_frequency, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      tenantId,
      billId,
      input.effective_date,
      input.new_amount_cents ?? null,
      input.new_frequency ?? null,
      input.note ?? null,
      createdBy,
    ],
  );
  return r.rows[0]!;
}

export async function addForIncome(
  tenantId: string,
  incomeId: string,
  input: ScheduleChangeInput,
  createdBy: string,
): Promise<ScheduleChange> {
  validate(input);
  // Recurring income doesn't support 'one-time' — silently drop it
  // here would surprise the caller, so we validate and reject.
  if (input.new_frequency === 'one-time') {
    throw new ScheduleChangeError(
      "recurring income doesn't support frequency=one-time",
    );
  }
  const r = await pool.query<ScheduleChange>(
    `INSERT INTO recurring_schedule_changes
       (tenant_id, income_id, effective_date,
        new_amount_cents, new_frequency, note, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [
      tenantId,
      incomeId,
      input.effective_date,
      input.new_amount_cents ?? null,
      input.new_frequency ?? null,
      input.note ?? null,
      createdBy,
    ],
  );
  return r.rows[0]!;
}

export async function deleteChange(
  tenantId: string,
  changeId: string,
): Promise<boolean> {
  const r = await pool.query(
    `DELETE FROM recurring_schedule_changes
       WHERE tenant_id = $1 AND id = $2 AND applied_at IS NULL`,
    [tenantId, changeId],
  );
  return (r.rowCount ?? 0) > 0;
}

/**
 * Promote any unapplied changes whose effective_date has arrived.
 * Updates the parent bill/income row's amount + frequency and marks
 * the change applied. Idempotent — safe to call from multiple paths.
 *
 * Returns the IDs of changes that were applied this call.
 */
export async function promoteDueChanges(tenantId: string): Promise<{
  applied: string[];
}> {
  return await withTransaction(async (client) => {
    // Lock the candidate rows so a parallel caller doesn't double-apply.
    const due = await client.query<{
      id: string;
      bill_id: string | null;
      income_id: string | null;
      new_amount_cents: number | null;
      new_frequency: Frequency | null;
    }>(
      `SELECT id, bill_id, income_id, new_amount_cents, new_frequency
         FROM recurring_schedule_changes
        WHERE tenant_id = $1
          AND applied_at IS NULL
          AND effective_date <= CURRENT_DATE
        ORDER BY effective_date ASC, created_at ASC
        FOR UPDATE SKIP LOCKED`,
      [tenantId],
    );
    const applied: string[] = [];
    for (const row of due.rows) {
      // Build the UPDATE dynamically — change only the fields that
      // are non-null on the change row.
      if (row.bill_id !== null) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (row.new_amount_cents !== null) {
          params.push(row.new_amount_cents);
          sets.push(`amount_cents = $${params.length}`);
        }
        if (row.new_frequency !== null) {
          params.push(row.new_frequency);
          sets.push(`frequency = $${params.length}`);
        }
        if (sets.length === 0) continue;
        params.push(row.bill_id, tenantId);
        await client.query(
          `UPDATE bills SET ${sets.join(', ')}
            WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
          params,
        );
      } else if (row.income_id !== null) {
        const sets: string[] = [];
        const params: unknown[] = [];
        if (row.new_amount_cents !== null) {
          params.push(row.new_amount_cents);
          sets.push(`amount_cents = $${params.length}`);
        }
        if (row.new_frequency !== null) {
          params.push(row.new_frequency);
          sets.push(`frequency = $${params.length}`);
        }
        if (sets.length === 0) continue;
        params.push(row.income_id, tenantId);
        await client.query(
          `UPDATE recurring_income SET ${sets.join(', ')}
            WHERE id = $${params.length - 1} AND tenant_id = $${params.length}`,
          params,
        );
      }
      await client.query(
        `UPDATE recurring_schedule_changes SET applied_at = now() WHERE id = $1`,
        [row.id],
      );
      applied.push(row.id);
    }
    return { applied };
  });
}

/**
 * Look up the effective amount + frequency for a bill/income on a
 * given future date, considering scheduled changes. Used by the
 * cash-flow forecast (which projects weeks ahead) without mutating
 * the parent row.
 *
 * Returns null when the lookup target doesn't exist in this tenant.
 */
export async function effectiveValuesAt(
  tenantId: string,
  target: { kind: 'bill' | 'income'; id: string },
  date: string,
): Promise<{ amount_cents: number; frequency: Frequency } | null> {
  if (!YMD.test(date)) {
    throw new ScheduleChangeError('date must be YYYY-MM-DD');
  }
  // Latest applicable change at-or-before the target date.
  const sql =
    target.kind === 'bill'
      ? `WITH base AS (
           SELECT amount_cents, frequency
             FROM bills WHERE id = $1 AND tenant_id = $2
         ),
         change AS (
           SELECT new_amount_cents, new_frequency
             FROM recurring_schedule_changes
            WHERE tenant_id = $2 AND bill_id = $1
              AND effective_date <= $3::date
            ORDER BY effective_date DESC, created_at DESC LIMIT 1
         )
         SELECT
           COALESCE((SELECT new_amount_cents FROM change), (SELECT amount_cents FROM base)) AS amount_cents,
           COALESCE((SELECT new_frequency    FROM change), (SELECT frequency    FROM base)) AS frequency`
      : `WITH base AS (
           SELECT amount_cents, frequency
             FROM recurring_income WHERE id = $1 AND tenant_id = $2
         ),
         change AS (
           SELECT new_amount_cents, new_frequency
             FROM recurring_schedule_changes
            WHERE tenant_id = $2 AND income_id = $1
              AND effective_date <= $3::date
            ORDER BY effective_date DESC, created_at DESC LIMIT 1
         )
         SELECT
           COALESCE((SELECT new_amount_cents FROM change), (SELECT amount_cents FROM base)) AS amount_cents,
           COALESCE((SELECT new_frequency    FROM change), (SELECT frequency    FROM base)) AS frequency`;
  const r = await pool.query<{ amount_cents: number; frequency: Frequency }>(
    sql,
    [target.id, tenantId, date],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  if (row.amount_cents == null) return null; // parent row doesn't exist
  return row;
}
