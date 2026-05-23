import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSuperAdminCookie, makeTestApp, resetDb } from '../setup/test-db.js';

/**
 * SMTP plumbing tests.
 *
 * Real SMTP isn't reachable from the test environment, so these tests
 * exercise the "SMTP not configured" paths only — the contract that
 * matters for the rest of the app: invitations still create, the
 * test-send endpoint reports the reason, and downstream callers can
 * tell sent-vs-unsent from the response.
 *
 * Coverage for the actual send path arrives when (a) a contributor
 * sets up a fake SMTP server in CI, or (b) we vi.mock the mailer
 * module to assert payload shape.
 */

describe('SMTP plumbing (Phase 8.1, super-admin gated 0.9.1)', () => {
  let app: FastifyInstance;
  let superCookie: string;

  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    superCookie = await makeSuperAdminCookie(app);
  });

  it('tenant admin gets 403 on /api/admin/smtp-test', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/smtp-test',
      payload: { to: 'a@b.com' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('POST /api/admin/smtp-test rejects a missing recipient', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/smtp-test',
      payload: {},
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/valid email/);
  });

  it('POST /api/admin/smtp-test returns 400 + reason when SMTP is unconfigured', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/admin/smtp-test',
      payload: { to: 'someone@example.com' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
    const body = r.json();
    expect(body.ok).toBe(false);
    expect(body.stage).toBe('verify');
    expect(body.reason).toMatch(/not configured/i);
  });

  it('creating an invitation without SMTP still succeeds; email.sent is false with a reason', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/invitations`,
      payload: { emailHint: 'invitee@example.com', role: 'spouse' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    const body = r.json();
    expect(body.invitation.token).toBeDefined();
    expect(body.email.sent).toBe(false);
    expect(body.email.reason).toMatch(/SMTP not configured/);
  });

  it('creating an invitation without an emailHint reports the no-hint reason', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const r = await app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/invitations`,
      payload: { role: 'child' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(201);
    expect(r.json().email.sent).toBe(false);
    expect(r.json().email.reason).toMatch(/No email hint/);
  });
});
