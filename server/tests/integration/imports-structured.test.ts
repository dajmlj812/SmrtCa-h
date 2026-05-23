import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeTestApp, resetDb, seedAccount } from '../setup/test-db.js';
import { fixtureBuffer } from '../setup/fixtures.js';
import { buildForm } from '../setup/multipart.js';

/**
 * Phase 8.0 (0.11.0) — OFX/QFX/QIF imports go through the same
 * /api/imports/preview + /api/imports/commit endpoints as CSV/XLSX
 * but skip the column-mapping pipeline. These tests round-trip each
 * format end-to-end.
 */
describe('Structured imports (OFX/QFX/QIF) — 0.11.0', () => {
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

  it('lists the new structured formats in /api/imports/formats', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/imports/formats' });
    const ids = (res.json().formats as Array<{ id: string }>).map((f) => f.id);
    expect(ids).toContain('ofx');
    expect(ids).toContain('qfx');
    expect(ids).toContain('qif');
  });

  it('previews a QIF file (auto-detected)', async () => {
    const form = buildForm({
      name: 'sample.qif',
      buffer: fixtureBuffer('sample.qif'),
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/preview',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const { preview } = res.json();
    expect(preview.detectedFormatId).toBe('qif');
    expect(preview.parsedCount).toBe(3);
    expect(preview.errorCount).toBe(0);
  });

  it('commits a QIF file', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      { name: 'sample.qif', buffer: fixtureBuffer('sample.qif') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.formatId).toBe('qif');
    expect(res.json().result.importedCount).toBe(3);
  });

  it('previews and commits an OFX 1.x SGML file', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      { name: 'sample.ofx', buffer: fixtureBuffer('sample.ofx') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.formatId).toBe('ofx');
    expect(res.json().result.importedCount).toBe(3);
  });

  it('commits a QFX file (Quicken-branded OFX)', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      { name: 'sample.qfx', buffer: fixtureBuffer('sample.qfx') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.formatId).toBe('qfx');
    expect(res.json().result.importedCount).toBe(2);
  });

  it('commits an OFX 2.x XML file', async () => {
    const accountId = await seedAccount();
    const form = buildForm(
      { name: 'sample-ofx2.ofx', buffer: fixtureBuffer('sample-ofx2.ofx') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: form,
      headers: form.getHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().result.importedCount).toBe(2);
  });

  it('skips duplicates when the same QIF is re-imported', async () => {
    const accountId = await seedAccount();
    for (let i = 0; i < 2; i++) {
      const form = buildForm(
        { name: 'sample.qif', buffer: fixtureBuffer('sample.qif') },
        { accountId },
      );
      // eslint-disable-next-line no-await-in-loop
      await app.inject({
        method: 'POST',
        url: '/api/imports/commit',
        payload: form,
        headers: form.getHeaders(),
      });
    }
    const second = buildForm(
      { name: 'sample.qif', buffer: fixtureBuffer('sample.qif') },
      { accountId },
    );
    const res = await app.inject({
      method: 'POST',
      url: '/api/imports/commit',
      payload: second,
      headers: second.getHeaders(),
    });
    const { result } = res.json();
    expect(result.importedCount).toBe(0);
    expect(result.skippedCount).toBe(3);
  });
});
