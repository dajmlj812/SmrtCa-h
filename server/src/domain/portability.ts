import { execFile } from 'node:child_process';
import { mkdir, writeFile, rm, cp, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { pool, query } from '../db/pool.js';

/**
 * Backlog item — data portability (0.13.0).
 *
 * Produces a per-tenant export bundle with structured JSON for every
 * tenant-scoped row plus a copy of all attachments owned by the
 * tenant's transactions. Distinct from the server-wide
 * `npm run backup` (which is a Postgres custom-format dump): this
 * format is **portable** — JSON tables a human can read and an
 * external script can re-import.
 *
 * Secrets are stripped: encrypted OFX-DC credentials and Plaid
 * access tokens are NOT included. Connection metadata is kept so
 * the user has a record of which banks they were linked to.
 *
 * Layout of the resulting tarball:
 *
 *     tenant.json            — manifest + all table rows
 *     attachments/<id>-name  — one file per transaction attachment
 *
 * Returned to the caller as a temp file path; caller is responsible
 * for serving + invoking `cleanup()` after the stream ends.
 */

const exec = promisify(execFile);

export interface PortabilityExportResult {
  archivePath: string;
  suggestedFilename: string;
  bytes: number;
  counts: Record<string, number>;
  cleanup: () => Promise<void>;
}

interface TableSpec {
  name: string;
  sql: string;
}

/**
 * One row per tenant-scoped table. Order doesn't affect the bundle
 * (the JSON has named keys) but matches a sensible import order for
 * documentation.
 */
const TABLES: TableSpec[] = [
  {
    name: 'tenant',
    sql: `SELECT id, name, slug, created_at::text FROM tenants WHERE id = $1`,
  },
  {
    name: 'memberships',
    sql: `SELECT id, user_id, role, created_at::text FROM memberships WHERE tenant_id = $1`,
  },
  {
    name: 'categories',
    sql: `SELECT id, name, parent_id, created_at::text FROM categories WHERE tenant_id = $1`,
  },
  {
    name: 'accounts',
    sql: `SELECT id, name, institution, type, last4, currency, opening_balance_cents,
                 opening_balance_date::text, created_at::text
            FROM accounts WHERE tenant_id = $1`,
  },
  {
    name: 'transactions',
    sql: `SELECT t.id, t.account_id, t.txn_date::text, t.post_date::text,
                 t.amount_cents, t.raw_description, t.normalized_merchant,
                 t.category_id, t.normalization_status, t.normalization_note,
                 t.transfer_group_id, t.source_category, t.source_type,
                 t.memo, t.balance_cents, t.dedup_hash, t.created_at::text
            FROM transactions t
            JOIN accounts a ON a.id = t.account_id
           WHERE a.tenant_id = $1`,
  },
  {
    name: 'transaction_splits',
    sql: `SELECT ts.id, ts.transaction_id, ts.category_id, ts.amount_cents,
                 ts.memo, ts.created_at::text
            FROM transaction_splits ts
            JOIN transactions t ON t.id = ts.transaction_id
            JOIN accounts a ON a.id = t.account_id
           WHERE a.tenant_id = $1`,
  },
  {
    name: 'split_participants',
    sql: `SELECT id, name, email, archived, created_at::text
            FROM split_participants WHERE tenant_id = $1`,
  },
  {
    name: 'transaction_shares',
    sql: `SELECT ts.id, ts.transaction_id, ts.participant_id, ts.share_cents,
                 ts.settled, ts.settled_at::text, ts.note, ts.created_at::text
            FROM transaction_shares ts
            JOIN split_participants p ON p.id = ts.participant_id
           WHERE p.tenant_id = $1`,
  },
  {
    name: 'budgets',
    sql: `SELECT id, period_month::text, category_id, amount_cents, created_at::text
            FROM budgets WHERE tenant_id = $1`,
  },
  {
    name: 'savings_goals',
    sql: `SELECT id, name, target_amount_cents, current_amount_cents,
                 target_date::text, created_at::text
            FROM savings_goals WHERE tenant_id = $1`,
  },
  {
    name: 'bills',
    sql: `SELECT id, name, amount_cents, frequency, next_due_date::text,
                 category_id, account_id, active, created_at::text
            FROM bills WHERE tenant_id = $1`,
  },
  {
    name: 'recurring_income',
    sql: `SELECT id, name, amount_cents, frequency, next_expected_date::text,
                 account_id, active, created_at::text
            FROM recurring_income WHERE tenant_id = $1`,
  },
  {
    name: 'holdings',
    sql: `SELECT id, account_id, symbol, name, quantity::text, cost_basis_cents,
                 last_price_cents, last_price_date::text, created_at::text
            FROM holdings WHERE tenant_id = $1`,
  },
  {
    name: 'vehicles',
    sql: `SELECT id, name, fuel_type, mpg::text, kwh_per_mile::text,
                 electricity_rate_cents_per_kwh, weekly_avg_miles::text,
                 active, created_at::text
            FROM vehicles WHERE tenant_id = $1`,
  },
  {
    name: 'commute_routes',
    sql: `SELECT id, name, distance_miles::text, toll_per_crossing_cents,
                 active, created_at::text
            FROM commute_routes WHERE tenant_id = $1`,
  },
  {
    name: 'retirement_projections',
    sql: `SELECT id, name, starting_balance_cents, monthly_contribution_cents,
                 annual_return_pct::text, annual_inflation_pct::text, target_year,
                 target_amount_cents, horizon_years,
                 created_at::text, updated_at::text
            FROM retirement_projections WHERE tenant_id = $1`,
  },
  {
    name: 'ofx_dc_connections',
    // Strip the encrypted credential blobs — secrets do not travel.
    sql: `SELECT id, account_id, name, ofx_url, ofx_org, ofx_fid,
                 ofx_app_id, ofx_app_version, intu_bid,
                 bank_acct_id, bank_acct_type, bank_id,
                 last_sync_at::text, last_sync_status,
                 enabled, created_at::text
            FROM ofx_dc_connections WHERE tenant_id = $1`,
  },
  {
    name: 'plaid_items',
    // Strip access_token_encrypted — it's worthless without the key
    // anyway, and Plaid items don't migrate between accounts.
    sql: `SELECT id, plaid_item_id, institution_id, institution_name,
                 status, last_sync_at::text, last_sync_status,
                 created_at::text
            FROM plaid_items WHERE tenant_id = $1`,
  },
  {
    name: 'plaid_account_links',
    sql: `SELECT l.id, l.plaid_item_id, l.plaid_account_id, l.account_id,
                 l.plaid_account_name, l.plaid_account_mask,
                 l.plaid_account_type, l.plaid_account_subtype,
                 l.created_at::text
            FROM plaid_account_links l
            JOIN plaid_items i ON i.id = l.plaid_item_id
           WHERE i.tenant_id = $1`,
  },
  {
    name: 'normalization_rules',
    sql: `SELECT id, pattern, normalized_merchant, category_id, source,
                 match_count, last_applied_at::text, created_at::text
            FROM normalization_rules WHERE tenant_id = $1`,
  },
];

interface AttachmentRow {
  id: string;
  transaction_id: string;
  storage_path: string;
  filename: string;
  mime_type: string | null;
  byte_size: number | null;
  encryption_version: number;
}

export async function exportTenantData(
  tenantId: string,
): Promise<PortabilityExportResult> {
  // Single workDir under tmpdir(). Caller invokes cleanup() to wipe
  // both this directory and the generated archive.
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const workDir = join(tmpdir(), `smrtcash-export-${stamp}`);
  await mkdir(workDir, { recursive: true });
  const attachmentsRoot = join(workDir, 'attachments');
  await mkdir(attachmentsRoot, { recursive: true });

  const counts: Record<string, number> = {};
  const bundle: Record<string, unknown> = {};

  for (const t of TABLES) {
    const r = await pool.query(t.sql, [tenantId]);
    bundle[t.name] = t.name === 'tenant' ? (r.rows[0] ?? null) : r.rows;
    counts[t.name] = r.rowCount ?? r.rows.length;
  }

  // Attachments — copy raw files into ./attachments. Files copied
  // VERBATIM (still encrypted if encryption_version=1) so a re-import
  // works as long as ATTACHMENT_ENCRYPTION_KEY is the same.
  const attachments = await query<AttachmentRow>(
    `SELECT at.id, at.transaction_id, at.storage_path, at.filename,
            at.mime_type, at.byte_size, at.encryption_version
       FROM attachments at
       JOIN transactions t ON t.id = at.transaction_id
       JOIN accounts a ON a.id = t.account_id
      WHERE a.tenant_id = $1`,
    [tenantId],
  );
  const attachmentEntries: unknown[] = [];
  for (const a of attachments.rows) {
    const src = resolve(a.storage_path);
    if (!existsSync(src)) {
      attachmentEntries.push({ ...a, missing: true });
      continue;
    }
    const safeName = (a.filename || 'file').replace(/[\\/]/g, '_');
    const destName = `${a.id}-${safeName}`;
    const dest = join(attachmentsRoot, destName);
    await cp(src, dest);
    attachmentEntries.push({
      ...a,
      bundled_path: `attachments/${destName}`,
    });
  }
  bundle.attachments = attachmentEntries;
  counts.attachments = attachmentEntries.length;

  const manifest = {
    schema_version: 1,
    smrtcash_version: '0.13.0',
    exported_at: new Date().toISOString(),
    tenant_id: tenantId,
    counts,
    notes: [
      'Encrypted credential blobs (OFX-DC, Plaid) are stripped — secrets do not travel.',
      'Attachment files are bundled as-is (still encrypted at rest if v1).',
      'Re-import requires the same ATTACHMENT_ENCRYPTION_KEY to read attachments.',
    ],
  };

  await writeFile(
    join(workDir, 'tenant.json'),
    JSON.stringify({ manifest, ...bundle }, null, 2),
    'utf-8',
  );

  // Bundle as tar.gz. The image ships `tar` because backup-runner
  // already uses it. `--force-local` tells GNU tar not to interpret
  // a Windows path's drive-letter colon (`C:\...`) as an SSH-style
  // host:path — without it, dev runs on Windows fail with
  // "Cannot execute remote shell". Safe on Linux (no-op when no
  // colon is present).
  const archivePath = `${workDir}.tar.gz`;
  await exec('tar', [
    '--force-local',
    '-czf', archivePath,
    '-C', dirname(workDir), basename(workDir),
  ]);
  const archiveStat = await stat(archivePath);

  return {
    archivePath,
    suggestedFilename: `smrtcash-${tenantId.slice(0, 8)}-${stamp}.tar.gz`,
    bytes: archiveStat.size,
    counts,
    cleanup: async () => {
      try {
        await rm(workDir, { recursive: true, force: true });
      } catch {
        /* tolerate */
      }
      try {
        await rm(archivePath, { force: true });
      } catch {
        /* tolerate */
      }
    },
  };
}

// Exported for tests.
export const __testing = { TABLES };
