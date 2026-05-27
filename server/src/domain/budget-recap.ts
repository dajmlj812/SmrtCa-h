import Anthropic from '@anthropic-ai/sdk';
import { pool } from '../db/pool.js';

/**
 * 0.21.x — month-end budget recap.
 *
 * Given a tenant + a closed budget month, build a deterministic
 * hit / under / over breakdown from budget_actuals, ask Claude
 * for 3-5 paragraphs of feedback, and persist the result so we
 * don't pay tokens to regenerate. Fronted by /api/budget-recaps.
 */

const MODEL = 'claude-haiku-4-5';
const HIT_TOLERANCE_PCT = 10;

export interface RecapBucket {
  category_name: string;
  budgeted_cents: number;
  actual_cents: number;
  delta_pct: number;
  status: 'hit' | 'under' | 'over';
}

export interface RecapPayload {
  tenant_id: string;
  recap_month: string; // YYYY-MM-01
  budgeted_cents: number;
  actual_cents: number;
  hit_count: number;
  under_count: number;
  over_count: number;
  buckets: RecapBucket[];
  narrative: string;
  generated_at: string;
}

interface RowFromActuals {
  category_name: string | null;
  bill_name: string | null;
  budgeted_cents: number;
  actual_cents: number;
}

function classify(b: number, a: number): 'hit' | 'under' | 'over' {
  if (b === 0) return a > 0 ? 'over' : 'hit';
  const pct = ((a - b) / b) * 100;
  if (Math.abs(pct) <= HIT_TOLERANCE_PCT) return 'hit';
  return pct < 0 ? 'under' : 'over';
}

async function fetchMonthRows(
  tenantId: string,
  month: string,
): Promise<RowFromActuals[]> {
  // Re-use the actuals SQL — same shape as /api/budgets/actual,
  // but stripped down to what we need for the recap. Aggregated by
  // (category, bill) so per-bill rows stay distinct.
  const monthStart = month;
  const monthEnd = (() => {
    const d = new Date(month);
    d.setUTCMonth(d.getUTCMonth() + 1);
    return d.toISOString().slice(0, 10);
  })();
  const r = await pool.query<{
    category_name: string | null;
    bill_name: string | null;
    budgeted_cents: string;
    actual_cents: string;
  }>(
    `WITH budget_rows AS (
       SELECT b.id, b.category_id, b.bill_id, b.amount_cents,
              c.name AS category_name, bl.name AS bill_name
         FROM budgets b
    LEFT JOIN categories c ON c.id = b.category_id
    LEFT JOIN bills      bl ON bl.id = b.bill_id
        WHERE b.tenant_id = $1
          AND b.period_type = 'monthly'
          AND b.period_month = $2::date
     ),
     spend AS (
       SELECT category_id,
              SUM(-amount_cents)::bigint AS actual
         FROM transaction_category_lines l
         JOIN accounts a ON a.id = l.account_id
        WHERE a.tenant_id = $1
          AND l.amount_cents < 0
          AND l.transfer_group_id IS NULL
          AND l.txn_date >= $2::date
          AND l.txn_date <  $3::date
        GROUP BY category_id
     )
     SELECT br.category_name, br.bill_name,
            br.amount_cents::text AS budgeted_cents,
            CASE WHEN br.bill_id IS NOT NULL
              THEN br.amount_cents::text
              ELSE COALESCE(s.actual, 0)::text
            END AS actual_cents
       FROM budget_rows br
  LEFT JOIN spend s ON s.category_id = br.category_id`,
    [tenantId, monthStart, monthEnd],
  );
  return r.rows.map((x) => ({
    category_name: x.category_name,
    bill_name: x.bill_name,
    budgeted_cents: Number(x.budgeted_cents),
    actual_cents: Number(x.actual_cents),
  }));
}

