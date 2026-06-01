import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { exportTenantData } from '../../src/domain/portability.js';

/**
 * 0.13.0 — data-portability tooling.
 *
 * Drives `exportTenantData()` against seeded data, untars the
 * result, and asserts the manifest + every table is present with
 * the expected counts. Also exercises the route's admin gate and
 * tenant isolation.
 */

const exec = promisify(execFile);

async function tenantId(): Promise<string> {
  const r = await pool.query<{ id: string }>(
    `SELECT id FROM tenants WHERE slug = 'default' LIMIT 1`,
  );
  return r.rows[0]!.id;
}

interface Manifest {
  schema_version: number;
  smrtcash_version: string;
  exported_at: string;
  tenant_id: string;
  counts: Record<string, number>;
}

async function untarAndReadManifest(
  archivePath: string,
): Promise<{ manifest: Manifest; bundle: Record<string, unknown> }> {
  const extractDir = await mkdtemp(join(tmpdir(), 'smrtcash-test-extract-'));
  // --force-local: don't treat the Windows drive-letter colon as a
  // remote-shell host:path (matches the production tar call sites).
  await exec('tar', ['--force-local', '-xzf', archivePath, '-C', extractDir]);
  const inner = (await import('node:fs/promises'))
    .readdir(extractDir)
    .then((entries) => entries[0]);
  const innerName = (await inner) as string;
  const jsonPath = join(extractDir, innerName, 'tenant.json');
  const text = await readFile(jsonPath, 'utf-8');
  const parsed = JSON.parse(text) as { manifest: Manifest } & Record<string, unknown>;
  await rm(extractDir, { recursive: true, force: true });
  return { manifest: parsed.manifest, bundle: parsed };
}

