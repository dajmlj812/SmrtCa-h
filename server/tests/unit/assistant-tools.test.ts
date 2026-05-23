import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount, pool } from '../setup/test-db.js';
import { ASSISTANT_TOOLS, findTool } from '../../src/domain/assistant/tools.js';

/**
 * Phase 9.1 — unit-level tests for each assistant tool.
 *
 * We seed the DB directly and call each tool's execute() in
 * isolation, no AI involved. This is the safety net that catches
 * SQL errors / schema mismatches / missing tenant scoping.
 */

const TEST_USER = '11111111-1111-1111-1111-111111111111';

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
  return r.rows[0]!.id;
}

describe('Assistant tools (0.12.1)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
  });

  it('has unique tool names and well-formed input schemas', () => {
    const names = new Set<string>();
    for (const t of ASSISTANT_TOOLS) {
      expect(names.has(t.name)).toBe(false);
      names.add(t.name);
      expect((t.inputSchema as { type?: string }).type).toBe('object');
      expect(t.description.length).toBeGreaterThan(10);
    }
  });

  it('query_transactions filters by date + description', async () => {
    const tid = await tenantId();
    const accountId = await seedAccount();
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-10', -1234, 'STARBUCKS #123', 'hashA'),
              ($1, '2026-04-15', -2000, 'Whole Foods', 'hashB'),
              ($1, '2026-05-01', -500, 'STARBUCKS #999', 'hashC')`,
      [accountId],
    );

    const t = findTool('query_transactions')!;
    const r = (await t.execute(
      { tenantId: tid, userId: TEST_USER },
      { descriptionContains: 'starbucks' },
    )) as { transactions: Array<{ raw_description: string }>; count: number };
    expect(r.count).toBe(2);
    expect(r.transactions.every((tx) => /STARBUCKS/i.test(tx.raw_description))).toBe(true);
  });

  it('query_transactions respects tenant boundary (no cross-tenant leak)', async () => {
    const tid = await tenantId();
    // Seed an account under a DIFFERENT tenant to make sure tools don't see it.
    const otherTenant = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAccount = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Hidden', 'checking', 'Other Bank') RETURNING id`,
      [otherTenant.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-10', -9999, 'OTHER TENANT TX', 'cross-hash')`,
      [otherAccount.rows[0]!.id],
    );

    const r = (await findTool('query_transactions')!.execute(
      { tenantId: tid, userId: TEST_USER },
      {},
    )) as { transactions: unknown[] };
    expect(r.transactions).toHaveLength(0);
  });

  it('update_transaction_category sets the category and audit-logs', async () => {
    const tid = await tenantId();
    const accountId = await seedAccount();
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-10', -1234, 'STARBUCKS', 'hashU') RETURNING id`,
      [accountId],
    );
    // Use a seeded default category.
    const catName = 'Coffee Shops';
    await pool.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [tid, catName],
    );

    await findTool('update_transaction_category')!.execute(
      { tenantId: tid, userId: TEST_USER },
      { transactionId: txn.rows[0]!.id, categoryName: catName },
    );

    const after = await pool.query<{ category_id: string | null }>(
      `SELECT category_id FROM transactions WHERE id = $1`,
      [txn.rows[0]!.id],
    );
    expect(after.rows[0]!.category_id).not.toBeNull();

    const audit = await pool.query(
      `SELECT action, details FROM audit_log
        WHERE action = 'assistant.update_transaction_category'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('bulk_recategorize caps at 500', async () => {
    const tid = await tenantId();
    const accountId = await seedAccount();
    await pool.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'Groceries') ON CONFLICT DO NOTHING`,
      [tid],
    );
    // Insert 5 matching, ensure update touches them.
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       SELECT $1, '2026-04-10', -1000, 'WHOLE FOODS ' || g, 'bulk-' || g
         FROM generate_series(1, 5) g`,
      [accountId],
    );
    const r = (await findTool('bulk_recategorize')!.execute(
      { tenantId: tid, userId: TEST_USER },
      { descriptionContains: 'whole foods', categoryName: 'Groceries' },
    )) as { updated: number; cap: number };
    expect(r.updated).toBe(5);
    expect(r.cap).toBe(500);

    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE action = 'assistant.bulk_recategorize'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('create_budget rejects non-positive amounts', async () => {
    const tid = await tenantId();
    await pool.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'Dining') ON CONFLICT DO NOTHING`,
      [tid],
    );
    await expect(
      findTool('create_budget')!.execute(
        { tenantId: tid, userId: TEST_USER },
        { categoryName: 'Dining', amountCents: -100 },
      ),
    ).rejects.toThrow(/positive/);
  });

  it('mark_bill_paid advances next_due_date by frequency', async () => {
    const tid = await tenantId();
    const r0 = await pool.query<{ id: string; next_due_date: string }>(
      `INSERT INTO bills (tenant_id, name, amount_cents, frequency, next_due_date)
       VALUES ($1, 'Rent', 100000, 'monthly', '2026-04-01') RETURNING id, next_due_date::text`,
      [tid],
    );
    const billId = r0.rows[0]!.id;
    const out = (await findTool('mark_bill_paid')!.execute(
      { tenantId: tid, userId: TEST_USER },
      { billId },
    )) as { next_due: string };
    expect(out.next_due).toBe('2026-05-01');
  });

  it('update_savings_goal supports delta and absolute set', async () => {
    const tid = await tenantId();
    const g = await pool.query<{ id: string }>(
      `INSERT INTO savings_goals (tenant_id, name, target_amount_cents, current_amount_cents)
       VALUES ($1, 'Vacation', 500000, 1000) RETURNING id`,
      [tid],
    );
    const goalId = g.rows[0]!.id;

    await findTool('update_savings_goal')!.execute(
      { tenantId: tid, userId: TEST_USER },
      { goalId, deltaCents: 5000 },
    );
    const r1 = await pool.query<{ current_amount_cents: number }>(
      `SELECT current_amount_cents FROM savings_goals WHERE id = $1`,
      [goalId],
    );
    expect(Number(r1.rows[0]!.current_amount_cents)).toBe(6000);

    await findTool('update_savings_goal')!.execute(
      { tenantId: tid, userId: TEST_USER },
      { goalId, currentCents: 9999 },
    );
    const r2 = await pool.query<{ current_amount_cents: number }>(
      `SELECT current_amount_cents FROM savings_goals WHERE id = $1`,
      [goalId],
    );
    expect(Number(r2.rows[0]!.current_amount_cents)).toBe(9999);
  });
});
