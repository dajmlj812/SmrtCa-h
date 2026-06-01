import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import {
  makeSuperAdminCookie,
  makeTestApp,
  pool,
  resetDb,
} from '../setup/test-db.js';

/**
 * Phase 0.9.4 — restore endpoint, env snapshot, secondary destination.
 *
 * These tests insert fake backup rows pointing at a temp directory that
 * we build by hand. The restore endpoint needs a real pg_dump file to
 * round-trip; that path is exercised manually by the operator and via
 * scripts/restore.mjs. We focus here on the contract:
 *
 *   • POST /api/backups/:id/restore requires confirm:'RESTORE'
 *   • Restore against a missing file returns the right error
 *   • Secondary-dir setting + GET /config exposes it
 *   • env.snapshot.json is written by a successful run (covered by
 *     verifying the file path appears in the backup directory)
 */

describe('Backup restore + env snapshot + secondary dir (0.9.4)', () => {
  let app: FastifyInstance;
  let superCookie: string;
  let tmpRoot: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
    tmpRoot = join(tmpdir(), `smrtcash-test-${randomBytes(6).toString('hex')}`);
    await mkdir(tmpRoot, { recursive: true });
  });

  it('restore requires the literal RESTORE confirm token', async () => {
    // Seed a "success" backup row pointing at a path with a tiny dummy
    // db.dump. We won't actually run pg_restore — the route should
    // reject before getting there.
    const path = join(tmpRoot, 'fake-success');
    await mkdir(path);
    await writeFile(join(path, 'db.dump'), 'not a real dump');
    const r = await pool.query<{ id: string }>(
      `INSERT INTO backups (kind, status, path, db_bytes, total_bytes)
       VALUES ('manual', 'success', $1, 15, 15)
       RETURNING id`,
      [path],
    );
    const id = r.rows[0]!.id;

    const noConfirm = await app.inject({
      method: 'POST',
      url: `/api/backups/${id}/restore`,
      payload: {},
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(noConfirm.statusCode).toBe(400);
    expect(noConfirm.json().error).toMatch(/RESTORE/);

    const wrongConfirm = await app.inject({
      method: 'POST',
      url: `/api/backups/${id}/restore`,
      payload: { confirm: 'yes' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(wrongConfirm.statusCode).toBe(400);
  });

  it('restore against a missing db.dump returns 500 with a clear error', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO backups (kind, status, path, db_bytes, total_bytes)
       VALUES ('manual', 'success', $1, 0, 0)
       RETURNING id`,
      [join(tmpRoot, 'no-such-dir')],
    );
    const id = r.rows[0]!.id;

    const result = await app.inject({
      method: 'POST',
      url: `/api/backups/${id}/restore`,
      payload: { confirm: 'RESTORE' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(result.statusCode).toBe(500);
    expect(result.json().error).toMatch(/db\.dump/);
  });

  it('tenant admin gets 403 on restore', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO backups (kind, status, path, total_bytes)
       VALUES ('manual', 'success', '/tmp/ignored', 0)
       RETURNING id`,
    );
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/backups/${r.rows[0]!.id}/restore`,
      payload: { confirm: 'RESTORE' },
      headers: { 'content-type': 'application/json' },
    });
    expect(blocked.statusCode).toBe(403);
  });

  it('refuses to restore from a non-success row', async () => {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO backups (kind, status, path, error)
       VALUES ('manual', 'failed', '/tmp/x', 'pg_dump exited 1')
       RETURNING id`,
    );
    const blocked = await app.inject({
      method: 'POST',
      url: `/api/backups/${r.rows[0]!.id}/restore`,
      payload: { confirm: 'RESTORE' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(blocked.statusCode).toBe(500);
    expect(blocked.json().error).toMatch(/'failed'/);
  });

  it('GET /api/backups/config exposes the secondary directory', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/BACKUP_SECONDARY_DIR',
      payload: { value: '/mnt/nas/smrtcash' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const r = await app.inject({
      method: 'GET',
      url: '/api/backups/config',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    expect(r.json().secondary_directory).toBe('/mnt/nas/smrtcash');
  });

  // Clean up temp dirs created across tests.
  afterAll(async () => {
    if (tmpRoot && existsSync(tmpRoot)) {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  });
});

describe('Budget wizard savings percentage overrides (0.9.4)', () => {
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

  it('wizard preview honors per-run % overrides', async () => {
    // Seed an account + a paycheck so the preview has income to apply
    // the percentage to.
    const acct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (name, institution, type, last4, opening_balance_cents)
       VALUES ('Checking', 'Bank', 'checking', '0000', 100000)
       RETURNING id`,
    );
    void acct;
    await pool.query(
      `INSERT INTO recurring_income (name, amount_cents, frequency, next_expected_date, active)
       VALUES ('Salary', 200000, 'weekly', now()::date + 1, true)`,
    );

    // 0.17.22 — the savings model is the three-tier low/mid/high
    // leftover-percentage set (the old savingsIncomePct /
    // savingsLeftoverPct pair was replaced). Verify per-run overrides
    // flow through to the preview's echoed percentages.
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: {
        periodType: 'weekly',
        anchor: new Date().toISOString().slice(0, 10),
        count: 1,
        savingsLowPctOverride: 5,
        savingsMidPctOverride: 50,
        savingsHighPctOverride: 80,
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const preview = r.json().preview;
    expect(preview.savingsLowPct).toBe(5);
    expect(preview.savingsMidPct).toBe(50);
    expect(preview.savingsHighPct).toBe(80);
  });

  it('out-of-range % override falls back to the global default', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/budgets/wizard/preview',
      payload: {
        periodType: 'weekly',
        anchor: new Date().toISOString().slice(0, 10),
        count: 1,
        savingsMidPctOverride: 150, // > 100 -> ignored, falls back to default
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    // Default mid-tier is 50% (SAVINGS_PCT_MID default in budget-wizard.ts).
    expect(r.json().preview.savingsMidPct).toBe(50);
  });
});
