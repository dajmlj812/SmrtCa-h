import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';

/**
 * 0.13.1 — tax categories on categories + year-end report.
 */

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

async function seedTaxCategory(name: string, taxCategory: string): Promise<string> {
  const tid = await tenantId();
  const r = await pool.query<{ id: string }>(
    `INSERT INTO categories (tenant_id, name, tax_category)
     VALUES ($1, $2, $3) RETURNING id`,
    [tid, name, taxCategory],
  );
  return r.rows[0]!.id;
}

describe('Tax category CRUD + year-end report (0.13.1)', () => {
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

  it('PATCH /api/categories/:id sets and clears tax_category', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/categories',
      payload: { name: 'Donations' },
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().category.id as string;

    const set = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${id}`,
      payload: { tax_category: 'Charitable Donations' },
      headers: { 'content-type': 'application/json' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json().category.tax_category).toBe('Charitable Donations');

    const cleared = await app.inject({
      method: 'PATCH',
      url: `/api/categories/${id}`,
      payload: { tax_category: '' },
      headers: { 'content-type': 'application/json' },
    });
    expect(cleared.json().category.tax_category).toBeNull();
  });

  it('returns the suggested vocabulary', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/categories/tax-vocabulary',
    });
    expect(r.statusCode).toBe(200);
    const list = r.json().suggestions as string[];
    expect(list).toContain('Charitable Donations');
    expect(list).toContain('Mortgage Interest');
  });

  it('rejects bad year on the report endpoint', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/tax-year/abc',
    });
    expect(r.statusCode).toBe(400);
  });

  it('aggregates transactions by tax_category for the year', async () => {
    const accountId = await seedAccount();
    const charity = await seedTaxCategory('Goodwill', 'Charitable Donations');
    const medical = await seedTaxCategory('Doctor', 'Medical Expenses');
    const income = await seedTaxCategory('Side Gig', '1099 Income');
    // Untagged category — must NOT appear in the report.
    const groceries = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name)
       VALUES ((SELECT id FROM tenants LIMIT 1), 'TaxTestUntagged') RETURNING id`,
    );

    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES
         ($1, '2026-03-15', -5000, 'Goodwill donation', 'tax-a', $2),
         ($1, '2026-06-20', -2500, 'Salvation Army',    'tax-b', $2),
         ($1, '2026-04-01', -8000, 'Dr. Smith visit',   'tax-c', $3),
         ($1, '2026-07-15', 100000, '1099 payment',     'tax-d', $4),
         ($1, '2026-09-01', -10000, 'Whole Foods',      'tax-e', $5),
         -- Year-boundary guards: Dec 31 of prior year + Jan 1 of next.
         ($1, '2025-12-31', -9999, 'Year prior',        'tax-y0', $2),
         ($1, '2027-01-01', -9999, 'Year after',        'tax-y2', $2)`,
      [accountId, charity, medical, income, groceries.rows[0]!.id],
    );

    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/tax-year/2026',
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.year).toBe(2026);
    expect(body.total_income_cents).toBe(100000);
    expect(body.total_deductible_cents).toBe(-15500); // -5000 + -2500 + -8000
    expect(body.total_txn_count).toBe(4);
    const rows = body.by_tax_category as Array<{
      tax_category: string;
      sign: 'income' | 'deductible';
      total_cents: number;
      contributing_categories: string[];
    }>;
    const charityRow = rows.find(
      (r) => r.tax_category === 'Charitable Donations' && r.sign === 'deductible',
    );
    expect(charityRow).toBeDefined();
    expect(charityRow!.total_cents).toBe(-7500);
    expect(charityRow!.contributing_categories).toEqual(['Goodwill']);
    const incomeRow = rows.find((r) => r.tax_category === '1099 Income');
    expect(incomeRow!.sign).toBe('income');
    expect(incomeRow!.total_cents).toBe(100000);
    // The untagged "TaxTestUntagged" category is invisible to the report.
    expect(
      rows.find((r) => r.contributing_categories.includes('TaxTestUntagged')),
    ).toBeUndefined();
  });

  it('excludes transfer-group transactions from the report', async () => {
    const accountId = await seedAccount();
    const cat = await seedTaxCategory('Investment Income', 'Investment Interest');
    // One real transaction + one with transfer_group_id set.
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-05-01', 1000, 'Real interest',   'tax-r1', $2)`,
      [accountId, cat],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id, transfer_group_id)
       VALUES ($1, '2026-05-02', 99999, 'Inter-account',  'tax-r2', $2, gen_random_uuid())`,
      [accountId, cat],
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/tax-year/2026',
    });
    expect(r.json().total_income_cents).toBe(1000); // transfer excluded
  });

  it('CSV export returns text/csv with the right shape', async () => {
    const accountId = await seedAccount();
    const cat = await seedTaxCategory('Goodwill', 'Charitable Donations');
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-03-15', -5000, 'D', 'tax-csv-1', $2)`,
      [accountId, cat],
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/tax-year/2026.csv',
    });
    expect(r.statusCode).toBe(200);
    expect(String(r.headers['content-type'])).toContain('text/csv');
    expect(String(r.headers['content-disposition'])).toContain(
      'smrtcash-tax-2026.csv',
    );
    expect(r.body).toContain('Tax year,2026');
    expect(r.body).toContain('Charitable Donations,deductible,-5000');
  });

  it('tenant isolation — other tenants do not leak', async () => {
    const tid = await tenantId();
    const ours = await seedAccount();
    const ourCat = await seedTaxCategory('Ours', 'Charitable Donations');
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-04-01', -1000, 'Ours', 'tax-iso-1', $2)`,
      [ours, ourCat],
    );
    // Other tenant.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAcct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Hidden', 'checking', 'Bank') RETURNING id`,
      [other.rows[0]!.id],
    );
    const otherCat = await pool.query<{ id: string }>(
      `INSERT INTO categories (tenant_id, name, tax_category)
       VALUES ($1, 'OtherTax', 'Charitable Donations') RETURNING id`,
      [other.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash, category_id)
       VALUES ($1, '2026-04-01', -99999, 'Other', 'tax-iso-other', $2)`,
      [otherAcct.rows[0]!.id, otherCat.rows[0]!.id],
    );

    const r = await app.inject({
      method: 'GET',
      url: '/api/reports/tax-year/2026',
    });
    const total = (r.json().by_tax_category as Array<{ total_cents: number }>)
      .reduce((a, row) => a + row.total_cents, 0);
    expect(total).toBe(-1000); // only "Ours"; other-tenant's -99999 invisible.
    // Sanity: our tenant id used.
    expect(tid).toBeTruthy();
  });
});
