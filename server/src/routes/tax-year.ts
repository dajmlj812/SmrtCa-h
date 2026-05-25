import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';

/**
 * Backlog (0.13.1) — year-end tax report.
 *
 *   GET /api/reports/tax-year/:year       JSON
 *   GET /api/reports/tax-year/:year.csv   CSV download
 *
 * Aggregates transactions whose category has a tax_category set,
 * over Jan 1 - Dec 31 of the requested year. Tenant-scoped via
 * accounts.tenant_id.
 *
 * Sign convention: amounts in the report are signed exactly like
 * transactions (negative = outflow / deductible spending; positive =
 * income). The UI flips signs for display.
 *
 * Transfers are excluded — transferring money between own accounts
 * isn't a tax event.
 */

interface TaxYearJson {
  year: number;
  start_date: string;
  end_date: string;
  total_income_cents: number;
  total_deductible_cents: number;
  total_txn_count: number;
  by_tax_category: Array<{
    tax_category: string;
    sign: 'income' | 'deductible';
    total_cents: number;
    txn_count: number;
    contributing_categories: string[];
  }>;
}

function requireTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return null;
  }
  if (!req.user.tenantId) {
    reply.code(403).send({ error: 'No active tenant' });
    return null;
  }
  return req.user.tenantId;
}

interface RawRow {
  tax_category: string;
  category_name: string;
  total_cents: string;
  txn_count: number;
}

async function buildTaxYear(
  tenantId: string,
  year: number,
): Promise<TaxYearJson> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  const rows = await pool.query<RawRow>(
    `SELECT c.tax_category, c.name AS category_name,
            SUM(t.amount_cents)::bigint AS total_cents,
            COUNT(*)::int AS txn_count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id
      WHERE a.tenant_id = $1
        AND c.tax_category IS NOT NULL
        AND t.txn_date BETWEEN $2::date AND $3::date
        AND t.transfer_group_id IS NULL
      GROUP BY c.tax_category, c.name
      ORDER BY c.tax_category, c.name`,
    [tenantId, startDate, endDate],
  );

  // Roll up to the (tax_category, sign) granularity. A tax_category
  // can in principle have both inflows and outflows (e.g. a refund
  // category that mostly debits but occasionally credits), so we
  // split by sign for clarity.
  const buckets = new Map<
    string,
    {
      tax_category: string;
      sign: 'income' | 'deductible';
      total_cents: number;
      txn_count: number;
      contributing_categories: Set<string>;
    }
  >();

  let totalIncome = 0;
  let totalDeductible = 0;
  let totalTxnCount = 0;

  for (const r of rows.rows) {
    const total = Number(r.total_cents);
    const sign: 'income' | 'deductible' = total >= 0 ? 'income' : 'deductible';
    const key = `${r.tax_category}::${sign}`;
    const bucket = buckets.get(key) ?? {
      tax_category: r.tax_category,
      sign,
      total_cents: 0,
      txn_count: 0,
      contributing_categories: new Set<string>(),
    };
    bucket.total_cents += total;
    bucket.txn_count += r.txn_count;
    bucket.contributing_categories.add(r.category_name);
    buckets.set(key, bucket);
    totalTxnCount += r.txn_count;
    if (total >= 0) totalIncome += total;
    else totalDeductible += total;
  }

  const by_tax_category = [...buckets.values()]
    .map((b) => ({
      tax_category: b.tax_category,
      sign: b.sign,
      total_cents: b.total_cents,
      txn_count: b.txn_count,
      contributing_categories: [...b.contributing_categories].sort(),
    }))
    .sort((a, b) => {
      // Income blocks first, then deductible, alpha within each.
      if (a.sign !== b.sign) return a.sign === 'income' ? -1 : 1;
      return a.tax_category.localeCompare(b.tax_category);
    });

  return {
    year,
    start_date: startDate,
    end_date: endDate,
    total_income_cents: totalIncome,
    total_deductible_cents: totalDeductible,
    total_txn_count: totalTxnCount,
    by_tax_category,
  };
}

function csvCell(v: unknown): string {
  let s = String(v ?? '');
  // F-22 — neutralize spreadsheet formula triggers. Refined to allow
  // signed numbers (-40.00, +1.5) through unmodified — see
  // routes/transactions.ts for the shared rationale.
  if (s.length > 0) {
    const first = s.charCodeAt(0);
    let dangerous = first === 0x3d || first === 0x40 || first === 0x09 || first === 0x0d;
    if (!dangerous && (first === 0x2d || first === 0x2b) && s.length > 1) {
      const second = s.charCodeAt(1);
      const secondIsDigit = second >= 0x30 && second <= 0x39;
      const secondIsDot = second === 0x2e;
      dangerous = !(secondIsDigit || secondIsDot);
    }
    if (dangerous) s = `'${s}`;
  }
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function reportAsCsv(report: TaxYearJson): string {
  const lines: string[] = [];
  lines.push(`Tax year,${report.year}`);
  lines.push(`Date range,${report.start_date} to ${report.end_date}`);
  lines.push(`Total income (cents),${report.total_income_cents}`);
  lines.push(`Total deductible (cents),${report.total_deductible_cents}`);
  lines.push(`Total transaction count,${report.total_txn_count}`);
  lines.push('');
  lines.push(
    'Tax category,Sign,Total cents,Txn count,Contributing categories',
  );
  for (const row of report.by_tax_category) {
    lines.push(
      [
        csvCell(row.tax_category),
        csvCell(row.sign),
        String(row.total_cents),
        String(row.txn_count),
        csvCell(row.contributing_categories.join('; ')),
      ].join(','),
    );
  }
  return lines.join('\n');
}

export async function taxYearRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Params: { year: string } }>(
    '/api/reports/tax-year/:year',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.TAX_REPORTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      return await buildTaxYear(tenantId, year);
    },
  );

  app.get<{ Params: { year: string } }>(
    '/api/reports/tax-year/:year.csv',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.TAX_REPORTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      const report = await buildTaxYear(tenantId, year);
      const body = reportAsCsv(report);
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="smrtcash-tax-${year}.csv"`,
      );
      return reply.send(body);
    },
  );
}
