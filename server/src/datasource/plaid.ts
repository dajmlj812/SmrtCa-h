import { pool } from '../db/pool.js';
import { decryptString } from '../domain/crypto.js';
import {
  mapPlaidTransaction,
  PlaidClient,
  PlaidError,
  type FetchLike,
  type MappedPlaidTxn,
  type PlaidTxn,
} from '../domain/plaid.js';
import { getPlaidConfig } from '../domain/settings.js';
import type { ParsedTransaction, RowError } from '../import/types.js';
import type { TransactionDataSource } from './types.js';

/**
 * Phase 8.2's data source. Wraps Plaid's /transactions/sync into the
 * common TransactionDataSource shape so the existing persistBatch()
 * dedup path handles everything downstream.
 *
 * Per-item, per-account result: `fetch()` returns a flat list of
 * ParsedTransaction. The route handler is responsible for splitting
 * by Plaid account_id and routing each to the correct SmrtCash
 * account (via the plaid_account_links table) before persisting.
 */

export interface PlaidDataSourceContext {
  accountId?: string;
  plaidItemId: string;
  tenantId: string;
  fetchImpl?: FetchLike;
}

export interface PlaidFetchByAccount {
  /** SmrtCash account_id → list of ParsedTransactions for that account. */
  byAccount: Map<string, ParsedTransaction[]>;
  unmapped: MappedPlaidTxn[];
  errors: RowError[];
  cursor: string;
}

interface ItemRow {
  id: string;
  access_token_encrypted: Buffer;
  sync_cursor: string | null;
}

interface AccountLinkRow {
  plaid_account_id: string;
  account_id: string;
}

/**
 * Pull every page of /transactions/sync starting from the stored
 * cursor. Returns the consolidated set of added + modified
 * transactions, grouped by SmrtCash account (via the
 * plaid_account_links join), plus the final cursor to persist.
 */
export async function fetchPlaidItemTransactions(
  ctx: PlaidDataSourceContext,
): Promise<PlaidFetchByAccount> {
  const cfg = await getPlaidConfig();
  if (!cfg) {
    throw new PlaidError('invalid_request', 'Plaid is not enabled or not configured');
  }

  const item = await pool.query<ItemRow>(
    `SELECT id, access_token_encrypted, sync_cursor
       FROM plaid_items
      WHERE id = $1 AND tenant_id = $2`,
    [ctx.plaidItemId, ctx.tenantId],
  );
  if (item.rowCount === 0) {
    throw new PlaidError('invalid_request', `Plaid item ${ctx.plaidItemId} not found`);
  }
  const row = item.rows[0]!;
  const accessToken = decryptString(row.access_token_encrypted);

  const links = await pool.query<AccountLinkRow>(
    `SELECT plaid_account_id, account_id FROM plaid_account_links WHERE plaid_item_id = $1`,
    [row.id],
  );
  const linkByPlaidAccount = new Map(
    links.rows.map((l) => [l.plaid_account_id, l.account_id]),
  );

  const client = new PlaidClient({ config: cfg, fetchImpl: ctx.fetchImpl });

  let cursor: string | null = row.sync_cursor;
  const added: PlaidTxn[] = [];
  const modified: PlaidTxn[] = [];
  // Guard against a pathological API that says has_more forever.
  for (let i = 0; i < 50; i++) {
    const page = await client.transactionsSync(accessToken, cursor);
    added.push(...page.added);
    modified.push(...page.modified);
    cursor = page.next_cursor;
    if (!page.has_more) break;
  }

  const byAccount = new Map<string, ParsedTransaction[]>();
  const unmapped: MappedPlaidTxn[] = [];
  const errors: RowError[] = [];
  let counter = 0;
  for (const p of [...added, ...modified]) {
    counter += 1;
    try {
      const mapped = mapPlaidTransaction(p);
      const smrtAccount = linkByPlaidAccount.get(mapped.plaidAccountId);
      if (!smrtAccount) {
        unmapped.push(mapped);
        continue;
      }
      const txn: ParsedTransaction = {
        txnDate: mapped.txnDate,
        postDate: mapped.postDate,
        amountCents: mapped.amountCents,
        rawDescription: mapped.rawDescription,
        sourceCategory: mapped.sourceCategory,
        sourceType: mapped.sourceType,
        memo: mapped.memo,
        balanceCents: null,
      };
      const list = byAccount.get(smrtAccount) ?? [];
      list.push(txn);
      byAccount.set(smrtAccount, list);
    } catch (err) {
      errors.push({
        rowNumber: counter,
        message: err instanceof Error ? err.message : String(err),
        raw: { plaid_transaction_id: p.transaction_id },
      });
    }
  }

  return { byAccount, unmapped, errors, cursor: cursor ?? '' };
}

/**
 * The bare TransactionDataSource implementation. fetch() returns the
 * FLAT list of transactions across every linked account on the item;
 * the route handler uses fetchPlaidItemTransactions directly when it
 * needs the by-account split for persisting to multiple accounts.
 */
export const plaidSource: TransactionDataSource = {
  id: 'plaid',
  name: 'Plaid',
  fullyLocal: false,
  configKeys: ['PLAID_ENABLED', 'PLAID_CLIENT_ID', 'PLAID_SECRET', 'PLAID_ENV'],
  async fetch(ctx) {
    const c = ctx as PlaidDataSourceContext;
    const result = await fetchPlaidItemTransactions(c);
    const flat: ParsedTransaction[] = [];
    for (const list of result.byAccount.values()) flat.push(...list);
    return {
      formatId: 'plaid',
      formatName: 'Plaid',
      transactions: flat,
      errors: result.errors,
      cursor: result.cursor,
    };
  },
};
