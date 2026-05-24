import type { FastifyInstance } from 'fastify';
import { pool, query } from '../db/pool.js';
import { isUuid } from '../util.js';
import { computeProjection } from '../domain/projections.js';
import { requireTenant } from '../auth/rbac.js';
import { FEATURES, requireFeature } from '../auth/entitlements.js';

/**
 *   GET    /api/projections                    — list for current tenant
 *   POST   /api/projections                    — create
 *   PATCH  /api/projections/:id                — update
 *   DELETE /api/projections/:id                — remove
 *   GET    /api/projections/:id/series         — compute the year-by-year curve
 *
 * 0.14.4 — closes the NULL-tenant write hatch the audit flagged.
 * Reads still accept `tenant_id IS NULL` so a system-seeded
 * read-only "template" projection (if one exists) shows up for
 * every tenant. But PATCH and DELETE require `tenant_id = $X`
 * exactly — no tenant can clobber or remove the shared template,
 * and no tenant can mutate another tenant's projections.
 */

const COLUMNS = `id, tenant_id, name, starting_balance_cents,
  monthly_contribution_cents, annual_return_pct::float8 AS annual_return_pct,
  annual_inflation_pct::float8 AS annual_inflation_pct,
  target_year, target_amount_cents, horizon_years,
  created_at::text, updated_at::text`;

function asNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export async function projectionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/projections', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.RETIREMENT_PROJECTIONS);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    // Reads still accept the NULL hatch (shared templates).
    const r = await query(
      `SELECT ${COLUMNS} FROM retirement_projections
        WHERE tenant_id = $1 OR tenant_id IS NULL
        ORDER BY created_at`,
      [tenantId],
    );
    return { projections: r.rows };
  });

  app.post('/api/projections', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const denyFeat = await requireFeature(tenantId, FEATURES.RETIREMENT_PROJECTIONS);
    if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
    const body = (req.body ?? {}) as Record<string, unknown>;
    const name = typeof body.name === 'string' ? body.name.trim() : '';
    if (name === '') return reply.code(400).send({ error: 'name required' });
    const startingBalance = asNumber(body.startingBalanceCents);
    const monthly = asNumber(body.monthlyContributionCents);
    const ret = asNumber(body.annualReturnPct);
    if (startingBalance === null || monthly === null || ret === null) {
      return reply.code(400).send({
        error: 'startingBalanceCents, monthlyContributionCents, annualReturnPct required',
      });
    }
    if (monthly < 0) return reply.code(400).send({ error: 'monthly contribution must be >= 0' });
    if (ret < -100 || ret > 100) {
      return reply.code(400).send({ error: 'annualReturnPct must be -100..100' });
    }
    const inflation = asNumber(body.annualInflationPct) ?? 0;
    if (inflation < 0 || inflation > 100) {
      return reply.code(400).send({ error: 'annualInflationPct must be 0..100' });
    }
    const horizon = Math.round(asNumber(body.horizonYears) ?? 30);
    if (horizon <= 0 || horizon > 100) {
      return reply.code(400).send({ error: 'horizonYears must be 1..100' });
    }
    const targetYear =
      typeof body.targetYear === 'number' && Number.isInteger(body.targetYear)
        ? body.targetYear
        : null;
    const targetAmount = asNumber(body.targetAmountCents);
    const r = await query(
      `INSERT INTO retirement_projections
         (tenant_id, name, starting_balance_cents, monthly_contribution_cents,
          annual_return_pct, annual_inflation_pct, target_year,
          target_amount_cents, horizon_years)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING ${COLUMNS}`,
      [
        tenantId,
        name,
        Math.round(startingBalance),
        Math.round(monthly),
        ret,
        inflation,
        targetYear,
        targetAmount ? Math.round(targetAmount) : null,
        horizon,
      ],
    );
    return reply.code(201).send({ projection: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/projections/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.RETIREMENT_PROJECTIONS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid projection id' });
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: unknown[] = [];
      function add(col: string, value: unknown): void {
        params.push(value);
        sets.push(`${col} = $${params.length}`);
      }
      if (typeof body.name === 'string' && body.name.trim() !== '') {
        add('name', body.name.trim());
      }
      const monthly = asNumber(body.monthlyContributionCents);
      if (monthly !== null && monthly >= 0) add('monthly_contribution_cents', Math.round(monthly));
      const ret = asNumber(body.annualReturnPct);
      if (ret !== null && ret >= -100 && ret <= 100) add('annual_return_pct', ret);
      const inflation = asNumber(body.annualInflationPct);
      if (inflation !== null && inflation >= 0 && inflation <= 100)
        add('annual_inflation_pct', inflation);
      if (typeof body.targetYear === 'number' || body.targetYear === null) {
        add('target_year', body.targetYear);
      }
      if (body.targetAmountCents === null) add('target_amount_cents', null);
      else {
        const t = asNumber(body.targetAmountCents);
        if (t !== null && t > 0) add('target_amount_cents', Math.round(t));
      }
      const horizon = asNumber(body.horizonYears);
      if (horizon !== null && horizon > 0 && horizon <= 100) add('horizon_years', Math.round(horizon));
      if (sets.length === 0)
        return reply.code(400).send({ error: 'No fields to update' });
      sets.push(`updated_at = now()`);
      params.push(req.params.id, tenantId);
      // 0.14.4: NULL hatch removed from the write path. A row whose
      // tenant_id IS NULL is read-only across tenants; no tenant can
      // clobber it.
      const r = await query(
        `UPDATE retirement_projections SET ${sets.join(', ')}
          WHERE id = $${params.length - 1}
            AND tenant_id = $${params.length}
       RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Projection not found' });
      return { projection: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/projections/:id',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.RETIREMENT_PROJECTIONS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid projection id' });
      // Same NULL-hatch removal as PATCH — a shared template can be
      // listed by every tenant but deleted by none.
      const r = await query(
        `DELETE FROM retirement_projections
          WHERE id = $1 AND tenant_id = $2`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Projection not found' });
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { id: string } }>(
    '/api/projections/:id/series',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const denyFeat = await requireFeature(tenantId, FEATURES.RETIREMENT_PROJECTIONS);
      if (denyFeat) return reply.code(denyFeat.status).send({ error: denyFeat.error });
      if (!isUuid(req.params.id))
        return reply.code(400).send({ error: 'Invalid projection id' });
      // Series is a read — the NULL hatch is preserved here so a
      // shared template still computes its curve for any tenant.
      const r = await pool.query<{
        starting_balance_cents: number;
        monthly_contribution_cents: number;
        annual_return_pct: number;
        annual_inflation_pct: number;
        horizon_years: number;
        target_year: number | null;
        target_amount_cents: number | null;
        name: string;
      }>(
        `SELECT starting_balance_cents, monthly_contribution_cents,
                annual_return_pct::float8 AS annual_return_pct,
                annual_inflation_pct::float8 AS annual_inflation_pct,
                horizon_years, target_year, target_amount_cents, name
           FROM retirement_projections
          WHERE id = $1 AND (tenant_id = $2 OR tenant_id IS NULL)`,
        [req.params.id, tenantId],
      );
      if (r.rowCount === 0)
        return reply.code(404).send({ error: 'Projection not found' });
      const p = r.rows[0]!;
      const series = computeProjection({
        startingBalanceCents: Number(p.starting_balance_cents),
        monthlyContributionCents: Number(p.monthly_contribution_cents),
        annualReturnPct: Number(p.annual_return_pct),
        annualInflationPct: Number(p.annual_inflation_pct),
        horizonYears: Number(p.horizon_years),
      });
      return {
        name: p.name,
        target_year: p.target_year,
        target_amount_cents: p.target_amount_cents,
        series,
      };
    },
  );
}
