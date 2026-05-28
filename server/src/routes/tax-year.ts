import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { pool } from '../db/pool.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';
import {
  SCHEDULE_C_LINES,
  matchScheduleCLine,
  buildTxf,
  type TxfEntry,
} from '../domain/tax-schedule-c.js';
import { mileageRatesForYear } from './mileage.js';

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

interface ScheduleCRow {
  line: string;
  label: string;
  kind: 'income' | 'expense';
  total_cents: number;
  txn_count: number;
  contributing_tax_categories: string[];
}

interface ScheduleCReport {
  year: number;
  start_date: string;
  end_date: string;
  lines: ScheduleCRow[];
  unmatched: Array<{
    tax_category: string;
    total_cents: number;
    txn_count: number;
  }>;
  mileage: {
    business_miles: number;
    business_deduction_cents: number;
    rate_cents_per_mile: number;
  };
  total_gross_receipts_cents: number;
  total_expenses_cents: number;
  net_profit_cents: number;
}

async function buildScheduleC(
  tenantId: string,
  year: number,
): Promise<ScheduleCReport> {
  const startDate = `${year}-01-01`;
  const endDate = `${year}-12-31`;
  // Pull (tax_category, total_cents, txn_count) — same shape as
  // buildTaxYear but without the per-category-name breakdown.
  const rows = await pool.query<{
    tax_category: string;
    total_cents: string;
    txn_count: number;
  }>(
    `SELECT c.tax_category,
            SUM(t.amount_cents)::bigint AS total_cents,
            COUNT(*)::int AS txn_count
       FROM transactions t
       JOIN accounts a ON a.id = t.account_id
       JOIN categories c ON c.id = t.category_id
      WHERE a.tenant_id = $1
        AND c.tax_category IS NOT NULL
        AND t.txn_date BETWEEN $2::date AND $3::date
        AND t.transfer_group_id IS NULL
      GROUP BY c.tax_category`,
    [tenantId, startDate, endDate],
  );

  const byLine = new Map<
    string,
    {
      line: string;
      label: string;
      kind: 'income' | 'expense';
      total_cents: number;
      txn_count: number;
      contributing: Set<string>;
    }
  >();
  // Seed every line with zero so the report always shows the full
  // Schedule C skeleton (helps users see what they're missing).
  for (const l of SCHEDULE_C_LINES) {
    byLine.set(l.line, {
      line: l.line,
      label: l.label,
      kind: l.kind,
      total_cents: 0,
      txn_count: 0,
      contributing: new Set<string>(),
    });
  }

  const unmatched: ScheduleCReport['unmatched'] = [];
  for (const r of rows.rows) {
    const cents = Number(r.total_cents);
    const match = matchScheduleCLine(r.tax_category);
    if (!match) {
      unmatched.push({
        tax_category: r.tax_category,
        total_cents: cents,
        txn_count: r.txn_count,
      });
      continue;
    }
    const bucket = byLine.get(match.line)!;
    bucket.total_cents += cents;
    bucket.txn_count += r.txn_count;
    bucket.contributing.add(r.tax_category);
  }

  // Pull mileage summary for the year and add the business-mile
  // deduction to line 9 (Car and truck expenses).
  const mileageRow = await pool.query<{ miles: string }>(
    `SELECT COALESCE(SUM(miles), 0)::numeric AS miles
       FROM mileage_log
      WHERE tenant_id = $1
        AND purpose = 'business'
        AND trip_date BETWEEN $2::date AND $3::date`,
    [tenantId, startDate, endDate],
  );
  const businessMiles = Number(mileageRow.rows[0]?.miles ?? 0);
  const rate = (await mileageRatesForYear(year, tenantId)).business;
  const mileageDeductionCents = Math.round(businessMiles * rate);
  const line9 = byLine.get('9');
  if (line9) {
    line9.total_cents -= mileageDeductionCents; // expense = negative
    if (mileageDeductionCents > 0) line9.contributing.add('IRS standard mileage (auto)');
  }

  const lines = [...byLine.values()]
    .filter((b) => b.total_cents !== 0 || b.contributing.size > 0)
    .map<ScheduleCRow>((b) => ({
      line: b.line,
      label: b.label,
      kind: b.kind,
      total_cents: b.total_cents,
      txn_count: b.txn_count,
      contributing_tax_categories: [...b.contributing].sort(),
    }))
    .sort((a, b) => a.line.localeCompare(b.line, undefined, { numeric: true }));

  const total_gross_receipts_cents = lines
    .filter((l) => l.kind === 'income')
    .reduce((s, l) => s + l.total_cents, 0);
  const total_expenses_cents = lines
    .filter((l) => l.kind === 'expense')
    .reduce((s, l) => s + Math.abs(l.total_cents), 0);

  return {
    year,
    start_date: startDate,
    end_date: endDate,
    lines,
    unmatched,
    mileage: {
      business_miles: businessMiles,
      business_deduction_cents: mileageDeductionCents,
      rate_cents_per_mile: rate,
    },
    total_gross_receipts_cents,
    total_expenses_cents,
    net_profit_cents: total_gross_receipts_cents - total_expenses_cents,
  };
}

