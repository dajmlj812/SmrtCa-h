import type { FastifyInstance } from 'fastify';
import {
  GENERIC_RETENTION_EMAIL,
  GENERIC_BILL_DISPUTE_EMAIL,
  GENERIC_INSURANCE_AUDIT_EMAIL,
  lookupNegotiation,
} from '../domain/negotiation-library.js';
import { requireTenant } from '../auth/rbac.js';

/**
 * 0.19.1 — read-only lookup against the built-in bill-negotiation
 * library. Mirrors the cancellation lookup endpoint exactly. No
 * data is persisted here — the bill PATCH route saves the user's
 * chosen values onto the bill row.
 */
export async function negotiationRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: { name?: string } }>(
    '/api/negotiation/lookup',
    async (req, reply) => {
      const tenantId = requireTenant(req, reply);
      if (!tenantId) return;
      const name = (req.query.name ?? '').trim();
      if (name === '') {
        return reply.code(400).send({ error: 'name query param is required' });
      }
      const entry = lookupNegotiation(name);
      return {
        matched: entry !== null,
        entry,
        generic_retention_email: GENERIC_RETENTION_EMAIL,
        generic_bill_dispute_email: GENERIC_BILL_DISPUTE_EMAIL,
        generic_insurance_audit_email: GENERIC_INSURANCE_AUDIT_EMAIL,
      };
    },
  );
}
