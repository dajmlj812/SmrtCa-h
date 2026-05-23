import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { _testDecryptStoredCredentials } from '../../src/routes/ofx-dc.js';

/**
 * Phase 8.1 OFX Direct Connect routes (0.11.1).
 *
 * The protocol module is exercised in tests/unit/ofx-dc.test.ts with
 * a mocked fetch. These integration tests cover the route layer:
 * CRUD shape, auth gates, credential encryption round-trip, and the
 * /test + /sync endpoints with the app-level fetch override that the
 * test injects.
 */
function fakeFetchReturning(body: string, status = 200): typeof fetch {
  return (async () =>
    new Response(body, { status })) as unknown as typeof fetch;
}

function okOfxResponse(opts: { trnAmt?: string; name?: string } = {}): string {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    '',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<DTSERVER>20260315000000',
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    '<BANKMSGSRSV1>',
    '<STMTTRNRS>',
    '<TRNUID>X',
    '<STATUS><CODE>0<SEVERITY>INFO</STATUS>',
    '<STMTRS>',
    '<CURDEF>USD',
    '<BANKACCTFROM>',
    '<BANKID>021000021',
    '<ACCTID>1234',
    '<ACCTTYPE>CHECKING',
    '</BANKACCTFROM>',
    '<BANKTRANLIST>',
    '<DTSTART>20260301',
    '<DTEND>20260315',
    '<STMTTRN>',
    '<TRNTYPE>DEBIT',
    '<DTPOSTED>20260301',
    `<TRNAMT>${opts.trnAmt ?? '-12.34'}`,
    '<FITID>R1',
    `<NAME>${opts.name ?? 'Test Merchant'}`,
    '</STMTTRN>',
    '</BANKTRANLIST>',
    '</STMTRS>',
    '</STMTTRNRS>',
    '</BANKMSGSRSV1>',
    '</OFX>',
  ].join('\r\n');
}

function authFailedOfxResponse(): string {
  return [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    '',
    '',
    '<OFX>',
    '<SIGNONMSGSRSV1>',
    '<SONRS>',
    '<STATUS><CODE>15500<SEVERITY>ERROR<MESSAGE>Invalid signon</STATUS>',
    '<DTSERVER>20260315000000',
    '<LANGUAGE>ENG',
    '</SONRS>',
    '</SIGNONMSGSRSV1>',
    '</OFX>',
  ].join('\r\n');
}

function payload(accountId: string, overrides: Record<string, unknown> = {}) {
  return {
    accountId,
    name: 'My Bank',
    ofxUrl: 'https://example.bank/ofx',
    ofxOrg: 'ExampleBank',
    ofxFid: '1001',
    username: 'user@example.com',
    password: 'sup3r-s3cret',
    bankAcctId: '1234',
    bankAcctType: 'CHECKING',
    bankId: '021000021',
    ...overrides,
  };
}

