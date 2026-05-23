import type { FastifyInstance } from 'fastify';
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

function parseInput(body: unknown): WizardInput | { error: string } {
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
  return {
    periodType,
    anchor: b.anchor,
    count,
    groceriesOverrideCents: readOverrides('groceriesOverrideCents'),
    fuelOverrideCents: readOverrides('fuelOverrideCents'),
    tollsOverrideCents: readOverrides('tollsOverrideCents'),
    miscOverrideCents: readOverrides('miscOverrideCents'),
    miscNoteOverride: readStringOverrides('miscNoteOverride'),
    savingsOverrideCents: readOverrides('savingsOverrideCents'),
    savingsIncomePctOverride: readPctOverride('savingsIncomePctOverride'),
    savingsLeftoverPctOverride: readPctOverride('savingsLeftoverPctOverride'),
  };
}

export async function budgetWizardRoutes(app: FastifyInstance): Promise<void> {
  app.post('/api/budgets/wizard/preview', async (req, reply) => {
    const parsed = parseInput(req.body);
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    const preview = await buildWizardPreview(parsed);
    return { preview };
  });

  app.post('/api/budgets/wizard/commit', async (req, reply) => {
    const parsed = parseInput(req.body);
    if ('error' in parsed) {
      return reply.code(400).send({ error: parsed.error });
    }
    const preview = await buildWizardPreview(parsed);
    const result = await commitWizard(preview);
    return { result };
  });
}
