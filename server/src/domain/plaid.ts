import type { PlaidConfig } from './settings.js';

/**
 * Minimal Plaid REST client (Phase 8.2).
 *
 * Hand-rolled HTTP wrapper around the small slice of the Plaid API
 * SmrtCash needs:
 *
 *   - /link/token/create               (browser link widget)
 *   - /item/public_token/exchange      (public → access token)
 *   - /accounts/get                    (account picker)
 *   - /transactions/sync               (incremental sync, cursor-based)
 *   - /item/remove                     (delete + stop billing)
 *
 * The official `plaid-node` SDK is intentionally NOT used — it pulls
 * a megabyte of generated types and Axios. We make our own typed
 * requests with the global `fetch`, which keeps the dependency
 * surface tiny for a self-hosted app.
 *
 * Every method accepts an injectable `fetch` so unit tests can mock
 * the wire calls without hitting the live Plaid API.
 */

const HOSTS: Record<PlaidConfig['environment'], string> = {
  sandbox: 'https://sandbox.plaid.com',
  development: 'https://development.plaid.com',
  production: 'https://production.plaid.com',
};

export type PlaidFailureKind =
  | 'auth_failed'
  | 'invalid_request'
  | 'rate_limited'
  | 'http_error'
  | 'transport_error';

export class PlaidError extends Error {
  constructor(
    public readonly kind: PlaidFailureKind,
    message: string,
    public readonly plaidErrorCode?: string,
  ) {
    super(message);
    this.name = 'PlaidError';
  }
}

export type FetchLike = typeof fetch;

export interface PlaidClientOptions {
  config: PlaidConfig;
  fetchImpl?: FetchLike;
  timeoutMs?: number;
}

export interface LinkTokenCreateInput {
  /** Stable per-user identifier so Plaid can de-dup re-link flows. */
  userId: string;
  clientName: string;
  /** Defaults to ['transactions']. */
  products?: string[];
  countryCodes?: string[];
  language?: string;
  /** OAuth redirect URI; required for some institutions. Omit for sandbox. */
  redirectUri?: string;
}

export interface LinkTokenCreateResult {
  link_token: string;
  expiration: string;
}

export interface ExchangePublicTokenResult {
  access_token: string;
  item_id: string;
}

export interface PlaidAccount {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
  balances: {
    available: number | null;
    current: number | null;
    iso_currency_code: string | null;
  };
}

export interface AccountsGetResult {
  accounts: PlaidAccount[];
  item: { item_id: string; institution_id: string | null };
}

export interface PlaidTxn {
  transaction_id: string;
  account_id: string;
  /** Posted-or-authorized date, YYYY-MM-DD. */
  date: string;
  /** Authorized date (when present) — typically the merchant date. */
  authorized_date: string | null;
  /** Plaid amounts are POSITIVE for outflows. We negate downstream. */
  amount: number;
  /** ISO-4217 if known. */
  iso_currency_code: string | null;
  name: string;
  merchant_name: string | null;
  category: string[] | null;
  pending: boolean;
  payment_channel: string | null;
  transaction_type: string | null;
}

export interface TransactionsSyncResult {
  added: PlaidTxn[];
  modified: PlaidTxn[];
  removed: Array<{ transaction_id: string; account_id?: string }>;
  next_cursor: string;
  has_more: boolean;
  request_id: string;
}

export class PlaidClient {
  private readonly config: PlaidConfig;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(opts: PlaidClientOptions) {
    this.config = opts.config;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 60_000;
  }

