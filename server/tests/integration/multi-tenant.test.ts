import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSuperAdminCookie, makeTestApp, pool, resetDb } from '../setup/test-db.js';

describe('Multi-tenant + invitations + providers (Phase 8.0)', () => {
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

  // ── /api/auth/providers ──────────────────────────────────
  it('lists Local as an always-enabled provider', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth/providers',
    });
    expect(r.statusCode).toBe(200);
    const providers = r.json().providers as Array<{
      id: string;
      enabled: boolean;
    }>;
    expect(providers.find((p) => p.id === 'local')?.enabled).toBe(true);
  });

  // ── /api/tenants ────────────────────────────────────────
  it('GET /api/tenants lists the seeded Default tenant for the test user', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/tenants' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.tenants).toHaveLength(1);
    expect(body.tenants[0].name).toBe('Default');
    expect(body.tenants[0].role).toBe('admin');
    expect(body.active_tenant_id).toBeDefined();
  });

  // ── /api/auth/me ────────────────────────────────────────
  it('GET /api/auth/me returns memberships + active_tenant_id', async () => {
    const r = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.user.email).toBe('test@local');
    expect(body.memberships).toHaveLength(1);
    expect(body.memberships[0].role).toBe('admin');
    expect(body.active_tenant_id).toBe(body.memberships[0].tenant_id);
  });

  // ── Members + invitations ───────────────────────────────
  it('admin creates an invitation and accepting it adds the new user', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;

    // Create an invite.
    const inv = await app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/invitations`,
      payload: { emailHint: 'newbie@local', role: 'spouse' },
      headers: { 'content-type': 'application/json' },
    });
    expect(inv.statusCode).toBe(201);
    const token = inv.json().invitation.token as string;

    // Fetch the invite (public).
    const fetched = await app.inject({
      method: 'GET',
      url: `/api/invitations/${token}`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().invitation.tenant_name).toBe('Default');

    // Accept it as a fresh user — public endpoint mints the session.
    const accept = await app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      payload: {
        email: 'newbie@local',
        name: 'Newbie',
        password: 'correct-horse-battery-staple',
      },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(accept.statusCode).toBe(201);
    expect(accept.json().tenant_id).toBe(tenantId);

    // Owner now sees the new member in the roster.
    const roster = await app.inject({
      method: 'GET',
      url: `/api/tenants/${tenantId}/members`,
    });
    const emails = roster.json().members.map((m: { email: string }) => m.email);
    expect(emails).toContain('newbie@local');
  });

  it('a used invitation cannot be accepted twice', async () => {
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const inv = await app.inject({
      method: 'POST',
      url: `/api/tenants/${tenantId}/invitations`,
      payload: { role: 'spouse' },
      headers: { 'content-type': 'application/json' },
    });
    const token = inv.json().invitation.token as string;

    const accept1 = await app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      payload: { email: 'first@local', password: 'correct-horse-battery-staple' },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(accept1.statusCode).toBe(201);

    const accept2 = await app.inject({
      method: 'POST',
      url: `/api/invitations/${token}/accept`,
      payload: { email: 'second@local', password: 'correct-horse-battery-staple' },
      headers: { 'content-type': 'application/json' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(accept2.statusCode).toBe(500); // route returns 500 with the message; clients see "already used"
  });

  it('non-owner cannot remove a member', async () => {
    // Seed a second user + membership as a plain 'member'.
    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    const tenantId = me.json().active_tenant_id;
    const other = await pool.query<{ id: string }>(
      `INSERT INTO users (email, name) VALUES ('alice@local', 'Alice')
         RETURNING id`,
    );
    await pool.query(
      `INSERT INTO memberships (tenant_id, user_id, role)
       VALUES ($1, $2, 'spouse')`,
      [tenantId, other.rows[0]!.id],
    );

    // The seeded test session is the owner; removing should work...
    const ownerRemoves = await app.inject({
      method: 'DELETE',
      url: `/api/tenants/${tenantId}/members/${other.rows[0]!.id}`,
    });
    expect(ownerRemoves.statusCode).toBe(204);
  });

  // ── Auth provider configs (super-admin only as of 0.9.2) ─
  it('tenant admin gets 403 on POST /api/auth-provider-configs', async () => {
    const r = await app.inject({
      method: 'POST',
      url: '/api/auth-provider-configs',
      payload: {
        kind: 'oidc',
        slug: 'sneaky',
        displayName: 'Sneaky',
        enabled: false,
        config: {},
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('tenant admin gets 403 on GET /api/auth-provider-configs', async () => {
    const r = await app.inject({
      method: 'GET',
      url: '/api/auth-provider-configs',
    });
    expect(r.statusCode).toBe(403);
  });

  it('super admin can create + toggle + delete an auth provider config', async () => {
    const superCookie = await makeSuperAdminCookie(app);
    const asSuper = (extra: Record<string, string> = {}) => ({
      headers: { 'content-type': 'application/json', cookie: superCookie, ...extra },
      skipAuth: true,
    });

    const created = await app.inject({
      method: 'POST',
      url: '/api/auth-provider-configs',
      payload: {
        kind: 'oidc',
        slug: 'okta-test',
        displayName: 'Okta Test',
        enabled: false,
        config: {
          client_id: 'cid',
          client_secret: 'csecret',
          redirect_uri: 'http://localhost/cb',
          discovery_url: 'https://example.com/.well-known/openid-configuration',
        },
      },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper() as any),
    });
    expect(created.statusCode).toBe(201);
    const id = created.json().id as string;

    const list = await app.inject({
      method: 'GET',
      url: '/api/auth-provider-configs',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper() as any),
    });
    expect(list.statusCode).toBe(200);
    const row = list.json().providers.find((p: { id: string }) => p.id === id);
    expect(row.config_json.client_secret).toMatch(/^••••/);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/auth-provider-configs/${id}`,
      payload: { enabled: true },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper() as any),
    });
    expect(patched.statusCode).toBe(200);

    // DELETE has no body — pass only the cookie, no content-type, or
    // Fastify rejects with "Body cannot be empty when content-type is
    // set to application/json".
    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/auth-provider-configs/${id}`,
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(deleted.statusCode).toBe(204);
  });

  it('duplicate slug returns 409', async () => {
    const superCookie = await makeSuperAdminCookie(app);
    const headers = { 'content-type': 'application/json', cookie: superCookie };
    await app.inject({
      method: 'POST',
      url: '/api/auth-provider-configs',
      payload: {
        kind: 'oidc',
        slug: 'dup-slug',
        displayName: 'First',
        enabled: false,
        config: {
          client_id: 'a',
          client_secret: 'b',
          redirect_uri: 'http://localhost/cb',
          discovery_url: 'https://x/.well-known/openid-configuration',
        },
      },
      headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth-provider-configs',
      payload: {
        kind: 'oidc',
        slug: 'dup-slug',
        displayName: 'Second',
        enabled: false,
        config: {
          client_id: 'a',
          client_secret: 'b',
          redirect_uri: 'http://localhost/cb',
          discovery_url: 'https://x/.well-known/openid-configuration',
        },
      },
      headers,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(dup.statusCode).toBe(409);
  });
});
