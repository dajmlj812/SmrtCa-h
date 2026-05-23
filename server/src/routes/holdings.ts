import type { FastifyInstance } from 'fastify';
import { query } from '../db/pool.js';
import { isUuid } from '../util.js';

const COLUMNS = `id, account_id, symbol, name, asset_type,
  quantity::float8 AS quantity,
  cost_basis_cents, last_price_cents, last_price_date, created_at`;

const VALID_ASSET_TYPES = new Set([
  'stock', 'etf', 'mutual_fund', 'bond',
  'crypto', 'commodity', 'other',
]);

function asAssetType(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim().toLowerCase();
  return VALID_ASSET_TYPES.has(s) ? s : null;
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}
function asPositiveNumeric(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}
function asNonNegativeInt(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isInteger(n) || n < 0) return null;
  return n;
}
function isYmdOrNull(value: unknown): value is string | null {
  if (value === null) return true;
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

async function assertInvestmentAccount(
  accountId: string,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const r = await query<{ type: string }>(
    `SELECT type FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (r.rowCount === 0) {
    return { ok: false, status: 404, error: 'Account not found' };
  }
  if (r.rows[0]!.type !== 'investment') {
    return {
      ok: false,
      status: 400,
      error: `Holdings can only be added to investment accounts (got ${r.rows[0]!.type})`,
    };
  }
  return { ok: true };
}

/**
 * Holdings on investment accounts. Manual entry only in 7.0 — auto
 * price-fetching is a future hook. Holdings contribute their market
 * value (quantity × last_price_cents) to the parent investment
 * account's reported balance.
 */
export async function holdingRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { accountId?: string } }>(
    '/api/holdings',
    async (req, reply) => {
      const accountId = req.query.accountId?.trim() || null;
      if (accountId && !isUuid(accountId)) {
        return reply.code(400).send({ error: 'Invalid accountId' });
      }
      const rows = accountId
        ? await query(
            `SELECT ${COLUMNS},
                    (quantity * last_price_cents)::bigint AS market_value_cents,
                    (quantity * last_price_cents)::bigint - cost_basis_cents
                       AS unrealized_gain_cents
               FROM holdings WHERE account_id = $1
              ORDER BY symbol NULLS LAST, name`,
            [accountId],
          )
        : await query(
            `SELECT ${COLUMNS},
                    (quantity * last_price_cents)::bigint AS market_value_cents,
                    (quantity * last_price_cents)::bigint - cost_basis_cents
                       AS unrealized_gain_cents
               FROM holdings
              ORDER BY symbol NULLS LAST, name`,
          );
      return { holdings: rows.rows };
    },
  );

  app.post('/api/holdings', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, unknown>;
    if (typeof body.accountId !== 'string' || !isUuid(body.accountId)) {
      return reply.code(400).send({ error: 'Invalid accountId' });
    }
    const check = await assertInvestmentAccount(body.accountId);
    if (check.ok === false) {
      return reply.code(check.status).send({ error: check.error });
    }
    const name = asString(body.name);
    if (name === '') {
      return reply.code(400).send({ error: 'name is required' });
    }
    const symbol = body.symbol === undefined || body.symbol === null
      ? null
      : asString(body.symbol).toUpperCase() || null;
    const quantity = asPositiveNumeric(body.quantity);
    if (quantity === null) {
      return reply.code(400).send({ error: 'quantity must be > 0' });
    }
    const costBasis = body.costBasisCents === undefined
      ? 0
      : asNonNegativeInt(body.costBasisCents);
    if (costBasis === null) {
      return reply.code(400).send({ error: 'costBasisCents must be ≥ 0' });
    }
    const lastPrice = body.lastPriceCents === undefined
      ? 0
      : asNonNegativeInt(body.lastPriceCents);
    if (lastPrice === null) {
      return reply.code(400).send({ error: 'lastPriceCents must be ≥ 0' });
    }
    if (body.lastPriceDate !== undefined && !isYmdOrNull(body.lastPriceDate)) {
      return reply.code(400).send({ error: 'lastPriceDate must be YYYY-MM-DD or null' });
    }
    const assetType = body.assetType === undefined
      ? 'stock'
      : asAssetType(body.assetType);
    if (assetType === null) {
      return reply
        .code(400)
        .send({ error: `assetType must be one of: ${[...VALID_ASSET_TYPES].join(', ')}` });
    }
    const r = await query(
      `INSERT INTO holdings
         (account_id, symbol, name, asset_type, quantity, cost_basis_cents,
          last_price_cents, last_price_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${COLUMNS}`,
      [
        body.accountId,
        symbol,
        name,
        assetType,
        quantity,
        costBasis,
        lastPrice,
        (body.lastPriceDate as string | null) ?? null,
      ],
    );
    return reply.code(201).send({ holding: r.rows[0] });
  });

  app.patch<{ Params: { id: string } }>(
    '/api/holdings/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid holding id' });
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (body.name !== undefined) {
        const n = asString(body.name);
        if (n === '') return reply.code(400).send({ error: 'name cannot be empty' });
        params.push(n);
        sets.push(`name = $${params.length}`);
      }
      if (body.symbol !== undefined) {
        params.push(body.symbol === null ? null : asString(body.symbol).toUpperCase() || null);
        sets.push(`symbol = $${params.length}`);
      }
      if (body.quantity !== undefined) {
        const q = asPositiveNumeric(body.quantity);
        if (q === null) return reply.code(400).send({ error: 'quantity must be > 0' });
        params.push(q);
        sets.push(`quantity = $${params.length}`);
      }
      if (body.costBasisCents !== undefined) {
        const c = asNonNegativeInt(body.costBasisCents);
        if (c === null) return reply.code(400).send({ error: 'costBasisCents must be ≥ 0' });
        params.push(c);
        sets.push(`cost_basis_cents = $${params.length}`);
      }
      if (body.lastPriceCents !== undefined) {
        const p = asNonNegativeInt(body.lastPriceCents);
        if (p === null) return reply.code(400).send({ error: 'lastPriceCents must be ≥ 0' });
        params.push(p);
        sets.push(`last_price_cents = $${params.length}`);
      }
      if (body.lastPriceDate !== undefined) {
        if (!isYmdOrNull(body.lastPriceDate)) {
          return reply.code(400).send({ error: 'lastPriceDate must be YYYY-MM-DD or null' });
        }
        params.push(body.lastPriceDate);
        sets.push(`last_price_date = $${params.length}`);
      }
      if (body.assetType !== undefined) {
        const t = asAssetType(body.assetType);
        if (t === null) {
          return reply
            .code(400)
            .send({ error: `assetType must be one of: ${[...VALID_ASSET_TYPES].join(', ')}` });
        }
        params.push(t);
        sets.push(`asset_type = $${params.length}`);
      }
      if (sets.length === 0) {
        return reply.code(400).send({ error: 'No updates' });
      }
      params.push(req.params.id);
      const r = await query(
        `UPDATE holdings SET ${sets.join(', ')}
          WHERE id = $${params.length}
       RETURNING ${COLUMNS}`,
        params,
      );
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Holding not found' });
      }
      return { holding: r.rows[0] };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/api/holdings/:id',
    async (req, reply) => {
      if (!isUuid(req.params.id)) {
        return reply.code(400).send({ error: 'Invalid holding id' });
      }
      const r = await query(`DELETE FROM holdings WHERE id = $1`, [req.params.id]);
      if (r.rowCount === 0) {
        return reply.code(404).send({ error: 'Holding not found' });
      }
      return reply.code(204).send();
    },
  );

  // 0.13.3 — Refresh all crypto holdings' last_price_cents from the
  // configured price provider. Tenant-scoped. Admin + spouse only.
  app.post('/api/holdings/refresh-prices/crypto', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    if (!req.user.tenantId)
      return reply.code(403).send({ error: 'No active tenant' });
    const { loadUserContext, requireFinancialMutation } = await import(
      '../auth/rbac.js'
    );
    const ctx = await loadUserContext(req.user.id, req.user.tenantId);
    const denied = requireFinancialMutation(ctx);
    if (denied) return reply.code(denied.status).send({ error: denied.error });

    const { getEffectiveValue } = await import('../domain/settings.js');
    const provider = ((await getEffectiveValue('CRYPTO_PRICE_PROVIDER')) || 'coingecko')
      .trim()
      .toLowerCase();
    if (provider === 'manual') {
      return reply.code(400).send({
        error: 'CRYPTO_PRICE_PROVIDER is set to manual; auto-refresh is disabled',
      });
    }

    const rows = await query<{ id: string; symbol: string | null }>(
      `SELECT h.id, h.symbol
         FROM holdings h
         JOIN accounts a ON a.id = h.account_id
        WHERE a.tenant_id = $1 AND h.asset_type = 'crypto' AND h.symbol IS NOT NULL`,
      [req.user.tenantId],
    );
    if (rows.rowCount === 0) {
      return { updated: 0, unknown: [], symbols: [] };
    }

    const { fetchCryptoPrices, CryptoPriceError } = await import(
      '../domain/crypto-prices.js'
    );
    const symbols = rows.rows
      .map((r) => r.symbol!)
      .filter((s, i, arr) => arr.indexOf(s) === i);

    // Test injection: `app.cryptoFetchOverride` overrides the global fetch.
    const fetchImpl = (app as unknown as { cryptoFetchOverride?: typeof fetch })
      .cryptoFetchOverride;

    let priceResult;
    try {
      priceResult = await fetchCryptoPrices({
        symbols,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
    } catch (err) {
      if (err instanceof CryptoPriceError) {
        return reply.code(400).send({ error: err.message, kind: err.kind });
      }
      throw err;
    }

    const today = new Date().toISOString().slice(0, 10);
    let updated = 0;
    for (const row of rows.rows) {
      if (!row.symbol) continue;
      const cents = priceResult.prices[row.symbol.toUpperCase()];
      if (typeof cents !== 'number') continue;
      const u = await query(
        `UPDATE holdings
            SET last_price_cents = $2, last_price_date = $3
          WHERE id = $1`,
        [row.id, cents, today],
      );
      updated += u.rowCount ?? 0;
    }
    return {
      updated,
      symbols,
      unknown: priceResult.unknown,
      fetched_at: priceResult.fetchedAt,
    };
  });
}
