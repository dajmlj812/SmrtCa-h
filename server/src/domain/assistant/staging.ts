import { query, withTransaction } from '../../db/pool.js';
import { recordAudit } from '../audit.js';
import { findTool, type AssistantToolContext } from './tools.js';

/**
 * 0.20.1 — stage/preview/commit infrastructure for the assistant.
 *
 * Two-phase write flow:
 *
 *   1. Stage     — assistant proposes a list of tool calls; we save
 *                  the batch and surface it to the user for review.
 *   2. Commit    — user clicks Apply; we run each action in a
 *                  transaction, capturing the inverse payload per
 *                  action as we go (so /undo can reverse later).
 *   3. Undo      — user clicks Undo; we run inverses in reverse
 *                  order. Idempotent at the batch level (re-running
 *                  /undo on an already-undone batch is a 409).
 *
 * Inverse coverage: 4 write tools today
 *   • update_transaction_category
 *   • bulk_recategorize
 *   • create_budget
 *   • update_savings_goal
 * Other write tools (mark_bill_paid, split_transaction) fall back
 * to "no inverse available" — the batch still applies, but
 * uncovered actions won't undo. The UI tells the user that.
 */

export interface StagedAction {
  tool: string;
  input: Record<string, unknown>;
}

export interface StagedBatch {
  id: string;
  tenant_id: string;
  user_id: string;
  status: 'pending' | 'applied' | 'undone' | 'failed';
  summary: string;
  actions: StagedAction[];
  inverses: InverseAction[];
  error: string | null;
  created_at: string;
  applied_at: string | null;
  undone_at: string | null;
}

interface InverseAction {
  /** Free-form key the inverse executor will dispatch on. */
  kind: string;
  payload: Record<string, unknown>;
  /** When the original tool has no inverse coverage. UI surfaces this. */
  unsupported?: boolean;
}

export async function createBatch(
  ctx: AssistantToolContext,
  summary: string,
  actions: StagedAction[],
): Promise<StagedBatch> {
  const r = await query<StagedBatch>(
    `INSERT INTO assistant_staged_batches
       (tenant_id, user_id, summary, actions)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING id, tenant_id, user_id, status, summary,
               actions, inverses, error,
               created_at::text, applied_at::text, undone_at::text`,
    [ctx.tenantId, ctx.userId, summary.slice(0, 500), JSON.stringify(actions)],
  );
  return r.rows[0]!;
}

export async function getBatch(
  ctx: AssistantToolContext,
  id: string,
): Promise<StagedBatch | null> {
  const r = await query<StagedBatch>(
    `SELECT id, tenant_id, user_id, status, summary,
            actions, inverses, error,
            created_at::text, applied_at::text, undone_at::text
       FROM assistant_staged_batches
      WHERE id = $1 AND tenant_id = $2 AND user_id = $3`,
    [id, ctx.tenantId, ctx.userId],
  );
  return r.rowCount && r.rowCount > 0 ? r.rows[0]! : null;
}

/**
 * Execute every action in a batch. Captures the inverse-payload
 * per action BEFORE the action runs (so we can roll back during
 * the transaction if anything throws midway).
 */
