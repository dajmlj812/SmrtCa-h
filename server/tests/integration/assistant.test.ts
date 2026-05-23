import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import {
  makeTestApp,
  resetDb,
  seedAccount,
  pool,
} from '../setup/test-db.js';
import { setDbValue } from '../../src/domain/settings.js';

/**
 * Phase 9.1 — assistant route + tool-use loop integration tests.
 *
 * The Anthropic client is replaced with a scripted fake that emits a
 * deterministic sequence of message responses. This lets us exercise
 * the full server-side loop (tool dispatch + tool_result reply +
 * audit logging) without a live API call.
 */

interface ScriptedResponse {
  content: Array<
    | { type: 'text'; text: string }
    | { type: 'tool_use'; id: string; name: string; input: unknown }
  >;
  stop_reason: 'end_turn' | 'tool_use';
}

function makeScriptedClient(responses: ScriptedResponse[]) {
  let i = 0;
  return {
    messages: {
      create: async () => {
        const r = responses[i] ?? responses[responses.length - 1]!;
        i += 1;
        return r;
      },
    },
  } as unknown as Anthropic;
}

async function enableClaude() {
  await setDbValue('AI_PROVIDER', 'claude');
  await setDbValue('ANTHROPIC_API_KEY', 'test-key');
}

describe('Assistant routes (0.12.1)', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await makeTestApp();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(async () => {
    await resetDb();
    (app as unknown as { assistantClientOverride?: Anthropic }).assistantClientOverride =
      undefined;
  });

  it('status reports unavailable when AI_PROVIDER is rules', async () => {
    await setDbValue('AI_PROVIDER', 'rules');
    const r = await app.inject({ method: 'GET', url: '/api/assistant/status' });
    expect(r.statusCode).toBe(200);
    expect(r.json().available).toBe(false);
  });

  it('status reports available once AI_PROVIDER=claude + key configured', async () => {
    await enableClaude();
    const r = await app.inject({ method: 'GET', url: '/api/assistant/status' });
    expect(r.json().available).toBe(true);
  });

  it('rejects chat for child role', async () => {
    await enableClaude();
    await pool.query(
      `UPDATE memberships SET role = 'child'
        WHERE user_id = '11111111-1111-1111-1111-111111111111'`,
    );
    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'hi' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(403);
  });

  it('rejects empty messages payload', async () => {
    await enableClaude();
    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(400);
  });

  it('drives a read-only tool_use loop and returns the assistant message', async () => {
    await enableClaude();
    await seedAccount({ name: 'Checking' });
    (app as unknown as { assistantClientOverride?: Anthropic }).assistantClientOverride =
      makeScriptedClient([
        {
          stop_reason: 'tool_use',
          content: [
            { type: 'text', text: 'Let me check your accounts.' },
            {
              type: 'tool_use',
              id: 'call-1',
              name: 'account_balances',
              input: {},
            },
          ],
        },
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'You have one checking account.' }],
        },
      ]);

    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'list my accounts' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.reply).toBe('You have one checking account.');
    expect(body.iterations).toBe(2);
    expect(body.stopReason).toBe('end_turn');
    expect(body.toolCalls).toHaveLength(1);
    expect(body.toolCalls[0]).toMatchObject({
      name: 'account_balances',
      kind: 'read',
    });
    expect(body.toolCalls[0]!.result).toBeDefined();
  });

  it('records audit log entries for write tool calls', async () => {
    await enableClaude();
    const accountId = await seedAccount();
    const txn = await pool.query<{ id: string }>(
      `INSERT INTO transactions (account_id, txn_date, amount_cents, raw_description, dedup_hash)
       VALUES ($1, '2026-04-10', -500, 'STARBUCKS', 'hashAUD') RETURNING id`,
      [accountId],
    );
    // Tenant test setup needs Coffee Shops to exist.
    const t = await pool.query<{ id: string }>(`SELECT id FROM tenants LIMIT 1`);
    await pool.query(
      `INSERT INTO categories (tenant_id, name) VALUES ($1, 'Coffee Shops')`,
      [t.rows[0]!.id],
    );

    (app as unknown as { assistantClientOverride?: Anthropic }).assistantClientOverride =
      makeScriptedClient([
        {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-W',
              name: 'update_transaction_category',
              input: {
                transactionId: txn.rows[0]!.id,
                categoryName: 'Coffee Shops',
              },
            },
          ],
        },
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: 'Done — categorized that as Coffee Shops.' }],
        },
      ]);

    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: {
        messages: [
          { role: 'user', content: 'set that starbucks as Coffee Shops' },
        ],
      },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().toolCalls[0]).toMatchObject({
      name: 'update_transaction_category',
      kind: 'write',
    });

    const audit = await pool.query(
      `SELECT details FROM audit_log
        WHERE action = 'assistant.update_transaction_category'`,
    );
    expect(audit.rowCount).toBe(1);
  });

  it('reports a tool error in the result payload without crashing the loop', async () => {
    await enableClaude();
    (app as unknown as { assistantClientOverride?: Anthropic }).assistantClientOverride =
      makeScriptedClient([
        {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'call-bad',
              name: 'update_transaction_category',
              input: { transactionId: '99999999-9999-9999-9999-999999999999', categoryName: 'Anything' },
            },
          ],
        },
        {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: "Couldn't find that transaction." }],
        },
      ]);
    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'do the thing' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().toolCalls[0]).toMatchObject({
      name: 'update_transaction_category',
      kind: 'write',
    });
    expect(r.json().toolCalls[0]!.error).toMatch(/not found/);
  });

  it('caps tool-use loop iterations to prevent runaway', async () => {
    await enableClaude();
    // Every response is a tool_use → exercises the cap.
    (app as unknown as { assistantClientOverride?: Anthropic }).assistantClientOverride =
      makeScriptedClient([
        {
          stop_reason: 'tool_use',
          content: [
            {
              type: 'tool_use',
              id: 'inf',
              name: 'account_balances',
              input: {},
            },
          ],
        },
      ]);
    const r = await app.inject({
      method: 'POST',
      url: '/api/assistant/chat',
      payload: { messages: [{ role: 'user', content: 'go forever' }] },
      headers: { 'content-type': 'application/json' },
    });
    expect(r.statusCode).toBe(200);
    expect(r.json().stopReason).toBe('tool_use_loop_cap');
    expect(r.json().iterations).toBe(8);
  });
});