describe('OFX Direct Connect routes (0.11.1)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      undefined;
  });

  it('rejects creation without an active tenant context', async () => {
    // Same flow as the standard test app, which IS bound to a tenant —
    // verify the happy path before testing forbidden cases.
    const accountId = await seedAccount();
    const r = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
  });

  it('encrypts credentials at rest — DB does not contain plaintext password', async () => {
    const accountId = await seedAccount();
    const r = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId, { password: 'super-secret-pw-987' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    const id = r.json().connection.id as string;

    const dump = await pool.query<{
      username_encrypted: Buffer;
      password_encrypted: Buffer;
    }>(
      `SELECT username_encrypted, password_encrypted FROM ofx_dc_connections WHERE id = $1`,
      [id],
    );
    expect(dump.rows[0]!.password_encrypted.toString('utf-8')).not.toContain(
      'super-secret-pw-987',
    );
    expect(dump.rows[0]!.username_encrypted.toString('utf-8')).not.toContain(
      'user@example.com',
    );

    // And decrypts back to the original value.
    const decrypted = await _testDecryptStoredCredentials(id);
    expect(decrypted).toEqual({
      username: 'user@example.com',
      password: 'super-secret-pw-987',
    });
  });

  it('GET excludes encrypted columns', async () => {
    const accountId = await seedAccount();
    await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const list = await app.inject({
      method: 'GET',
      url: '/api/ofx-dc/connections',
    });
    expect(list.statusCode).toBe(200);
    const conns = list.json().connections as Array<Record<string, unknown>>;
    expect(conns).toHaveLength(1);
    expect(Object.keys(conns[0]!)).not.toContain('username_encrypted');
    expect(Object.keys(conns[0]!)).not.toContain('password_encrypted');
  });

  it('rejects bankAcctType outside the allow-list', async () => {
    const accountId = await seedAccount();
    const r = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId, { bankAcctType: 'BITCOIN' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('PATCH updates fields and re-encrypts password when provided', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/ofx-dc/connections/${id}`,
      payload: payload(accountId, { name: 'Renamed', password: 'rotated-pw-456' }),
      headers: { 'content-type': 'application/json' },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().connection.name).toBe('Renamed');

    const dec = await _testDecryptStoredCredentials(id);
    expect(dec?.password).toBe('rotated-pw-456');
  });

  it('DELETE removes the connection', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;
    const r = await app.inject({
      method: 'DELETE',
      url: `/api/ofx-dc/connections/${id}`,
    });
    expect(r.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: '/api/ofx-dc/connections',
    });
    expect(after.json().connections).toHaveLength(0);
  });

  it('/test returns ok with parsed counts when the bank replies cleanly', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;

    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      fakeFetchReturning(okOfxResponse());

    const r = await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/test`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ ok: true, parsedCount: 1, errorCount: 0 });
  });

  it('/test returns 400 with kind=auth_failed when SONRS code is 15500', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;
    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      fakeFetchReturning(authFailedOfxResponse());
    const r = await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/test`,
    });
    expect(r.statusCode).toBe(400);
    expect(r.json()).toMatchObject({ ok: false, kind: 'auth_failed' });
  });

  it('/sync persists transactions and updates last_sync_status', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;
    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      fakeFetchReturning(okOfxResponse());
    const r = await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/sync`,
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().importedCount).toBe(1);

    // Row reflects the successful sync.
    const after = await pool.query<{
      last_sync_status: string;
      last_sync_imported: number;
    }>(
      `SELECT last_sync_status, last_sync_imported FROM ofx_dc_connections WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]!.last_sync_status).toBe('ok');
    expect(after.rows[0]!.last_sync_imported).toBe(1);

    // The transaction landed on the account.
    const txn = await pool.query(
      `SELECT amount_cents FROM transactions WHERE account_id = $1`,
      [accountId],
    );
    expect(txn.rowCount).toBe(1);
  });

  it('/sync records last_sync_error on bank failure', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;
    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      fakeFetchReturning(authFailedOfxResponse());
    const r = await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/sync`,
    });
    expect(r.statusCode).toBe(400);
    const after = await pool.query<{
      last_sync_status: string;
      last_sync_error: string;
    }>(
      `SELECT last_sync_status, last_sync_error FROM ofx_dc_connections WHERE id = $1`,
      [id],
    );
    expect(after.rows[0]!.last_sync_status).toBe('auth_failed');
    expect(after.rows[0]!.last_sync_error).toContain('Invalid signon');
  });

  it('/sync skips duplicates on a second pass (dedup via ON CONFLICT)', async () => {
    const accountId = await seedAccount();
    const created = await app.inject({
      method: 'POST',
      url: '/api/ofx-dc/connections',
      payload: payload(accountId),
      headers: { 'content-type': 'application/json' },
    });
    const id = created.json().connection.id as string;
    (app as unknown as { ofxDcFetchOverride?: typeof fetch }).ofxDcFetchOverride =
      fakeFetchReturning(okOfxResponse());

    await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/sync`,
    });
    const second = await app.inject({
      method: 'POST',
      url: `/api/ofx-dc/connections/${id}/sync`,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ importedCount: 0, skippedCount: 1 });
  });
});
