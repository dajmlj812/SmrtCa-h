import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeSuperAdminCookie, makeTestApp, resetDb } from '../setup/test-db.js';
import { config } from '../../src/config.js';

// SMTP, BACKUP_*, SESSION_SECRET, ATTACHMENT_ENCRYPTION_KEY, APP_BASE_URL
// are super-only as of 0.9.1. Tests that touch those keys build a
// super-admin session and pass it explicitly.
function asSuper(cookie: string) {
  return { headers: { cookie }, skipAuth: true };
}

describe('Settings API', () => {
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

  it('tenant-admin GET returns an empty list; super-admin GET sees every key', async () => {
    // 0.9.3: ALL settings are now super-only (AI + EIA joined SMTP +
    // BACKUP_* + security keys). Tenant admin gets an empty page.
    const tenantR = await app.inject({ method: 'GET', url: '/api/settings' });
    expect(tenantR.statusCode).toBe(200);
    expect(tenantR.json().settings).toEqual([]);

    const superR = await app.inject({
      method: 'GET',
      url: '/api/settings',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const superKeys = superR.json().settings.map((s: { key: string }) => s.key);
    expect(superKeys).toContain('AI_PROVIDER');
    expect(superKeys).toContain('ANTHROPIC_API_KEY');
    expect(superKeys).toContain('EIA_API_KEY');
    expect(superKeys).toContain('SESSION_SECRET');
    expect(superKeys).toContain('ATTACHMENT_ENCRYPTION_KEY');
    expect(superKeys).toContain('SMTP_HOST');
    expect(superKeys).toContain('BACKUP_ENABLED');
  });

  it('masks secret values on GET (super-admin view)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_API_KEY',
      payload: { value: 'sk-ant-supersecret-1234' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const r = await app.inject({
      method: 'GET',
      url: '/api/settings',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const row = r.json().settings.find((s: { key: string }) => s.key === 'ANTHROPIC_API_KEY');
    expect(row.is_secret).toBe(true);
    expect(row.display_value).toBe('••••1234');
    expect(row.configured_in_gui).toBe(true);
  });

  it('does not mask non-secret values', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/ANTHROPIC_MODEL',
      payload: { value: 'claude-opus-4-7' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const r = await app.inject({
      method: 'GET',
      url: '/api/settings',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ...(asSuper(superCookie) as any),
    });
    const row = r.json().settings.find((s: { key: string }) => s.key === 'ANTHROPIC_MODEL');
    expect(row.display_value).toBe('claude-opus-4-7');
  });

  it('PUT mutates the in-memory config so the next AI call sees it', async () => {
    expect(config.ai.provider).not.toBe('ollama');
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/AI_PROVIDER',
      payload: { value: 'ollama' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    expect(r.json().restart_required).toBe(false);
    expect(config.ai.provider).toBe('ollama');
    await app.inject({
      method: 'DELETE',
      url: '/api/settings/AI_PROVIDER',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
  });

  it('PUT to a restart-required key sets restart_required: true', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/SESSION_SECRET',
      payload: { value: 'a-new-session-secret-of-sufficient-length' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(200);
    expect(r.json().restart_required).toBe(true);
  });

  it('rejects unknown settings', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/EVIL_KEY',
      payload: { value: 'pwn' },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('rejects empty PUT (use DELETE to clear)', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/AI_PROVIDER',
      payload: { value: '   ' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
  });

  it('validates AI_PROVIDER against the allow-list', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/AI_PROVIDER',
      payload: { value: 'gemini' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
  });

  it('validates SESSION_SECRET length', async () => {
    const r = await app.inject({
      method: 'PUT',
      url: '/api/settings/SESSION_SECRET',
      payload: { value: 'short' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(r.statusCode).toBe(400);
  });

  it('validates ATTACHMENT_ENCRYPTION_KEY shape (32 bytes b64/hex)', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/api/settings/ATTACHMENT_ENCRYPTION_KEY',
      payload: { value: 'too-short' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(bad.statusCode).toBe(400);

    const good = await app.inject({
      method: 'PUT',
      url: '/api/settings/ATTACHMENT_ENCRYPTION_KEY',
      payload: { value: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(good.statusCode).toBe(200);
  });

  it('DELETE clears the DB row + reverts the in-memory config to env', async () => {
    await app.inject({
      method: 'PUT',
      url: '/api/settings/AI_PROVIDER',
      payload: { value: 'ollama' },
      headers: { 'content-type': 'application/json', cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    const del = await app.inject({
      method: 'DELETE',
      url: '/api/settings/AI_PROVIDER',
      headers: { cookie: superCookie },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      skipAuth: true,
    } as any);
    expect(del.statusCode).toBe(204);
    expect(config.ai.provider).toBe(process.env.AI_PROVIDER ?? '');
  });
});