  private get baseUrl(): string {
    return HOSTS[this.config.environment];
  }

  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: this.config.clientId,
          secret: this.config.secret,
          ...body,
        }),
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: unknown;
      try {
        parsed = text ? JSON.parse(text) : {};
      } catch {
        throw new PlaidError(
          'http_error',
          `Plaid returned non-JSON body (${res.status})`,
        );
      }
      if (!res.ok) {
        const err = parsed as {
          error_code?: string;
          error_type?: string;
          error_message?: string;
        };
        const kind = mapPlaidErrorCode(err.error_code, err.error_type, res.status);
        throw new PlaidError(
          kind,
          err.error_message || `Plaid ${path} returned HTTP ${res.status}`,
          err.error_code,
        );
      }
      return parsed as T;
    } catch (err) {
      if (err instanceof PlaidError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new PlaidError(
          'transport_error',
          `Plaid request timed out after ${this.timeoutMs} ms`,
        );
      }
      throw new PlaidError(
        'transport_error',
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async linkTokenCreate(input: LinkTokenCreateInput): Promise<LinkTokenCreateResult> {
    const body: Record<string, unknown> = {
      user: { client_user_id: input.userId },
      client_name: input.clientName,
      products: input.products ?? ['transactions'],
      country_codes: input.countryCodes ?? ['US'],
      language: input.language ?? 'en',
    };
    if (input.redirectUri) body.redirect_uri = input.redirectUri;
    return this.post<LinkTokenCreateResult>('/link/token/create', body);
  }

  async exchangePublicToken(publicToken: string): Promise<ExchangePublicTokenResult> {
    return this.post<ExchangePublicTokenResult>('/item/public_token/exchange', {
      public_token: publicToken,
    });
  }

  async accountsGet(accessToken: string): Promise<AccountsGetResult> {
    return this.post<AccountsGetResult>('/accounts/get', {
      access_token: accessToken,
    });
  }

  async transactionsSync(
    accessToken: string,
    cursor: string | null,
  ): Promise<TransactionsSyncResult> {
    return this.post<TransactionsSyncResult>('/transactions/sync', {
      access_token: accessToken,
      cursor: cursor ?? '',
    });
  }

  async itemRemove(accessToken: string): Promise<{ request_id: string }> {
    return this.post<{ request_id: string }>('/item/remove', {
      access_token: accessToken,
    });
  }
}

function mapPlaidErrorCode(
  code: string | undefined,
  type: string | undefined,
  status: number,
): PlaidFailureKind {
  if (code === 'INVALID_CLIENT_ID' || code === 'INVALID_SECRET' || code === 'INVALID_API_KEYS')
    return 'auth_failed';
  if (code === 'INVALID_ACCESS_TOKEN' || code === 'ITEM_LOGIN_REQUIRED')
    return 'auth_failed';
  if (type === 'INVALID_REQUEST' || status === 400) return 'invalid_request';
  if (status === 429) return 'rate_limited';
  if (status >= 500) return 'http_error';
  return 'http_error';
}

/**
 * Map a Plaid /transactions/sync response into SmrtCash's
 * ParsedTransaction shape, scoped to a single SmrtCash account.
 *
 * Plaid's amount sign convention is OPPOSITE of SmrtCash's:
 *   Plaid:  +25.00 = outflow,   -25.00 = inflow (e.g. refund)
 *   Local:  -25.00 = outflow,   +25.00 = inflow
 *
 * So we negate.
 */
export interface MappedPlaidTxn {
  txnDate: string;
  postDate: string | null;
  amountCents: number;
  rawDescription: string;
  sourceCategory: string | null;
  sourceType: string | null;
  memo: string | null;
  balanceCents: null;
  plaidTransactionId: string;
  plaidAccountId: string;
  pending: boolean;
}

export function mapPlaidTransaction(p: PlaidTxn): MappedPlaidTxn {
  const amountCents = Math.round(-p.amount * 100);
  const description = (p.merchant_name ?? p.name ?? '').trim() || '(unspecified)';
  const category = p.category && p.category.length > 0 ? p.category[0]! : null;
  const memoParts: string[] = [];
  if (p.pending) memoParts.push('pending');
  if (p.payment_channel) memoParts.push(p.payment_channel);
  return {
    txnDate: p.date,
    postDate: p.authorized_date ?? p.date,
    amountCents,
    rawDescription: description,
    sourceCategory: category,
    sourceType: p.transaction_type ?? null,
    memo: memoParts.length > 0 ? memoParts.join(' | ') : null,
    balanceCents: null,
    plaidTransactionId: p.transaction_id,
    plaidAccountId: p.account_id,
    pending: p.pending,
  };
}
