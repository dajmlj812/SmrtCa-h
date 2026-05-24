import { withTransaction } from '../db/pool.js';
import { parseImportFile } from './parse.js';
import {
  buildGenericFormat,
  detectFormat,
  getFormat,
  type ColumnMapping,
  type ImportFormat,
} from './formats.js';
import { assignDedupHashes } from './dedup.js';
import { tryParseStructured } from './structured.js';
import type { ParsedTransaction, RawRow, RowError } from './types.js';

export class ImportError extends Error {}

export interface ImportPreview {
  detectedFormatId: string | null;
  detectedFormatName: string | null;
  suggestedAccountType: string | null;
  headers: string[];
  totalRows: number;
  parsedCount: number;
  errorCount: number;
  sample: ParsedTransaction[]; // first few successfully parsed rows
  errors: RowError[]; // first few failed rows
}

export interface ImportResult {
  batchId: string;
  formatId: string;
  totalRows: number;
  importedCount: number;
  skippedCount: number; // duplicates skipped via ON CONFLICT
  errorCount: number;
  errors: RowError[];
}

interface MapResult {
  transactions: ParsedTransaction[];
  errors: RowError[];
}

function resolveFormat(
  headers: string[],
  formatId?: string,
  mapping?: ColumnMapping,
): ImportFormat | undefined {
  if (mapping) return buildGenericFormat(mapping);
  if (formatId) return getFormat(formatId);
  return detectFormat(headers);
}

/** Map every raw row, collecting per-row errors instead of aborting. */
function mapRows(rows: RawRow[], format: ImportFormat): MapResult {
  const transactions: ParsedTransaction[] = [];
  const errors: RowError[] = [];
  rows.forEach((row, index) => {
    try {
      transactions.push(format.mapRow(row));
    } catch (err) {
      errors.push({
        rowNumber: index + 1,
        message: err instanceof Error ? err.message : String(err),
        raw: row,
      });
    }
  });
  return { transactions, errors };
}

export async function previewImport(
  filename: string,
  buffer: Buffer,
  formatId?: string,
  mapping?: ColumnMapping,
): Promise<ImportPreview> {
  // OFX/QFX/QIF go through their own typed parsers and skip the
  // CSV/XLSX headers + column-mapping path. A user-supplied mapping
  // doesn't apply here.
  const structured = tryParseStructured(filename, buffer);
  if (structured) {
    return {
      detectedFormatId: structured.formatId,
      detectedFormatName: structured.formatName,
      suggestedAccountType: structured.suggestedAccountType,
      headers: [],
      totalRows: structured.transactions.length + structured.errors.length,
      parsedCount: structured.transactions.length,
      errorCount: structured.errors.length,
      sample: structured.transactions.slice(0, 10),
      errors: structured.errors.slice(0, 10),
    };
  }

  const { headers, rows } = await parseImportFile(filename, buffer);
  const format = resolveFormat(headers, formatId, mapping);

  if (!format) {
    return {
      detectedFormatId: null,
      detectedFormatName: null,
      suggestedAccountType: null,
      headers,
      totalRows: rows.length,
      parsedCount: 0,
      errorCount: 0,
      sample: [],
      errors: [],
    };
  }

  const { transactions, errors } = mapRows(rows, format);
  return {
    detectedFormatId: format.id,
    detectedFormatName: format.name,
    suggestedAccountType: format.suggestedAccountType,
    headers,
    totalRows: rows.length,
    parsedCount: transactions.length,
    errorCount: errors.length,
    sample: transactions.slice(0, 10),
    errors: errors.slice(0, 10),
  };
}

export async function commitImport(
  accountId: string,
  filename: string,
  buffer: Buffer,
  formatId?: string,
  mapping?: ColumnMapping,
): Promise<ImportResult> {
  const structured = tryParseStructured(filename, buffer);
  if (structured) {
    return persistBatch(
      accountId,
      filename,
      structured.formatId,
      structured.transactions,
      structured.errors,
    );
  }

  const { headers, rows } = await parseImportFile(filename, buffer);
  const format = resolveFormat(headers, formatId, mapping);
  if (!format) {
    throw new ImportError(
      'Could not detect a known file format. Provide a column mapping.',
    );
  }

  const { transactions, errors } = mapRows(rows, format);
  return persistBatch(accountId, filename, format.id, transactions, errors, rows.length);
}

