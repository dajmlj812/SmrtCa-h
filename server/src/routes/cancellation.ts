import type { FastifyInstance } from 'fastify';
import {
  GENERIC_EMAIL_TEMPLATE,
  lookupCancellation,
} from '../domain/cancellation-library.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.18.1 — read-only lookup against the built-in cancellation
 * library. No data is persisted here — the bill PATCH route is
 * what saves the user's chosen values onto the bill row.
 *
 * Tenant auth is required (the library is shared across tenants
 * but the endpoint is gated like every other /api route so we
 * don't expose it to anonymous scrapers).
 */
export async function cancellationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { name?: string } }>(
    '/api/cancellation/lookup',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const name = (req.query.name ?? '').trim();
      if (name === '') {
        return reply.code(400).send({ error: 'name query param is required' });
      }
      const entry = lookupCancellation(name);
      return {
        matched: entry !== null,
        entry,
        generic_email_template: GENERIC_EMAIL_TEMPLATE,
      };
    },
  );
}
