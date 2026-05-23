import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { scanTransactionsForAnomalies } from '../../src/domain/anomaly-detector.js';
import { setDbValue } from '../../src/domain/settings.js';

/**
 * 0.13.2 — anomaly detection / alerts.
 */

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

async function enableAnomalies(opts: { thresholdCents?: number; multiplier?: number } = {}) {
  await setDbValue('ANOMALY_ENABLED', 'true');
  await setDbValue(
    'ANOMALY_LARGE_TXN_THRESHOLD_CENTS',
    String(opts.thresholdCents ?? 50_000),
  );
  await setDbValue('ANOMALY_MULTIPLIER', String(opts.multiplier ?? 3));
}

async function insertTxn(
  accountId: string,
  date: string,
  amountCents: number,
  desc: string,
  dedup: string,
): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, normalized_merchant, dedup_hash)
     VALUES ($1, $2, $3, $4, $4, $5) RETURNING id`,
    [accountId, date, amountCents, desc, dedup],
  );
  return r.rows[0]!.id;
}

describe('Anomaly detection (0.13.2)', () => {
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

  it('is a no-op when ANOMALY_ENABLED=false', async () => {
    const tid = await tenantId();
    const accountId = await seedAccount();
    await insertTxn(accountId, '2026-05-01', -200000, 'BIG', 'a-off-1');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.enabled).toBe(false);
    expect(r.newAlerts).toBe(0);
  });

  it('detects large_amount transactions over the threshold', async () => {
    await enableAnomalies({ thresholdCents: 50_000 });
    const tid = await tenantId();
    const accountId = await seedAccount();
    await insertTxn(accountId, '2026-05-01', -75_000, 'Big charge', 'a-big-1');
    await insertTxn(accountId, '2026-05-02', -10_000, 'Normal', 'a-norm-1');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.byKind.large_amount).toBe(1);
    expect(r.byKind.unusual_at_merchant ?? 0).toBe(0);
  });

  it('does NOT double-alert on a re-scan', async () => {
    await enableAnomalies({ thresholdCents: 50_000 });
    const tid = await tenantId();
    const accountId = await seedAccount();
    await insertTxn(accountId, '2026-05-01', -75_000, 'Big charge', 'a-rescan-1');
    const r1 = await scanTransactionsForAnomalies(tid);
    expect(r1.newAlerts).toBe(1);
    const r2 = await scanTransactionsForAnomalies(tid);
    expect(r2.newAlerts).toBe(0);
  });

  it('flags unusual_at_merchant when amount >= multiplier × median', async () => {
    await enableAnomalies({ thresholdCents: 1_000_000, multiplier: 3 });
    const tid = await tenantId();
    const accountId = await seedAccount();
    // Five $5 Starbucks txns establish a median; the sixth is 10x.
    for (let i = 0; i < 5; i++) {
      await insertTxn(accountId, '2026-04-0' + (i + 1), -500, 'Starbucks', `a-sb-${i}`);
    }
    await insertTxn(accountId, '2026-05-10', -5000, 'Starbucks', 'a-sb-outlier');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.byKind.unusual_at_merchant).toBe(1);
  });

  it('does NOT fire unusual_at_merchant when sample is too small (<5)', async () => {
    await enableAnomalies({ thresholdCents: 1_000_000, multiplier: 3 });
    const tid = await tenantId();
    const accountId = await seedAccount();
    // Only 4 baseline txns → no median fires.
    for (let i = 0; i < 4; i++) {
      await insertTxn(accountId, '2026-04-0' + (i + 1), -500, 'NewVendor', `a-nv-${i}`);
    }
    await insertTxn(accountId, '2026-05-10', -5000, 'NewVendor', 'a-nv-outlier');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.byKind.unusual_at_merchant ?? 0).toBe(0);
  });

  it('flags duplicate_suspect for same amount + merchant within 24h', async () => {
    await enableAnomalies({ thresholdCents: 1_000_000 });
    const tid = await tenantId();
    const accountId = await seedAccount();
    // Two identical $25 charges to "BigBox" on the same day.
    await insertTxn(accountId, '2026-05-10', -2500, 'BigBox', 'a-dup-1');
    await new Promise((r) => setTimeout(r, 20));
    await insertTxn(accountId, '2026-05-10', -2500, 'BigBox', 'a-dup-2');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.byKind.duplicate_suspect).toBe(1);
  });

  it('tenant isolation — other tenants do not get scanned', async () => {
    await enableAnomalies({ thresholdCents: 50_000 });
    const tid = await tenantId();
    const other = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAcct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Other', 'checking', 'Bank') RETURNING id`,
      [other.rows[0]!.id],
    );
    await insertTxn(otherAcct.rows[0]!.id, '2026-05-01', -100_000, 'Other big', 'a-iso-1');
    const r = await scanTransactionsForAnomalies(tid);
    expect(r.newAlerts).toBe(0);
    // Confirm a scan ON the other tenant DOES see it.
    const r2 = await scanTransactionsForAnomalies(other.rows[0]!.id);
    expect(r2.newAlerts).toBe(1);
  });

  it('GET /api/anomalies + dismiss roundtrip', async () => {
    await enableAnomalies({ thresholdCents: 50_000 });
    const accountId = await seedAccount();
    await insertTxn(accountId, '2026-05-01', -75_000, 'Big', 'a-rt-1');
    const scan = await app.inject({
      method: 'POST',
      url: '/api/anomalies/scan',
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().newAlerts).toBe(1);

    const list = await app.inject({
      method: 'GET',
      url: '/api/anomalies',
    });
    expect(list.json().anomalies).toHaveLength(1);
    const id = list.json().anomalies[0].id as string;

    const dismiss = await app.inject({
      method: 'POST',
      url: `/api/anomalies/${id}/dismiss`,
      payload: { dismissed: true },
      headers: { 'content-type': 'application/json' },
    });
    expect(dismiss.json().anomaly.dismissed).toBe(true);

    // Default GET filters out dismissed; with the flag they reappear.
    const openAfter = await app.inject({
      method: 'GET',
      url: '/api/anomalies',
    });
    expect(openAfter.json().anomalies).toHaveLength(0);
    const all = await app.inject({
      method: 'GET',
      url: '/api/anomalies?includeDismissed=1',
    });
    expect(all.json().anomalies).toHaveLength(1);
  });

  it('count endpoint returns open anomalies for the nav badge', async () => {
    await enableAnomalies({ thresholdCents: 50_000 });
    const accountId = await seedAccount();
    await insertTxn(accountId, '2026-05-01', -75_000, 'A', 'a-c1');
    await insertTxn(accountId, '2026-05-02', -90_000, 'B', 'a-c2');
    await app.inject({ method: 'POST', url: '/api/anomalies/scan' });
    const c = await app.inject({ method: 'GET', url: '/api/anomalies/count' });
    expect(c.json().open).toBe(2);
  });
});