/**
 * Shared persistence path. Both the CSV/XLSX pipeline and the
 * structured (OFX/QFX/QIF) pipeline hand off to this once they have a
 * list of typed transactions plus per-row errors. `totalRows` lets
 * the CSV path report the original row count; the structured path
 * just uses transactions + errors.
 */
export async function persistBatch(
  accountId: string,
  filename: string,
  formatId: string,
  transactions: ParsedTransaction[],
  errors: RowError[],
  totalRows?: number,
): Promise<ImportResult> {
  const hashes = assignDedupHashes(transactions);
  const rowCount = totalRows ?? transactions.length + errors.length;

  const result = await withTransaction(async (client) => {
    const account = await client.query<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM accounts WHERE id = $1',
      [accountId],
    );
    if (account.rowCount === 0) {
      throw new ImportError(`Account ${accountId} not found`);
    }
    const tenantId = account.rows[0]!.tenant_id;

    const batch = await client.query<{ id: string }>(
      `INSERT INTO import_batches (account_id, filename, format_id, row_count)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [accountId, filename, formatId, rowCount],
    );
    const batchId = batch.rows[0]!.id;

    const insertedIds: string[] = [];
    for (let i = 0; i < transactions.length; i++) {
      const t = transactions[i]!;
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO transactions (
           account_id, import_batch_id, txn_date, post_date, amount_cents,
           raw_description, source_category, source_type, memo, balance_cents,
           dedup_hash
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (account_id, dedup_hash) DO NOTHING
         RETURNING id`,
        [
          accountId,
          batchId,
          t.txnDate,
          t.postDate,
          t.amountCents,
          t.rawDescription,
          t.sourceCategory,
          t.sourceType,
          t.memo,
          t.balanceCents,
          hashes[i],
        ],
      );
      if (inserted.rowCount && inserted.rowCount > 0) {
        insertedIds.push(inserted.rows[0]!.id);
      }
    }
    const importedCount = insertedIds.length;
    const skippedCount = transactions.length - importedCount;

    await client.query(
      `UPDATE import_batches
         SET imported_count = $1, skipped_count = $2, error_count = $3
       WHERE id = $4`,
      [importedCount, skippedCount, errors.length, batchId],
    );

    return {
      tenantId,
      insertedIds,
      payload: {
        batchId,
        formatId,
        totalRows: rowCount,
        importedCount,
        skippedCount,
        errorCount: errors.length,
        errors: errors.slice(0, 25),
      },
    };
  });

  // Post-commit hooks. Both are awaited (not fire-and-forget) so a
  // failure surfaces immediately and concurrent vitest workers can't
  // race each other's `resetDb()`s. Both are wrapped in try/catch so
  // a hook failure cannot break the import itself — the user wanted
  // the rows persisted, and the user can re-run either pass manually.
  if (result.tenantId && result.insertedIds.length > 0) {
    // 0.13.6: apply this tenant's enabled normalization rules to
    // the freshly-inserted rows BEFORE the anomaly scan. The scan
    // benefits from the cleaned merchant names — "Starbucks" vs.
    // "SQ *STARBUCKS #12 SEATTLE WA" both group correctly under
    // the unusual-at-merchant detector once the rule has fired.
    try {
      const { applyRulesToTransactions } = await import(
        '../domain/rules-applier.js'
      );
      await applyRulesToTransactions(result.tenantId, result.insertedIds);
    } catch {
      /* swallow — import wins; user can /api/normalization-rules/apply */
    }

    // 0.13.2: anomaly scan over the freshly-imported rows.
    // ANOMALY_ENABLED gates the work server-side.
    try {
      const { scanTransactionsForAnomalies } = await import(
        '../domain/anomaly-detector.js'
      );
      await scanTransactionsForAnomalies(result.tenantId, result.insertedIds);
    } catch {
      /* swallow — import wins; user can /api/anomalies/scan manually */
    }
  }

  return result.payload;
}