export async function commitBatch(
  ctx: AssistantToolContext,
  batch: StagedBatch,
): Promise<StagedBatch> {
  if (batch.status !== 'pending') {
    throw new Error(`Batch ${batch.id} is ${batch.status} — only 'pending' batches can be committed`);
  }

  const inverses: InverseAction[] = [];
  try {
    await withTransaction(async (client) => {
      for (const action of batch.actions) {
        // Capture inverse BEFORE the action runs so we have the
        // pre-state baked in.
        const inverse = await captureInverse(client, ctx, action);
        inverses.push(inverse);
        // Now execute the actual tool.
        const tool = findTool(action.tool);
        if (!tool || tool.kind !== 'write') {
          throw new Error(`Unknown or non-write tool: ${action.tool}`);
        }
        await tool.execute(ctx, action.input);
      }
    });

    const r = await query<StagedBatch>(
      `UPDATE assistant_staged_batches
          SET status = 'applied',
              applied_at = now(),
              inverses = $2::jsonb
        WHERE id = $1
        RETURNING id, tenant_id, user_id, status, summary,
                  actions, inverses, error,
                  created_at::text, applied_at::text, undone_at::text`,
      [batch.id, JSON.stringify(inverses)],
    );

    await recordAudit({
      tenantId: ctx.tenantId,
      actorUserId: ctx.userId,
      actorKind: 'tenant_user',
      action: 'assistant.batch_applied',
      targetKind: 'assistant_staged_batch',
      targetId: batch.id,
      details: { action_count: batch.actions.length },
    });

    return r.rows[0]!;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE assistant_staged_batches
          SET status = 'failed', error = $2
        WHERE id = $1`,
      [batch.id, message.slice(0, 500)],
    );
    throw err;
  }
}

/**
 * Reverse every inverse in reverse order. Throws if the batch is
 * not currently 'applied'.
 */
export async function undoBatch(
  ctx: AssistantToolContext,
  batch: StagedBatch,
): Promise<StagedBatch> {
  if (batch.status !== 'applied') {
    throw new Error(
      `Batch ${batch.id} is ${batch.status} — only 'applied' batches can be undone`,
    );
  }
  const unsupported = batch.inverses.filter((i) => i.unsupported).length;
  await withTransaction(async (client) => {
    for (let i = batch.inverses.length - 1; i >= 0; i--) {
      const inv = batch.inverses[i]!;
      if (inv.unsupported) continue;
      await applyInverse(client, ctx, inv);
    }
  });

  const r = await query<StagedBatch>(
    `UPDATE assistant_staged_batches
        SET status = 'undone', undone_at = now()
      WHERE id = $1
      RETURNING id, tenant_id, user_id, status, summary,
                actions, inverses, error,
                created_at::text, applied_at::text, undone_at::text`,
    [batch.id],
  );

  await recordAudit({
    tenantId: ctx.tenantId,
    actorUserId: ctx.userId,
    actorKind: 'tenant_user',
    action: 'assistant.batch_undone',
    targetKind: 'assistant_staged_batch',
    targetId: batch.id,
    details: {
      inverses_run: batch.inverses.length - unsupported,
      unsupported_skipped: unsupported,
    },
  });

  return r.rows[0]!;
}

// ── Per-tool inverse generators ──────────────────────────────────

type DBClient = Parameters<Parameters<typeof withTransaction>[0]>[0];

async function captureInverse(
  client: DBClient,
  ctx: AssistantToolContext,
  action: StagedAction,
): Promise<InverseAction> {
  switch (action.tool) {
    case 'update_transaction_category': {
      // Before-state: the current category_id + normalization_status.
      const txnId = String(action.input.transactionId ?? action.input.transaction_id ?? '');
      const r = await client.query<{
        category_id: string | null;
        normalization_status: string;
      }>(
        `SELECT category_id, normalization_status FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.id = $1 AND a.tenant_id = $2`,
        [txnId, ctx.tenantId],
      );
      if (r.rowCount === 0) return { kind: 'noop', payload: {}, unsupported: true };
      return {
        kind: 'restore_transaction_category',
        payload: {
          transactionId: txnId,
          categoryId: r.rows[0]!.category_id,
          normalizationStatus: r.rows[0]!.normalization_status,
        },
      };
    }
    case 'bulk_recategorize': {
      // Before-state: per-row { id, category_id, normalization_status } for every txn the bulk op would touch.
      const ids = Array.isArray(action.input.transactionIds)
        ? (action.input.transactionIds as string[])
        : [];
      if (ids.length === 0) {
        return { kind: 'noop', payload: {}, unsupported: true };
      }
      const r = await client.query<{
        id: string;
        category_id: string | null;
        normalization_status: string;
      }>(
        `SELECT t.id, t.category_id, t.normalization_status FROM transactions t
           JOIN accounts a ON a.id = t.account_id
          WHERE t.id = ANY($1::uuid[]) AND a.tenant_id = $2`,
        [ids, ctx.tenantId],
      );
      return {
        kind: 'restore_bulk_categories',
        payload: { rows: r.rows },
      };
    }
    case 'create_budget': {
      // Before-state: no budget existed. Inverse = delete the budget
      // we're about to create. We can't know the id yet, so capture
      // a fingerprint and resolve to an id at undo time.
      return {
        kind: 'delete_created_budget',
        payload: {
          periodMonth: action.input.periodMonth ?? action.input.period_month,
          categoryId: action.input.categoryId ?? action.input.category_id,
          amountCents: action.input.amountCents ?? action.input.amount_cents,
        },
      };
    }
    case 'update_savings_goal': {
      const goalId = String(action.input.goalId ?? action.input.goal_id ?? '');
      const r = await client.query<{
        name: string;
        target_amount_cents: string;
        current_amount_cents: string;
        target_date: string | null;
      }>(
        `SELECT name,
                target_amount_cents::text,
                current_amount_cents::text,
                target_date::text
           FROM savings_goals
          WHERE id = $1 AND tenant_id = $2`,
        [goalId, ctx.tenantId],
      );
      if (r.rowCount === 0) return { kind: 'noop', payload: {}, unsupported: true };
      return {
        kind: 'restore_savings_goal',
        payload: {
          goalId,
          name: r.rows[0]!.name,
          targetAmountCents: Number(r.rows[0]!.target_amount_cents),
          currentAmountCents: Number(r.rows[0]!.current_amount_cents),
          targetDate: r.rows[0]!.target_date,
        },
      };
    }
    default:
      return { kind: 'noop', payload: {}, unsupported: true };
  }
}

async function applyInverse(
  client: DBClient,
  ctx: AssistantToolContext,
  inv: InverseAction,
): Promise<void> {
  switch (inv.kind) {
    case 'restore_transaction_category': {
      const p = inv.payload as { transactionId: string; categoryId: string | null; normalizationStatus: string };
      await client.query(
        `UPDATE transactions
            SET category_id = $1, normalization_status = $2
          WHERE id = $3 AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $4)`,
        [p.categoryId, p.normalizationStatus, p.transactionId, ctx.tenantId],
      );
      return;
    }
    case 'restore_bulk_categories': {
      const p = inv.payload as {
        rows: Array<{ id: string; category_id: string | null; normalization_status: string }>;
      };
      for (const row of p.rows) {
        await client.query(
          `UPDATE transactions
              SET category_id = $1, normalization_status = $2
            WHERE id = $3 AND account_id IN (SELECT id FROM accounts WHERE tenant_id = $4)`,
          [row.category_id, row.normalization_status, row.id, ctx.tenantId],
        );
      }
      return;
    }
    case 'delete_created_budget': {
      const p = inv.payload as {
        periodMonth: string;
        categoryId: string | null;
        amountCents: number;
      };
      // Delete the most-recently-created matching budget. If the
      // user has multiple matching rows (unlikely; budgets are
      // typically unique per category-month) we'd only catch the
      // latest — that's still safer than blasting them all.
      await client.query(
        `DELETE FROM budgets
          WHERE tenant_id = $1
            AND period_month = $2::date
            AND category_id IS NOT DISTINCT FROM $3::uuid
            AND amount_cents = $4
          AND id = (
            SELECT id FROM budgets
             WHERE tenant_id = $1
               AND period_month = $2::date
               AND category_id IS NOT DISTINCT FROM $3::uuid
               AND amount_cents = $4
             ORDER BY created_at DESC LIMIT 1
          )`,
        [ctx.tenantId, p.periodMonth, p.categoryId, p.amountCents],
      );
      return;
    }
    case 'restore_savings_goal': {
      const p = inv.payload as {
        goalId: string;
        name: string;
        targetAmountCents: number;
        currentAmountCents: number;
        targetDate: string | null;
      };
      await client.query(
        `UPDATE savings_goals
            SET name = $1,
                target_amount_cents = $2,
                current_amount_cents = $3,
                target_date = $4::date
          WHERE id = $5 AND tenant_id = $6`,
        [p.name, p.targetAmountCents, p.currentAmountCents, p.targetDate, p.goalId, ctx.tenantId],
      );
      return;
    }
    case 'noop':
      return;
    default:
      // Unknown kind — log and skip rather than throw, so a partial
      // undo doesn't get fully aborted by one bad entry.
      // eslint-disable-next-line no-console
      console.error('assistant-staging: unknown inverse kind', inv.kind);
      return;
  }
}

/** Pretty-print a staged action for the UI preview. */
export function describeAction(action: StagedAction): string {
  switch (action.tool) {
    case 'update_transaction_category':
      return `Set category on transaction ${(action.input.transactionId as string)?.slice(0, 8) ?? '?'}…`;
    case 'bulk_recategorize': {
      const ids = action.input.transactionIds as string[] | undefined;
      return `Recategorize ${ids?.length ?? '?'} transactions`;
    }
    case 'create_budget':
      return `Create budget for ${action.input.categoryName ?? 'a category'} at $${(Number(action.input.amountCents ?? 0) / 100).toFixed(2)}`;
    case 'update_savings_goal':
      return `Update savings goal "${action.input.name ?? action.input.goalId}"`;
    case 'mark_bill_paid':
      return `Mark bill ${(action.input.billId as string)?.slice(0, 8)}… as paid`;
    case 'split_transaction':
      return `Split transaction ${(action.input.transactionId as string)?.slice(0, 8)}… into ${(action.input.splits as unknown[])?.length ?? '?'} parts`;
    default:
      return action.tool;
  }
}