describe('Data portability export (0.13.0)', () => {
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

  it('produces a tar.gz with manifest + all tenant tables', async () => {
    const accountId = await seedAccount({ name: 'Bundle Checking' });
    const tid = await tenantId();
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-01', -1500, 'Test merchant', 'port-hash-1')`,
      [accountId],
    );
    await pool.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'Portability Test')`,
      [tid],
    );

    const result = await exportTenantData(tid);
    try {
      expect(result.bytes).toBeGreaterThan(0);
      expect(result.counts.accounts).toBeGreaterThanOrEqual(1);
      expect(result.counts.transactions).toBeGreaterThanOrEqual(1);
      expect(result.counts.categories).toBeGreaterThanOrEqual(1);

      const { manifest, bundle } = await untarAndReadManifest(result.archivePath);
      expect(manifest.tenant_id).toBe(tid);
      expect(manifest.schema_version).toBe(1);
      expect(manifest.smrtcash_version).toBe('0.13.0');
      // Spot-check that every expected table is in the bundle as
      // either an array (rows) or the tenant object.
      const expectedTables = [
        'accounts', 'transactions', 'categories', 'budgets',
        'savings_goals', 'bills', 'recurring_income', 'holdings',
        'vehicles', 'commute_routes', 'retirement_projections',
        'ofx_dc_connections', 'plaid_items', 'plaid_account_links',
        'normalization_rules', 'split_participants', 'transaction_shares',
        'attachments',
      ];
      for (const t of expectedTables) {
        expect(Array.isArray(bundle[t])).toBe(true);
      }
      expect(bundle.tenant).not.toBeNull();
      expect((bundle.tenant as { id: string }).id).toBe(tid);
    } finally {
      await result.cleanup();
    }
  });

  it('strips encrypted credential blobs from ofx_dc_connections and plaid_items', async () => {
    const accountId = await seedAccount();
    const tid = await tenantId();
    const { encryptString } = await import('../../src/domain/crypto.js');
    await pool.query(
      `INSERT INTO ofx_dc_connections
         (tenant_id, account_id, name, ofx_url, ofx_org, ofx_fid, ofx_app_id,
          ofx_app_version, username_encrypted, password_encrypted,
          bank_acct_id, bank_acct_type)
       VALUES ($1, $2, 'Bank', 'https://x.bank/ofx', 'Org', '1001', 'QWIN',
               '2700', $3, $4, '1234', 'CHECKING')`,
      [tid, accountId, encryptString('u'), encryptString('p')],
    );
    await pool.query(
      `INSERT INTO plaid_items
         (tenant_id, plaid_item_id, access_token_encrypted)
       VALUES ($1, 'plaid-item-A', $2)`,
      [tid, encryptString('access-token-very-secret')],
    );

    const result = await exportTenantData(tid);
    try {
      const { bundle } = await untarAndReadManifest(result.archivePath);
      const conn = (bundle.ofx_dc_connections as Array<Record<string, unknown>>)[0]!;
      expect('username_encrypted' in conn).toBe(false);
      expect('password_encrypted' in conn).toBe(false);

      const item = (bundle.plaid_items as Array<Record<string, unknown>>)[0]!;
      expect('access_token_encrypted' in item).toBe(false);
    } finally {
      await result.cleanup();
    }
  });

  it('does NOT include rows from other tenants', async () => {
    const tid = await tenantId();
    // Seed an account + txn in the default tenant…
    const ours = await seedAccount({ name: 'Ours' });
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-01', -100, 'OUR TX', 'p-iso-ours')`,
      [ours],
    );
    // …and another account + txn in a different tenant.
    const other = await pool.query<{ id: string }>(
      `INSERT INTO tenants (name, slug) VALUES ('Other', 'other') RETURNING id`,
    );
    const otherAcct = await pool.query<{ id: string }>(
      `INSERT INTO accounts (tenant_id, name, type, institution)
       VALUES ($1, 'Other', 'checking', 'Bank') RETURNING id`,
      [other.rows[0]!.id],
    );
    await pool.query(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-01', -9999, 'OTHER TX', 'p-iso-other')`,
      [otherAcct.rows[0]!.id],
    );

    const result = await exportTenantData(tid);
    try {
      const { bundle } = await untarAndReadManifest(result.archivePath);
      const txns = bundle.transactions as Array<{ raw_description: string }>;
      expect(txns.map((t) => t.raw_description)).toContain('OUR TX');
      expect(txns.map((t) => t.raw_description)).not.toContain('OTHER TX');
    } finally {
      await result.cleanup();
    }
  });

  it('records an audit log entry when the route is hit', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/portability/export',
    });
    expect(r.statusCode).toBe(200);
    const audit = await pool.query(
      `SELECT details FROM audit_log WHERE action = 'portability.export'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('returns 403 for a non-admin role (spouse)', async () => {
    await pool.query(
      `UPDATE memberships SET role = 'spouse'
        WHERE user_id = '11111111-1111-1111-1111-111111111111'`,
    );
    const r = await app.inject({
      method: 'GET',
      url: '/api/portability/export',
    });
    expect(r.statusCode).toBe(403);
  });

  it('serves the archive with the expected headers', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/portability/export',
    });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toBe('application/gzip');
    expect(String(r.headers['content-disposition'])).toContain('attachment;');
    // 0.21.7 — the user-facing download uses the single-file
    // ".smrtcash" extension (still a gzipped tar under the hood).
    expect(String(r.headers['content-disposition'])).toMatch(/\.smrtcash/);
    expect(typeof r.headers['x-smrtcash-counts']).toBe('string');
    const counts = JSON.parse(String(r.headers['x-smrtcash-counts']));
    expect(counts).toHaveProperty('accounts');
  });

  it('bundles attachment files into the archive', async () => {
    const accountId = await seedAccount();
    const tid = await tenantId();
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-01', -100, 'Coffee', 'p-att-1') RETURNING id`,
      [accountId],
    );
    // Drop a fake file on disk and register it as an attachment.
    const tmpFile = join(tmpdir(), `port-fake-${Date.now()}.txt`);
    await writeFile(tmpFile, 'hello world', 'utf-8');
    await pool.query(
      `INSERT INTO attachments
         (transaction_id, filename, mime_type, byte_size, storage_path,
          encryption_version, tenant_id)
       VALUES ($1, 'note.txt', 'text/plain', 11, $2, 0, $3)`,
      [txn.rows[0]!.id, tmpFile, tid],
    );

    const result = await exportTenantData(tid);
    try {
      expect(result.counts.attachments).toBe(1);
      // Untar and verify the file is present.
      const extractDir = await mkdtemp(join(tmpdir(), 'smrtcash-test-att-'));
      // Relative archive name + cwd to avoid the GNU-tar colon issue on
      // Windows hosts; no --force-local (Alpine BusyBox tar rejects it).
      await exec('tar', ['-xzf', basename(result.archivePath), '-C', extractDir], {
        cwd: dirname(result.archivePath),
      });
      const { readdir } = await import('node:fs/promises');
      const inner = (await readdir(extractDir))[0]!;
      const attsDir = join(extractDir, inner, 'attachments');
      const files = await readdir(attsDir);
      expect(files.length).toBe(1);
      const body = await readFile(join(attsDir, files[0]!), 'utf-8');
      expect(body).toBe('hello world');
      await rm(extractDir, { recursive: true, force: true });
    } finally {
      await result.cleanup();
      if (existsSync(tmpFile)) await rm(tmpFile);
    }
  });
});