function buildBuckets(rows: RowFromActuals[]): RecapBucket[] {
  // Roll up by category_name so a category with multiple bills
  // shows as one entry in the recap.
  const map = new Map<string, { b: number; a: number }>();
  for (const r of rows) {
    const key = r.category_name ?? 'Uncategorised';
    const existing = map.get(key) ?? { b: 0, a: 0 };
    existing.b += r.budgeted_cents;
    existing.a += r.actual_cents;
    map.set(key, existing);
  }
  const buckets: RecapBucket[] = [];
  for (const [name, { b, a }] of map.entries()) {
    if (b === 0 && a === 0) continue;
    const deltaPct = b === 0 ? 100 : ((a - b) / b) * 100;
    buckets.push({
      category_name: name,
      budgeted_cents: b,
      actual_cents: a,
      delta_pct: Math.round(deltaPct * 10) / 10,
      status: classify(b, a),
    });
  }
  // Sort: over (worst first), then under (worst deviation first), then hit.
  return buckets.sort((x, y) => {
    const ord = { over: 0, under: 1, hit: 2 } as const;
    if (ord[x.status] !== ord[y.status]) return ord[x.status] - ord[y.status];
    return Math.abs(y.delta_pct) - Math.abs(x.delta_pct);
  });
}

async function generateNarrative(
  buckets: RecapBucket[],
  monthLabel: string,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Degraded fallback when the AI key isn't set — produce a
    // deterministic narrative so the recap still ships.
    return buildFallbackNarrative(buckets, monthLabel);
  }
  const over = buckets.filter((b) => b.status === 'over');
  const under = buckets.filter((b) => b.status === 'under');
  const hit = buckets.filter((b) => b.status === 'hit');
  const facts = JSON.stringify(
    {
      month: monthLabel,
      hit: hit.map((b) => ({
        category: b.category_name,
        budgeted: b.budgeted_cents / 100,
        actual: b.actual_cents / 100,
        delta_pct: b.delta_pct,
      })),
      under: under.map((b) => ({
        category: b.category_name,
        budgeted: b.budgeted_cents / 100,
        actual: b.actual_cents / 100,
        delta_pct: b.delta_pct,
      })),
      over: over.map((b) => ({
        category: b.category_name,
        budgeted: b.budgeted_cents / 100,
        actual: b.actual_cents / 100,
        delta_pct: b.delta_pct,
      })),
    },
    null,
    2,
  );

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 1200,
    system: [
      {
        type: 'text',
        text:
          'You are a friendly personal-finance coach reviewing a closed budget month. ' +
          'Write 3-5 short paragraphs (markdown) covering:\n' +
          '1) What went well — call out the wins.\n' +
          '2) Where the user came in under budget and whether that was deliberate or accidental.\n' +
          '3) Where they overspent and one concrete suggestion to recover next month.\n' +
          '4) A bottom-line summary with a single actionable nudge.\n\n' +
          'Keep the tone warm and pragmatic, never preachy. Always cite dollar amounts and category names from the data. Avoid generic advice.',
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          'Here is the structured budget recap for ' +
          monthLabel +
          ':\n\n```json\n' +
          facts +
          '\n```\n\nWrite the recap.',
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock || textBlock.type !== 'text') {
    return buildFallbackNarrative(buckets, monthLabel);
  }
  return textBlock.text.trim();
}

function buildFallbackNarrative(
  buckets: RecapBucket[],
  monthLabel: string,
): string {
  const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
  const over = buckets.filter((b) => b.status === 'over');
  const under = buckets.filter((b) => b.status === 'under');
  const hit = buckets.filter((b) => b.status === 'hit');
  const lines: string[] = [];
  lines.push(`### ${monthLabel} recap`);
  if (hit.length > 0) {
    lines.push(
      `**Hit budget (within ${HIT_TOLERANCE_PCT}%):** ${hit
        .map((b) => `${b.category_name} (${fmt(b.actual_cents)} of ${fmt(b.budgeted_cents)})`)
        .join(', ')}.`,
    );
  }
  if (under.length > 0) {
    lines.push(
      `**Came in under budget:** ${under
        .map((b) => `${b.category_name} (${b.delta_pct.toFixed(0)}% under)`)
        .join(', ')}.`,
    );
  }
  if (over.length > 0) {
    lines.push(
      `**Overspent:** ${over
        .map((b) => `${b.category_name} (${b.delta_pct.toFixed(0)}% over)`)
        .join(', ')}.`,
    );
    lines.push(
      `Bottom line: tighten the overspent categories next month by either lowering the budget to a realistic number or actively shopping each line item.`,
    );
  } else {
    lines.push(
      `Bottom line: nothing went over. Consider re-distributing the under-spend toward goals or debt payoff next month.`,
    );
  }
  return lines.join('\n\n');
}

