import type { ParsedTransaction, RowError } from '../import/types.js';

/**
 * Phase 8 — pluggable transaction data-source layer.
 *
 * Every way of getting transactions into SmrtCash implements this
 * interface: 8.0 file imports (OFX/QFX/QIF), 8.1 OFX Direct Connect,
 * 8.2 Plaid, 8.3 scheduled background sync. Same pattern as the
 * Phase 2 TransactionNormalizer and Phase 3 OcrProvider — the
 * existing import pipeline calls fetch() and feeds the result
 * through the same dedup + persistence path.
 */
export interface DataSourceContext {
  accountId: string;
  /** Optional cursor returned by a previous fetch (Direct Connect / Plaid). */
  cursor?: string | null;
  /** Optional buffer (file-import data sources). */
  fileBuffer?: Buffer;
  filename?: string;
}

export interface DataSourceFetchResult {
  formatId: string;
  formatName: string;
  transactions: ParsedTransaction[];
  errors: RowError[];
  /** Opaque cursor a data source can return for incremental sync. */
  cursor?: string | null;
}

export interface TransactionDataSource {
  /** Stable identifier — referenced by routes, settings, audit log. */
  id: string;
  /** Human-readable name shown in the GUI. */
  name: string;
  /** True if this source can be used without internet access. */
  fullyLocal: boolean;
  /**
   * app_settings keys this source reads (e.g. Plaid client id, OFX-DC
   * server URL). Used by the super-admin UI to show what needs to be
   * configured before the source can run.
   */
  configKeys: readonly string[];
  fetch(ctx: DataSourceContext): Promise<DataSourceFetchResult>;
}
