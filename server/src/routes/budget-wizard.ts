import type { FastifyInstance } from 'fastify';
import { requireTenant } from '../auth/rbac.js';
import {
  type WizardInput,
  type WizardPeriodType,
  buildWizardPreview,
  commitWizard,
} from '../domain/budget-wizard.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const TYPES: WizardPeriodType[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
];

// 0.17.6 — parser returns everything EXCEPT tenantId, which the route
// adds before passing to buildWizardPreview. Keeps the parser pure
// (input → input) and the tenant scoping at the route layer.
function parseInput(body: unknown): Omit<WizardInput, 'tenantId'> | { error: string } {
  const b = (body ?? {}) as Record<string, unknown>;
  const periodType = b.periodType as WizardPeriodType;
  if (!TYPES.includes(periodType)) {
    return { error: `periodType must be one of: ${TYPES.join(', ')}` };
  }
  if (typeof b.anchor !== 'string' || !YMD.test(b.anchor)) {
    return { error: 'anchor must be YYYY-MM-DD' };
  }
  const count = Number(b.count);
  if (!Number.isInteger(count) || count < 1 || count > 24) {
    return { error: 'count must be 1..24' };
  }
  // 0.17.16 — plan name is required on commit, but the preview
  // route doesn't need it (it's purely a projection). Accept a
  // missing name on preview by defaulting to a placeholder;
  // commit revalidates below before INSERT.
  const rawName = typeof b.name === 'string' ? b.name.trim() : '';
  const name = rawName || 'Untitled plan';
  function readOverrides(field: string): Record<number, number> | undefined {
    const raw = b[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') return undefined;
    const out: Record<number, number> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const idx = Number(k);
      const n = Number(v);
      if (Number.isInteger(idx) && Number.isInteger(n) && n >= 0) {
        out[idx] = n;
      }
    }
    return out;
  }
  function readStringOverrides(field: string): Record<number, string> | undefined {
    const raw = b[field];
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== 'object') return undefined;
    const out: Record<number, string> = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const idx = Number(k);
      if (Number.isInteger(idx) && typeof v === 'string') {
        out[idx] = v;
      }
    }
    return out;
  }
  function readPctOverride(field: string): number | undefined {
    const v = b[field];
    if (typeof v !== 'number') return undefined;
    if (!Number.isFinite(v) || v < 0 || v > 100) return undefined;
    return v;
  }
  // 0.17.8 — accept accountIds[] for the "include these accounts"
  // filter. Loose-typed (string[]), validated as UUIDs at parse
  // time; an invalid entry rejects the whole input. Undefined
  // or empty list = include every account (the wizard service
  // treats null + [] as "no filter").
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  let accountIds: string[] | undefined;
  if (Array.isArray(b.accountIds)) {
    accountIds = [];
    for (const id of b.accountIds) {
      if (typeof id !== 'string' || !UUID.test(id)) {
        return { error: 'accountIds must be UUIDs' };
      }
      accountIds.push(id);
    }
  }
  // 0.17.22 — optional savings destination account. null = clear;
  // undefined = leave alone.
  let savingsAccountId: string | null | undefined;
  if (b.savingsAccountId === null) {
    savingsAccountId = null;
  } else if (typeof b.savingsAccountId === 'string') {
    if (!UUID.test(b.savingsAccountId)) {
      return { error: 'savingsAccountId must be a UUID or null' };
    }
    savingsAccountId = b.savingsAccountId;
  }
  return {
    periodType,
    anchor: b.anchor,
    count,
    name,
    accountIds,
    savingsAccountId,
    groceriesOverrideCents: readOverrides('groceriesOverrideCents'),
    fuelOverrideCents: readOverrides('fuelOverrideCents'),
    tollsOverrideCents: readOverrides('tollsOverrideCents'),
    miscOverrideCents: readOverrides('miscOverrideCents'),
    miscNoteOverride: readStringOverrides('miscNoteOverride'),
    savingsOverrideCents: readOverrides('savingsOverrideCents'),
    savingsLowPctOverride: readPctOverride('savingsLowPctOverride'),
    savingsMidPctOverride: readPctOverride('savingsMidPctOverride'),
    savingsHighPctOverride: readPctOverride('savingsHighPctOverride'),
    // 0.21.x — recurring category overrides.
    recurringOverrideCents: readRecurringOverrides(b.recurringOverrideCents),
    recurringDisabled: readDisabled(b.recurringDisabled),
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readRecurringOverrides(
  raw: unknown,
): Record<string, Record<number, number>> | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const out: Record<string, Record<number, number>> = {};
  for (const [catId, perPeriod] of Object.entries(raw as Record<string, unknown>)) {
    if (!UUID_RE.test(catId) || !perPeriod || typeof perPeriod !== 'object') continue;
    const periodMap: Record<number, number> = {};
    for (const [k, v] of Object.entries(perPeriod as Record<string, unknown>)) {
      const idx = Number(k);
      const cents = Number(v);
      if (!Number.isInteger(idx) || idx < 0) continue;
      if (!Number.isFinite(cents) || cents < 0) continue;
      periodMap[idx] = Math.round(cents);
    }
    if (Object.keys(periodMap).length > 0) out[catId] = periodMap;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function readDisabled(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const out: string[] = [];
  for (const id of raw) {
    if (typeof id === 'string' && UUID_RE.test(id)) out.push(id);
  }
  return out.length > 0 ? out : undefined;
}

export async function budgetWizardRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/budgets/wizard/preview', async (req, reply) => {
    // 0.17.6 — tenant scope. Pre-fix the preview aggregated grocery
    // medians + vehicle/route fuel + bills + recurring income across
    // every tenant in the DB, and the commit INSERTed budget rows
    // with tenant_id=NULL — invisible from /budgets.
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const parsed = parseInput(req.body);
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    const preview = await buildWizardPreview({ ...parsed, tenantId });
    return { preview };
  });

  app.post('/api/budgets/wizard/commit', async (req, reply) => {
    const tenantId = requireTenant(req, reply);
    if (!tenantId) return;
    const parsed = parseInput(req.body);
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    // 0.17.16 — commit requires a real name (not the preview default).
    const rawName =
      typeof (req.body as { name?: unknown } | undefined)?.name === 'string'
        ? ((req.body as { name?: string }).name ?? '').trim()
        : '';
    if (!rawName) {
      return reply.code(400).send({ error: 'name is required' });
    }
    const preview = await buildWizardPreview({ ...parsed, name: rawName, tenantId });
    try {
      const result = await commitWizard(preview);
      return { result };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Commit failed';
      // Account-overlap or unique-name conflict.
      const isConflict =
        msg.includes('already in plan') ||
        msg.includes('budget_plans_tenant_id_name_key');
      return reply.code(isConflict ? 409 : 500).send({ error: msg });
    }
  });
}