function monthLabel(monthIso: string): string {
  const d = new Date(monthIso);
  return d.toLocaleString('default', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export async function generateBudgetRecap(
  tenantId: string,
  recapMonth: string,
): Promise<RecapPayload> {
  const rows = await fetchMonthRows(tenantId, recapMonth);
  const buckets = buildBuckets(rows);
  const totals = buckets.reduce(
    (acc, b) => {
      acc.budgeted += b.budgeted_cents;
      acc.actual += b.actual_cents;
      acc[b.status] += 1;
      return acc;
    },
    { budgeted: 0, actual: 0, hit: 0, under: 0, over: 0 },
  );
  const narrative = await generateNarrative(buckets, monthLabel(recapMonth));

  // Persist (upsert). Re-running for the same (tenant, month)
  // overwrites the previous narrative — useful when transactions
  // arrived late and the recap needs refreshing.
  const r = await pool.query<{ id: string; generated_at: string }>(
    `INSERT INTO budget_recaps
       (tenant_id, recap_month, budgeted_cents, actual_cents,
        hit_count, under_count, over_count, buckets, narrative)
     VALUES ($1, $2::date, $3, $4, $5, $6, $7, $8::jsonb, $9)
     ON CONFLICT (tenant_id, recap_month) DO UPDATE
       SET budgeted_cents = EXCLUDED.budgeted_cents,
           actual_cents   = EXCLUDED.actual_cents,
           hit_count      = EXCLUDED.hit_count,
           under_count    = EXCLUDED.under_count,
           over_count     = EXCLUDED.over_count,
           buckets        = EXCLUDED.buckets,
           narrative      = EXCLUDED.narrative,
           generated_at   = now()
     RETURNING id, generated_at::text`,
    [
      tenantId,
      recapMonth,
      totals.budgeted,
      totals.actual,
      totals.hit,
      totals.under,
      totals.over,
      JSON.stringify(buckets),
      narrative,
    ],
  );

  // Emit an insight card pointing at the recap.
  await pool.query(
    `INSERT INTO insight_cards
       (tenant_id, kind, severity, title, body, action_label, action_url,
        source_kind, source_id)
     VALUES ($1, 'budget_recap', 'info', $2, $3, 'View recap', $4,
             'budget_recap', $5)
     ON CONFLICT (tenant_id, kind, source_id)
       WHERE dismissed_at IS NULL AND source_id IS NOT NULL
       DO NOTHING`,
    [
      tenantId,
      `Your ${monthLabel(recapMonth)} budget recap is ready`,
      `Hit ${totals.hit}, under ${totals.under}, over ${totals.over} categories. Click through for the full breakdown.`,
      `/budget-recap/${recapMonth.slice(0, 7)}`,
      r.rows[0]!.id,
    ],
  );

  return {
    tenant_id: tenantId,
    recap_month: recapMonth,
    budgeted_cents: totals.budgeted,
    actual_cents: totals.actual,
    hit_count: totals.hit,
    under_count: totals.under,
    over_count: totals.over,
    buckets,
    narrative,
    generated_at: r.rows[0]!.generated_at,
  };
}

export async function getBudgetRecap(
  tenantId: string,
  recapMonth: string,
): Promise<RecapPayload | null> {
  const r = await pool.query<{
    tenant_id: string;
    recap_month: string;
    budgeted_cents: string;
    actual_cents: string;
    hit_count: number;
    under_count: number;
    over_count: number;
    buckets: RecapBucket[];
    narrative: string;
    generated_at: string;
  }>(
    `SELECT tenant_id,
            recap_month::text,
            budgeted_cents::text,
            actual_cents::text,
            hit_count, under_count, over_count,
            buckets, narrative,
            generated_at::text
       FROM budget_recaps
      WHERE tenant_id = $1 AND recap_month = $2::date
      LIMIT 1`,
    [tenantId, recapMonth],
  );
  if (r.rowCount === 0) return null;
  const row = r.rows[0]!;
  return {
    tenant_id: row.tenant_id,
    recap_month: row.recap_month,
    budgeted_cents: Number(row.budgeted_cents),
    actual_cents: Number(row.actual_cents),
    hit_count: row.hit_count,
    under_count: row.under_count,
    over_count: row.over_count,
    buckets: row.buckets,
    narrative: row.narrative,
    generated_at: row.generated_at,
  };
}