function scheduleCToTxf(report: ScheduleCReport): string {
  const entries: TxfEntry[] = [];
  for (const l of report.lines) {
    if (l.total_cents === 0) continue;
    const line = SCHEDULE_C_LINES.find((x) => x.line === l.line);
    if (!line) continue;
    entries.push({
      txfCode: line.txfCode,
      // TXF wants amounts in dollars with two decimals. Income +,
      // expenses + (the TXF code carries the sign / form direction).
      amount: Math.abs(l.total_cents) / 100,
      description: `Schedule C Line ${l.line} — ${l.label}`,
    });
  }
  return buildTxf(entries);
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

  // 0.21.0 — Schedule C grouping (sole-proprietor tax form view).
  app.get<{ Params: { year: string } }>(
    '/api/reports/tax-year/:year/schedule-c',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.TAX_REPORTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      return await buildScheduleC(tenantId, year);
    },
  );

  // 0.21.0 — TurboTax TXF (v042) export. Currently only contains
  // Schedule C lines; expand as needed.
  app.get<{ Params: { year: string } }>(
    '/api/reports/tax-year/:year.txf',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.TAX_REPORTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      const report = await buildScheduleC(tenantId, year);
      const body = scheduleCToTxf(report);
      reply.header('Content-Type', 'application/x-txf; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="smrtcash-tax-${year}.txf"`,
      );
      return reply.send(body);
    },
  );

  // 0.21.0 — Mileage log CSV export (IRS-acceptable substantiation).
  app.get<{ Params: { year: string } }>(
    '/api/reports/tax-year/:year/mileage.csv',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.TAX_REPORTS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      const year = Number(req.params.year);
      if (!Number.isInteger(year) || year < 1900 || year > 2200) {
        return reply.code(400).send({ error: 'year must be 1900..2200' });
      }
      const r = await pool.query<{
        trip_date: string;
        purpose: string;
        miles: string;
        start_location: string | null;
        end_location: string | null;
        description: string | null;
        vehicle_name: string | null;
      }>(
        `SELECT m.trip_date::text, m.purpose, m.miles::float8 AS miles,
                m.start_location, m.end_location, m.description,
                v.name AS vehicle_name
           FROM mileage_log m
      LEFT JOIN vehicles v ON v.id = m.vehicle_id
          WHERE m.tenant_id = $1
            AND m.trip_date BETWEEN $2::date AND $3::date
          ORDER BY m.trip_date, m.created_at`,
        [tenantId, `${year}-01-01`, `${year}-12-31`],
      );
      const lines: string[] = [];
      lines.push(`Mileage log,${year}`);
      lines.push('Date,Purpose,Miles,Vehicle,Start,End,Notes');
      for (const row of r.rows) {
        lines.push([
          csvCell(row.trip_date),
          csvCell(row.purpose),
          String(row.miles),
          csvCell(row.vehicle_name),
          csvCell(row.start_location),
          csvCell(row.end_location),
          csvCell(row.description),
        ].join(','));
      }
      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header(
        'Content-Disposition',
        `attachment; filename="smrtcash-mileage-${year}.csv"`,
      );
      return reply.send(lines.join('\n'));
    },
  );
}
