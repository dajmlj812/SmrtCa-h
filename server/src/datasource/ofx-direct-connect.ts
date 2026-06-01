import { pool } from '../db/pool.js';
import { decryptString } from '../domain/crypto.js';
import {
  fetchOfxStatement,
  OfxDcError,
  type OfxDcConnection,
  type PostOfxOptions,
} from '../domain/ofx-dc.js';
import type {
  DataSourceContext,
  DataSourceFetchResult,
  TransactionDataSource,
} from './types.js';

/**
 * Loads a stored OFX-DC connection row by id, decrypts its
 * credentials, and returns it as a runtime `OfxDcConnection`.
 */
export interface StoredOfxDcRow {
  id: string;
  account_id: string;
  ofx_url: string;
  ofx_org: string;
  ofx_fid: string;
  ofx_app_id: string;
  ofx_app_version: string;
  intu_bid: string | null;
  username_encrypted: Buffer;
  password_encrypted: Buffer;
  bank_acct_id: string;
  bank_acct_type:
    | 'CHECKING'
    | 'SAVINGS'
    | 'MONEYMRKT'
    | 'CREDITLINE'
    | 'CREDITCARD';
  bank_id: string | null;
  last_sync_at: Date | null;
}

export async function loadStoredConnection(
  connectionId: string,
  tenantId: string,
): Promise<StoredOfxDcRow | null> {
  const r = await pool.query<StoredOfxDcRow>(
    `SELECT id, account_id, ofx_url, ofx_org, ofx_fid, ofx_app_id,
            ofx_app_version, intu_bid, username_encrypted,
            password_encrypted, bank_acct_id, bank_acct_type, bank_id,
            last_sync_at
       FROM ofx_dc_connections
      WHERE id = $1 AND tenant_id = $2`,
    [connectionId, tenantId],
  );
  return r.rows[0] ?? null;
}

export function storedRowToConnection(row: StoredOfxDcRow): OfxDcConnection {
  return {
    ofxUrl: row.ofx_url,
    ofxOrg: row.ofx_org,
    ofxFid: row.ofx_fid,
    ofxAppId: row.ofx_app_id,
    ofxAppVersion: row.ofx_app_version,
    intuBid: row.intu_bid,
    username: decryptString(row.username_encrypted),
    password: decryptString(row.password_encrypted),
    bankAcctId: row.bank_acct_id,
    bankAcctType: row.bank_acct_type,
    bankId: row.bank_id,
  };
}

export interface OfxDirectConnectContext extends DataSourceContext {
  connectionId: string;
  tenantId: string;
  /** Optional override window. Default: max(last_sync_at - 7d, 90d ago) → now. */
  startDate?: Date;
  endDate?: Date;
  fetchImpl?: PostOfxOptions['fetchImpl'];
  /**
   * Optional override for the fetch-time SSRF guard. Production leaves
   * it unset (the real DNS-resolving guard runs); tests inject a
   * passthrough so they can exercise the route/sync paths offline with
   * synthetic bank hostnames. Travels alongside fetchImpl through the
   * same injection seam.
   */
  safetyCheck?: PostOfxOptions['safetyCheck'];
}

/**
 * Phase 8.1's first concrete data source. Loads a stored connection,
 * runs the OFX-DC protocol against the bank, returns the parsed
 * transactions plus an updated cursor (= the fetch end date as an
 * ISO string).
 *
 * Does NOT persist anything — the route handler decides whether to
 * call `persistBatch()` (sync) or just inspect the result (test
 * connection).
 */
export const ofxDirectConnectSource: TransactionDataSource = {
  id: 'ofx_dc',
  name: 'OFX Direct Connect',
  fullyLocal: false,
  configKeys: [],
  async fetch(ctx: DataSourceContext): Promise<DataSourceFetchResult> {
    const c = ctx as OfxDirectConnectContext;
    if (!c.connectionId || !c.tenantId) {
      throw new Error(
        'ofxDirectConnectSource.fetch requires connectionId + tenantId',
      );
    }
    const row = await loadStoredConnection(c.connectionId, c.tenantId);
    if (!row) throw new Error(`OFX-DC connection ${c.connectionId} not found`);

    const now = new Date();
    const endDate = c.endDate ?? now;
    const startDate = c.startDate ?? computeIncrementalStart(row.last_sync_at, now);
    const conn = storedRowToConnection(row);

    try {
      const opts: PostOfxOptions = {};
      if (c.fetchImpl) opts.fetchImpl = c.fetchImpl;
      if (c.safetyCheck) opts.safetyCheck = c.safetyCheck;
      const result = await fetchOfxStatement(
        { connection: conn, startDate, endDate },
        opts,
      );
      return {
        formatId: result.formatId,
        formatName: result.formatName,
        transactions: result.transactions,
        errors: result.errors,
        cursor: endDate.toISOString(),
      };
    } catch (err) {
      // Re-throw OfxDcError so routes can map kind -> last_sync_status.
      if (err instanceof OfxDcError) throw err;
      throw new OfxDcError(
        'transport_error',
        err instanceof Error ? err.message : String(err),
      );
    }
  },
};

/**
 * Default fetch window:
 *   - first sync ever      -> last 90 days
 *   - subsequent sync      -> from (last_sync_at - 7 days) to handle
 *                             late-clearing items the bank backdates
 */
export function computeIncrementalStart(lastSyncAt: Date | null, now: Date): Date {
  if (!lastSyncAt) {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 90);
    return d;
  }
  const d = new Date(lastSyncAt);
  d.setUTCDate(d.getUTCDate() - 7);
  return d;
}
