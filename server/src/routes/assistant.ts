import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type Anthropic from '@anthropic-ai/sdk';
import { loadUserContext } from '../auth/rbac.js';
import {
  assistantAvailable,
  runAssistantChat,
  type AssistantMessage,
} from '../domain/assistant/runtime.js';

/**
 * Phase 9.1 — assistant routes.
 *
 *   GET  /api/assistant/status  — is the assistant configured?
 *   POST /api/assistant/chat    — run a single tool-use loop
 *
 * Children are blocked entirely. Spouses + admins are both allowed —
 * the assistant's write tools call `recordAudit()` per call so the
 * super-admin audit log captures every change.
 *
 * Tenant scoping: every tool call receives ctx.tenantId from the
 * authenticated session — the model NEVER picks the tenant.
 */

function requireTenant(req: FastifyRequest, reply: FastifyReply): string | null {
  if (!req.user) {
    reply.code(401).send({ error: 'Not authenticated' });
    return null;
  }
  if (!req.user.tenantId) {
    reply.code(403).send({ error: 'No active tenant' });
    return null;
  }
  return req.user.tenantId;
}

interface ChatBody {
  messages?: Array<{ role: string; content: string }>;
}

export async function assistantRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/assistant/status', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const a = await assistantAvailable();
    // Children never see the assistant nav link, so report unavailable
    // for them regardless of provider config.
    if (req.user.tenantId) {
      const ctx = await loadUserContext(req.user.id, req.user.tenantId);
      if (ctx.role === 'child') {
        return { available: false, reason: 'Assistant is not available for child accounts' };
      }
    }
    return a;
  });

  app.post<{ Body: ChatBody }>('/api/assistant/chat', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const ctx = await loadUserContext(req.user!.id, tenantId);
    if (ctx.role === 'child') {
      return reply
        .code(403)
        .send({ error: 'Assistant is not available for child accounts' });
    }
    const a = await assistantAvailable();
    if (!a.available) {
      return reply.code(400).send({ error: a.reason ?? 'Assistant not configured' });
    }

    const rawMessages = req.body?.messages ?? [];
    if (rawMessages.length === 0) {
      return reply.code(400).send({ error: 'messages[] is required' });
    }
    // Sanitize: only role + content, only 'user' or 'assistant'.
    const messages: AssistantMessage[] = rawMessages
      .filter(
        (m): m is { role: 'user' | 'assistant'; content: string } =>
          (m.role === 'user' || m.role === 'assistant') &&
          typeof m.content === 'string' &&
          m.content.length > 0,
      )
      .map((m) => ({ role: m.role, content: m.content }))
      // Cap at last 40 messages to keep the request bounded.
      .slice(-40);

    if (messages.length === 0) {
      return reply.code(400).send({ error: 'no valid messages' });
    }

    // Tests inject a mocked client onto the app instance.
    const client = (app as unknown as { assistantClientOverride?: Anthropic })
      .assistantClientOverride;

    const result = await runAssistantChat({
      messages,
      ctx: { tenantId, userId: req.user!.id },
      ...(client ? { client } : {}),
    });
    return result;
  });
}
