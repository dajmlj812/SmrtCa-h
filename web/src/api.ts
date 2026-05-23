export interface Account {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  last4: string | null;
  currency: string;
  created_at: string;
  balance_cents: number;
  /** Only populated for investment accounts (sum of quantity × last_price). */
  holdings_value_cents?: number;
  transaction_count: number;
  opening_balance_cents: number;
  opening_balance_date: string | null;
  /** 0.10.0: balance converted to the global DISPLAY_CURRENCY. */
  display_currency?: string;
  balance_display_cents?: number;
  /** False when no FX pair is known and the converted value passes through. */
  rate_known?: boolean;
}

export interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  source: 'manual' | 'open-er-api' | 'frankfurter';
  fetched_at: string;
}

export interface RetirementProjection {
  id: string;
  tenant_id: string | null;
  name: string;
  starting_balance_cents: number;
  monthly_contribution_cents: number;
  annual_return_pct: number;
  annual_inflation_pct: number;
  target_year: number | null;
  target_amount_cents: number | null;
  horizon_years: number;
  created_at: string;
  updated_at: string;
}

export type OfxDcAccountType =
  | 'CHECKING'
  | 'SAVINGS'
  | 'MONEYMRKT'
  | 'CREDITLINE'
  | 'CREDITCARD';

export interface OfxDcConnection {
  id: string;
  account_id: string;
  name: string;
  ofx_url: string;
  ofx_org: string;
  ofx_fid: string;
  ofx_app_id: string;
  ofx_app_version: string;
  intu_bid: string | null;
  bank_acct_id: string;
  bank_acct_type: OfxDcAccountType;
  bank_id: string | null;
  enabled: boolean;
  last_sync_at: string | null;
  last_sync_status:
    | 'never'
    | 'ok'
    | 'auth_failed'
    | 'http_error'
    | 'parse_error'
    | 'transport_error';
  last_sync_error: string | null;
  last_sync_imported: number | null;
  last_sync_skipped: number | null;
}

export interface OfxDcConnectionInput {
  accountId: string;
  name: string;
  ofxUrl: string;
  ofxOrg: string;
  ofxFid: string;
  ofxAppId?: string;
  ofxAppVersion?: string;
  intuBid?: string | null;
  username?: string;
  password?: string;
  bankAcctId: string;
  bankAcctType: OfxDcAccountType;
  bankId?: string | null;
  enabled?: boolean;
}

export interface OfxDcActionResult {
  ok: boolean;
  kind?: string;
  error?: string;
  parsedCount?: number;
  errorCount?: number;
  importedCount?: number;
  skippedCount?: number;
}

export interface ProjectionSeries {
  name: string;
  target_year: number | null;
  target_amount_cents: number | null;
  series: Array<{ year: number; nominal_cents: number; real_cents: number }>;
}

export type VehicleFuelType =
  | 'regular'
  | 'midgrade'
  | 'premium'
  | 'diesel'
  | 'electric';

export interface Vehicle {
  id: string;
  name: string;
  fuel_type: VehicleFuelType;
  mpg: number | null;
  kwh_per_mile: number | null;
  electricity_rate_cents_per_kwh: number | null;
  weekly_avg_miles: number;
  active: boolean;
  created_at: string;
}

export interface RouteAssignment {
  id: string;
  route_id: string;
  vehicle_id: string;
  vehicle_name?: string;
  crossings_per_week: number;
}

export interface CommuteRoute {
  id: string;
  name: string;
  distance_miles: number;
  toll_per_crossing_cents: number | null;
  active: boolean;
  created_at: string;
  assignments: RouteAssignment[];
}

export interface AiModelOption {
  id: string;
  label: string;
  recommended: boolean;
  note: string;
}

export interface FuelPrice {
  fuel_type: 'regular' | 'midgrade' | 'premium' | 'diesel';
  price_cents_per_gallon: number;
  source: 'eia' | 'manual';
  fetched_at: string;
}

export interface WizardSavingsSuggestions {
  goalRequiredCents: number;
  pctIncomeCents: number;
  pctLeftoverCents: number;
  maxCents: number;
}

export interface WizardPeriodPreview {
  index: number;
  start: string;
  end: string;
  days: number;
  income: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  bills: Array<{ id: string; name: string; amount_cents: number; date: string }>;
  groceriesCents: number;
  fuelCents: number;
  tollsCents: number;
  miscCents: number;
  miscNote: string;
  savingsCents: number;
  savingsSuggestions: WizardSavingsSuggestions;
  flexCents: number;
}

export interface AppSetting {
  key: string;
  label: string;
  is_secret: boolean;
  restart_required: boolean;
  display_value: string;
  configured_in_gui: boolean;
  env_fallback_present: boolean;
  updated_at: string | null;
}

export interface WizardPreview {
  periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  anchor: string;
  count: number;
  groceriesWeeklyMedianCents: number;
  fuelWeeklyCents: number;
  tollsWeeklyCents: number;
  savingsIncomePct: number;
  savingsLeftoverPct: number;
  periods: WizardPeriodPreview[];
}

export interface Holding {
  id: string;
  account_id: string;
  symbol: string | null;
  name: string;
  quantity: number;
  cost_basis_cents: number;
  last_price_cents: number;
  last_price_date: string | null;
  market_value_cents: number;
  unrealized_gain_cents: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  account_id: string;
  txn_date: string;
  post_date: string | null;
  amount_cents: number;
  raw_description: string;
  source_category: string | null;
  source_type: string | null;
  memo: string | null;
  balance_cents: number | null;
  normalized_merchant: string | null;
  category_id: string | null;
  normalization_status: string;
  normalization_note?: string | null;
  transfer_group_id: string | null;
  running_balance_cents: number | null;
  account_name: string;
  category_name: string | null;
  attachment_count?: number;
  created_at: string;
}

export interface TransferLeg {
  id: string;
  account_id: string;
  account_name: string;
  txn_date: string;
  amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
}

export interface Transfer {
  group_id: string;
  transactions: TransferLeg[];
}

export interface DetectTransfersSummary {
  scanned: number;
  paired: number;
  pairs: Array<{ groupId: string; aId: string; bId: string; dateDiffDays: number }>;
}

export interface SpendingByCategoryRow {
  category_id: string | null;
  category_name: string | null;
  parent_id: string | null;
  parent_name: string | null;
  total_cents: number;
  transaction_count: number;
}

export interface IncomeExpenseRow {
  month: string;
  income_cents: number;
  expense_cents: number;
}

export interface NetWorthRow {
  month: string;
  net_worth_cents: number;
}

// ── Phase 6 types ─────────────────────────────────────────
export type BudgetPeriodType =
  | 'weekly'
  | 'biweekly'
  | 'semimonthly'
  | 'monthly'
  | 'custom';

export interface Budget {
  id: string;
  period_month: string;
  period_type: BudgetPeriodType;
  period_end: string | null;
  category_id: string | null;
  category_name: string | null;
  parent_id: string | null;
  amount_cents: number;
  created_at: string;
}

export interface BudgetVsActualRow {
  id: string;
  category_id: string | null;
  category_name: string | null;
  period_type: BudgetPeriodType;
  period_start: string;
  period_end: string;
  budgeted_cents: number;
  actual_cents: number;
}

export interface NormalizationRule {
  id: string;
  pattern: string;
  normalized_merchant: string | null;
  category_id: string | null;
  source: 'manual' | 'ai';
  match_count: number;
  last_applied_at: string | null;
  created_at: string;
}

export interface TransactionSplit {
  id: string;
  transaction_id: string;
  category_id: string | null;
  category_name?: string | null;
  amount_cents: number;
  memo: string | null;
  created_at: string;
}

export interface RecurringSuggestion {
  id: string;
  kind: 'bill' | 'income';
  name: string;
  normalized_key: string;
  amount_cents: number;
  detected_frequency:
    | 'weekly'
    | 'biweekly'
    | 'semimonthly'
    | 'monthly'
    | 'yearly'
    | 'one-time'
    | 'unknown';
  sample_txn_ids: string[];
  confidence: number;
  status: 'pending' | 'confirmed' | 'rejected' | 'snoozed';
  resolved_to_id: string | null;
  ai_refined: boolean;
  created_at: string;
  resolved_at: string | null;
}

export interface SavingsGoal {
  id: string;
  name: string;
  target_amount_cents: number;
  current_amount_cents: number;
  target_date: string | null;
  created_at: string;
  /** Server-computed: current / target, capped at 1. */
  progress: number;
}

export type BillFrequency =
  | 'monthly'
  | 'weekly'
  | 'biweekly'
  | 'yearly'
  | 'one-time';
export type IncomeFrequency = 'monthly' | 'weekly' | 'biweekly' | 'yearly';

export type BillReviewStatus =
  | 'active'
  | 'review'
  | 'cancel'
  | 'alter'
  | 'keep';

export interface Bill {
  id: string;
  name: string;
  amount_cents: number;
  frequency: BillFrequency;
  next_due_date: string;
  category_id: string | null;
  category_name?: string | null;
  account_id: string | null;
  active: boolean;
  review_status: BillReviewStatus;
  review_note: string | null;
  last_reviewed_at: string | null;
  created_at: string;
}

export interface RecurringIncome {
  id: string;
  name: string;
  amount_cents: number;
  frequency: IncomeFrequency;
  next_expected_date: string;
  account_id: string | null;
  active: boolean;
  created_at: string;
}

export interface Attachment {
  id: string;
  transaction_id: string;
  filename: string;
  mime_type: string;
  byte_size: number;
  created_at: string;
  extracted_amount_cents: number | null;
  extracted_date: string | null;
  extracted_merchant: string | null;
  ocr_provider: string | null;
  ocr_status: 'pending' | 'extracted' | 'failed' | 'skipped';
  ocr_note: string | null;
}

export interface UploadResult {
  attachments: Attachment[];
  errors?: string[];
}

export interface Category {
  id: string;
  name: string;
  parent_id: string | null;
  created_at: string;
  transaction_count: number;
}

export interface ImportFormat {
  id: string;
  name: string;
  suggestedAccountType: string;
}

export interface ParsedTransaction {
  txnDate: string;
  postDate: string | null;
  amountCents: number;
  rawDescription: string;
  sourceCategory: string | null;
  sourceType: string | null;
  memo: string | null;
  balanceCents: number | null;
}

export interface RowError {
  rowNumber: number;
  message: string;
}

export interface ImportPreview {
  detectedFormatId: string | null;
  detectedFormatName: string | null;
  suggestedAccountType: string | null;
  headers: string[];
  totalRows: number;
  parsedCount: number;
  errorCount: number;
  sample: ParsedTransaction[];
  errors: RowError[];
}

export interface ImportResult {
  batchId: string;
  formatId: string;
  totalRows: number;
  importedCount: number;
  skippedCount: number;
  errorCount: number;
  errors: RowError[];
}

export interface TransactionPage {
  transactions: Transaction[];
  total: number;
  limit: number;
  offset: number;
}

export interface NormalizationSummary {
  provider: string;
  processed: number;
  normalized: number;
  errors: number;
  errorDetails?: string[];
}

export interface AiStatus {
  provider: string;
}

export interface CategorySuggestion {
  id: string;
  suggested_name: string;
  status: string;
  resolved_to_category_id: string | null;
  resolved_category_name: string | null;
  created_at: string;
  resolved_at: string | null;
  transaction_count: number;
}

export interface ApproveSuggestionResult {
  suggestion: CategorySuggestion;
  category: Category;
  transactionsRelinked: number;
}

export interface MergeSuggestionResult {
  suggestion: CategorySuggestion;
  mergedTo: { id: string; name: string };
  transactionsRelinked: number;
}

export interface RejectSuggestionResult {
  suggestion: CategorySuggestion;
  transactionsCleared: number;
}

// ── Phase 7.6 types (health + backups + reports) ─────────────
export interface HealthSnapshot {
  generated_at: string;
  app: {
    app_version: string;
    node_version: string;
    uptime_seconds: number;
    pid: number;
    env: string;
    rss_bytes: number;
    heap_used_bytes: number;
    heap_total_bytes: number;
    /** V8 hard heap ceiling — use this for "how close to OOM" gauges. */
    heap_size_limit_bytes: number;
    ai_provider: string;
    ai_model: string;
  };
  db: {
    connected: boolean;
    pool_total: number;
    pool_idle: number;
    pool_waiting: number;
    size_bytes: number;
    size_pretty: string;
    table_counts: Record<string, number>;
    last_migration: string | null;
    last_migration_at: string | null;
    ping_ms: number;
  };
  storage: {
    attachments_dir: string;
    attachments_bytes: number;
    attachments_count: number;
    backups_dir: string;
    backups_bytes: number;
    backup_count: number;
  };
}

export interface MetricSample {
  ts: string;
  cpu_pct: number;
  rss_bytes: number;
  heap_used_bytes: number;
  heap_total_bytes: number;
  event_loop_mean_ms: number;
  event_loop_p99_ms: number;
  event_loop_util: number;
  req_count: number;
  req_rate: number;
  err_count: number;
  err_rate: number;
  db_query_count: number;
  db_query_rate: number;
  db_query_mean_ms: number;
  db_query_max_ms: number;
}

export interface BackupRecord {
  id: string;
  kind: 'manual' | 'scheduled';
  status: 'running' | 'success' | 'failed' | 'deleted';
  started_at: string;
  finished_at: string | null;
  path: string;
  db_bytes: number | null;
  attachments_bytes: number | null;
  total_bytes: number | null;
  error: string | null;
}

export interface BackupConfig {
  enabled: boolean;
  frequency: string;
  time: string;
  retention_days: number;
  directory: string;
  resolved_directory: string;
  secondary_directory: string;
}

export interface ReportParamDef {
  name: string;
  label: string;
  type: 'date' | 'int' | 'string';
  default?: string;
  required?: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  type: 'string' | 'date' | 'cents' | 'number' | 'pct';
}

export interface ReportDef {
  id: string;
  label: string;
  description: string;
  params: ReportParamDef[];
}

export interface ReportResult {
  columns: ReportColumn[];
  rows: Array<Record<string, unknown>>;
  total_rows: number;
  summary?: string;
}

// ── Phase 8 types (multi-tenant + multi-user + providers) ───
export interface AuthProviderDescriptor {
  id: string;
  kind: 'local' | 'oidc' | 'saml';
  displayName: string;
  enabled: boolean;
}

export interface TenantMembership {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  role: 'admin' | 'spouse' | 'child';
}

export interface MeResponse {
  user: {
    id: string;
    email: string | null;
    name: string | null;
    created_at: string;
    last_login_at: string | null;
    is_super_admin: boolean;
  };
  memberships: TenantMembership[];
  active_tenant_id: string | null;
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'spouse' | 'child';
}

export interface Member {
  user_id: string;
  email: string | null;
  name: string | null;
  role: 'admin' | 'spouse' | 'child';
  created_at: string;
  last_login_at: string | null;
}

export interface Invitation {
  id: string;
  email_hint: string | null;
  role: 'admin' | 'spouse' | 'child';
  token: string;
  expires_at: string;
  accepted_at: string | null;
  created_at: string;
}

export interface AuthProviderConfig {
  id: string;
  kind: 'oidc' | 'saml';
  slug: string;
  display_name: string;
  enabled: boolean;
  config_json: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export class AuthRequiredError extends Error {
  constructor() {
    super('Authentication required');
    this.name = 'AuthRequiredError';
  }
}

async function http<T>(url: string, init?: RequestInit): Promise<T> {
  // `credentials: 'include'` is required for the session cookie to ride
  // along on cross-origin dev (vite -> api proxy) requests.
  const res = await fetch(url, { credentials: 'include', ...init });
  if (res.status === 401) {
    throw new AuthRequiredError();
  }
  if (!res.ok) {
    let message = `Request failed (${res.status})`;
    try {
      const body = (await res.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      /* response had no JSON body */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export interface CreateAccountInput {
  name: string;
  institution?: string;
  type: string;
  last4?: string;
}

export interface UpdateAccountInput {
  name?: string;
  institution?: string | null;
  last4?: string | null;
  opening_balance_cents?: number;
  opening_balance_date?: string | null;
}

export interface UpdateTransactionInput {
  merchant?: string;
  categoryId?: string | null;
}

export interface ExportFilters {
  accountId?: string;
  search?: string;
  start?: string;
  end?: string;
}

export const api = {
  listAccounts: () =>
    http<{ accounts: Account[] }>('/api/accounts').then((r) => r.accounts),

  getAccount: (id: string) =>
    http<{ account: Account }>(`/api/accounts/${id}`).then((r) => r.account),

  createAccount: (input: CreateAccountInput) =>
    http<{ account: Account }>('/api/accounts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.account),

  updateAccount: (id: string, updates: UpdateAccountInput) =>
    http<{ account: Account }>(`/api/accounts/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).then((r) => r.account),

  deleteAccount: (id: string) =>
    http<void>(`/api/accounts/${id}`, { method: 'DELETE' }),

  listTransactions: (params: {
    accountId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    uncategorized?: boolean;
  }) => {
    const q = new URLSearchParams();
    if (params.accountId) q.set('accountId', params.accountId);
    if (params.search) q.set('search', params.search);
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.uncategorized) q.set('uncategorized', 'true');
    return http<TransactionPage>(`/api/transactions?${q.toString()}`);
  },

  updateTransaction: (id: string, updates: UpdateTransactionInput) =>
    http<{ transaction: Transaction }>(`/api/transactions/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    }).then((r) => r.transaction),

  listCategories: () =>
    http<{ categories: Category[] }>('/api/categories').then(
      (r) => r.categories,
    ),

  createCategory: (name: string) =>
    http<{ category: Category }>('/api/categories', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.category),

  updateCategory: (id: string, name: string) =>
    http<{ category: Category }>(`/api/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.category),

  deleteCategory: (id: string) =>
    http<void>(`/api/categories/${id}`, { method: 'DELETE' }),

  listFormats: () =>
    http<{ formats: ImportFormat[] }>('/api/imports/formats').then(
      (r) => r.formats,
    ),

  previewImport: (file: File, formatId?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    if (formatId) fd.append('formatId', formatId);
    return http<{ preview: ImportPreview }>('/api/imports/preview', {
      method: 'POST',
      body: fd,
    }).then((r) => r.preview);
  },

  commitImport: (file: File, accountId: string, formatId?: string) => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('accountId', accountId);
    if (formatId) fd.append('formatId', formatId);
    return http<{ result: ImportResult }>('/api/imports/commit', {
      method: 'POST',
      body: fd,
    }).then((r) => r.result);
  },

  normalize: (opts: { accountId?: string; limit?: number } = {}) =>
    http<{ summary: NormalizationSummary }>('/api/normalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => r.summary),

  aiStatus: () => http<AiStatus>('/api/ai/status'),

  listSuggestions: (status: string = 'pending') =>
    http<{ suggestions: CategorySuggestion[] }>(
      `/api/suggestions?status=${encodeURIComponent(status)}`,
    ).then((r) => r.suggestions),

  approveSuggestion: (id: string, parentId?: string | null) =>
    http<ApproveSuggestionResult>(`/api/suggestions/${id}/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parentId: parentId ?? null }),
    }),

  mergeSuggestion: (id: string, categoryId: string) =>
    http<MergeSuggestionResult>(`/api/suggestions/${id}/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ categoryId }),
    }),

  rejectSuggestion: (id: string) =>
    http<RejectSuggestionResult>(`/api/suggestions/${id}/reject`, {
      method: 'POST',
    }),

  // ── Attachments (Phase 3) ────────────────────────────────
  listAttachments: (transactionId: string) =>
    http<{ attachments: Attachment[] }>(
      `/api/transactions/${transactionId}/attachments`,
    ).then((r) => r.attachments),

  uploadAttachments: (transactionId: string, files: File[]) => {
    const fd = new FormData();
    for (const file of files) {
      fd.append('file', file, file.name);
    }
    return http<UploadResult>(
      `/api/transactions/${transactionId}/attachments`,
      { method: 'POST', body: fd },
    );
  },

  deleteAttachment: (id: string) =>
    http<void>(`/api/attachments/${id}`, { method: 'DELETE' }),

  attachmentPreviewUrl: (id: string) => `/api/attachments/${id}/preview`,
  attachmentDownloadUrl: (id: string) => `/api/attachments/${id}`,

  // ── Auth (Phase 5) ───────────────────────────────────────
  authStatus: () =>
    http<{ isSetup: boolean; authenticated: boolean }>('/api/auth/status'),

  authSetup: (input: { email: string; name?: string; password: string }) =>
    http<{ user: { id: string; created_at: string } }>('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  authLogin: (input: { email: string; password: string }) =>
    http<{ user: { id: string } }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  authProviders: () =>
    http<{ providers: AuthProviderDescriptor[] }>('/api/auth/providers').then(
      (r) => r.providers,
    ),

  authLogout: () =>
    http<void>('/api/auth/logout', { method: 'POST' }),

  authMe: () => http<MeResponse>('/api/auth/me'),

  // ── Phase 8: tenants + memberships + invitations + providers ─
  listTenants: () =>
    http<{ tenants: TenantSummary[]; active_tenant_id: string | null }>(
      '/api/tenants',
    ),

  switchTenant: (tenantId: string) =>
    http<{ active_tenant_id: string; role: string }>('/api/tenants/switch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tenantId }),
    }),

  listMembers: (tenantId: string) =>
    http<{ members: Member[] }>(`/api/tenants/${tenantId}/members`).then(
      (r) => r.members,
    ),

  removeMember: (tenantId: string, userId: string) =>
    http<void>(`/api/tenants/${tenantId}/members/${userId}`, {
      method: 'DELETE',
    }),

  listInvitations: (tenantId: string) =>
    http<{ invitations: Invitation[] }>(
      `/api/tenants/${tenantId}/invitations`,
    ).then((r) => r.invitations),

  createInvitation: (
    tenantId: string,
    input: { emailHint?: string; role: 'admin' | 'spouse' | 'child' },
  ) =>
    http<{
      invitation: Invitation;
      email: { sent: boolean; reason?: string };
    }>(`/api/tenants/${tenantId}/invitations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  revokeInvitation: (tenantId: string, invId: string) =>
    http<void>(`/api/tenants/${tenantId}/invitations/${invId}`, {
      method: 'DELETE',
    }),

  fetchInvitation: (token: string) =>
    http<{
      invitation: {
        id: string;
        tenant_id: string;
        tenant_name: string;
        email_hint: string | null;
        role: 'admin' | 'spouse' | 'child';
        expires_at: string;
      };
    }>(`/api/invitations/${encodeURIComponent(token)}`),

  acceptInvitation: (
    token: string,
    input: { email: string; name?: string; password: string },
  ) =>
    http<{ user: { id: string; email: string }; tenant_id: string }>(
      `/api/invitations/${encodeURIComponent(token)}/accept`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  listAuthProviderConfigs: () =>
    http<{
      providers: AuthProviderConfig[];
      presets: Array<{ slug: string; displayName: string; discoveryUrl: string }>;
    }>('/api/auth-provider-configs'),

  createAuthProviderConfig: (input: {
    kind: 'oidc' | 'saml';
    slug: string;
    displayName: string;
    enabled: boolean;
    config: Record<string, unknown>;
  }) =>
    http<{ id: string }>('/api/auth-provider-configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  updateAuthProviderConfig: (
    id: string,
    input: Partial<{
      displayName: string;
      enabled: boolean;
      config: Record<string, unknown>;
    }>,
  ) =>
    http<{ ok: true }>(`/api/auth-provider-configs/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  deleteAuthProviderConfig: (id: string) =>
    http<void>(`/api/auth-provider-configs/${id}`, { method: 'DELETE' }),

  // ── Phase 9: super admin + RBAC ──────────────────────────
  systemListTenants: () =>
    http<{
      tenants: Array<{
        id: string;
        name: string;
        slug: string;
        created_at: string;
        member_count: number;
        account_count: number;
        transaction_count: number;
      }>;
    }>('/api/system/tenants').then((r) => r.tenants),

  systemCreateTenant: (input: { name: string; slug: string }) =>
    http<{ tenant: { id: string; name: string; slug: string } }>(
      '/api/system/tenants',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ).then((r) => r.tenant),

  systemRenameTenant: (id: string, name: string) =>
    http<{ ok: true }>(`/api/system/tenants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }),

  systemDeleteTenant: (id: string) =>
    http<void>(`/api/system/tenants/${id}`, { method: 'DELETE' }),

  systemAdminInvite: (tenantId: string, emailHint?: string) =>
    http<{
      invitation: { id: string; token: string; expires_at: string };
    }>(`/api/system/tenants/${tenantId}/admin-invite`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailHint }),
    }).then((r) => r.invitation),

  systemListAudit: (opts: { tenantId?: string; action?: string; limit?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.tenantId) q.set('tenantId', opts.tenantId);
    if (opts.action) q.set('action', opts.action);
    if (opts.limit) q.set('limit', String(opts.limit));
    return http<{
      entries: Array<{
        id: string;
        occurred_at: string;
        tenant_id: string | null;
        actor_user_id: string | null;
        actor_kind: string;
        action: string;
        target_kind: string | null;
        target_id: string | null;
        details: Record<string, unknown>;
      }>;
    }>(`/api/system/audit?${q.toString()}`).then((r) => r.entries);
  },

  systemListUsers: () =>
    http<{
      super_admins: Array<{
        id: string;
        email: string | null;
        name: string | null;
        created_at: string;
        last_login_at: string | null;
      }>;
      tenant_user_count: number;
    }>('/api/system/users'),

  systemCreateSuperAdmin: (input: {
    email: string;
    name?: string;
    password: string;
  }) =>
    http<{ id: string }>('/api/system/users/super', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  // Child→account assignments (admin only)
  listMemberAccounts: (tenantId: string, userId: string) =>
    http<{ accounts: Array<{ account_id: string; account_name: string }> }>(
      `/api/tenants/${tenantId}/members/${userId}/accounts`,
    ).then((r) => r.accounts),

  setMemberAccounts: (tenantId: string, userId: string, accountIds: string[]) =>
    http<{ ok: true; count: number }>(
      `/api/tenants/${tenantId}/members/${userId}/accounts`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountIds }),
      },
    ),

  // ── Transfers (Phase 4) ──────────────────────────────────
  listTransfers: () =>
    http<{ transfers: Transfer[] }>('/api/transfers').then((r) => r.transfers),

  detectTransfers: (opts: { accountId?: string } = {}) =>
    http<{ summary: DetectTransfersSummary }>('/api/transfers/detect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => r.summary),

  linkTransfer: (aId: string, bId: string) =>
    http<{ groupId: string }>('/api/transfers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ aId, bId }),
    }),

  unlinkTransfer: (groupId: string) =>
    http<void>(`/api/transfers/${groupId}`, { method: 'DELETE' }),

  // ── Insights (Phase 4) ───────────────────────────────────
  spendingByCategory: (opts: {
    start?: string;
    end?: string;
    accountId?: string;
  } = {}) => {
    const q = new URLSearchParams();
    if (opts.start) q.set('start', opts.start);
    if (opts.end) q.set('end', opts.end);
    if (opts.accountId) q.set('accountId', opts.accountId);
    return http<{ start: string; end: string; rows: SpendingByCategoryRow[] }>(
      `/api/insights/spending-by-category?${q.toString()}`,
    );
  },

  incomeExpense: (opts: { months?: number; accountId?: string } = {}) => {
    const q = new URLSearchParams();
    if (opts.months) q.set('months', String(opts.months));
    if (opts.accountId) q.set('accountId', opts.accountId);
    return http<{ months: number; rows: IncomeExpenseRow[] }>(
      `/api/insights/income-expense?${q.toString()}`,
    );
  },

  netWorthOverTime: (opts: { months?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.months) q.set('months', String(opts.months));
    return http<{ months: number; rows: NetWorthRow[] }>(
      `/api/insights/net-worth-over-time?${q.toString()}`,
    );
  },

  exportTransactionsUrl: (filters: ExportFilters = {}) => {
    const q = new URLSearchParams();
    if (filters.accountId) q.set('accountId', filters.accountId);
    if (filters.search) q.set('search', filters.search);
    if (filters.start) q.set('start', filters.start);
    if (filters.end) q.set('end', filters.end);
    return `/api/transactions/export?${q.toString()}`;
  },

  // ── Budgets (Phase 6) ────────────────────────────────────
  listBudgets: (month: string) =>
    http<{ month: string; budgets: Budget[] }>(
      `/api/budgets?month=${encodeURIComponent(month)}`,
    ).then((r) => r.budgets),

  listAllBudgets: () =>
    http<{ budgets: Budget[] }>(`/api/budgets?all=1`).then((r) => r.budgets),

  upsertBudget: (input: {
    periodStart: string;
    periodType?: BudgetPeriodType;
    periodEnd?: string;
    categoryId: string | null;
    amountCents: number;
  }) =>
    http<{ budget: Budget }>('/api/budgets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.budget),

  updateBudgetAmount: (id: string, amountCents: number) =>
    http<{ budget: Budget }>(`/api/budgets/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amountCents }),
    }).then((r) => r.budget),

  deleteBudget: (id: string) =>
    http<void>(`/api/budgets/${id}`, { method: 'DELETE' }),

  copyBudgets: (fromMonth: string, toMonth: string) =>
    http<{ copied: number }>('/api/budgets/copy', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fromMonth, toMonth }),
    }),

  budgetActuals: (asOf: string) =>
    http<{
      asOf: string;
      rows: BudgetVsActualRow[];
      totals: { budgeted_cents: number; actual_cents: number };
    }>(`/api/budgets/actual?asOf=${encodeURIComponent(asOf)}`),

  // ── Goals ────────────────────────────────────────────────
  listGoals: () =>
    http<{ goals: SavingsGoal[] }>('/api/goals').then((r) => r.goals),

  createGoal: (input: {
    name: string;
    targetAmountCents: number;
    currentAmountCents?: number;
    targetDate?: string | null;
  }) =>
    http<{ goal: SavingsGoal }>('/api/goals', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.goal),

  updateGoal: (
    id: string,
    input: Partial<{
      name: string;
      targetAmountCents: number;
      currentAmountCents: number;
      targetDate: string | null;
    }>,
  ) =>
    http<{ goal: SavingsGoal }>(`/api/goals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.goal),

  deleteGoal: (id: string) =>
    http<void>(`/api/goals/${id}`, { method: 'DELETE' }),

  // ── Bills + recurring income + cash-flow ─────────────────
  listBills: (reviewStatus?: BillReviewStatus | 'queue') => {
    const q = reviewStatus ? `?reviewStatus=${encodeURIComponent(reviewStatus)}` : '';
    return http<{ bills: Bill[] }>(`/api/bills${q}`).then((r) => r.bills);
  },

  setBillReview: (
    id: string,
    input: { status: BillReviewStatus; note?: string | null },
  ) =>
    http<{ bill: Bill }>(`/api/bills/${id}/review`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.bill),

  // ── Subscription scan (Phase 7.5) ────────────────────────
  scanSubscriptions: () =>
    http<{
      ai_used: boolean;
      scanned: number;
      inserted: number;
      refined: number;
      kept: number;
      rejected: number;
      reason?: string;
    }>('/api/subscriptions/scan', { method: 'POST' }),

  listSubscriptionCandidates: () =>
    http<{ candidates: RecurringSuggestion[] }>(
      '/api/subscriptions/candidates',
    ).then((r) => r.candidates),

  createBill: (input: {
    name: string;
    amountCents: number;
    frequency: BillFrequency;
    nextDueDate: string;
    categoryId?: string;
    accountId?: string;
  }) =>
    http<{ bill: Bill }>('/api/bills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.bill),

  deleteBill: (id: string) =>
    http<void>(`/api/bills/${id}`, { method: 'DELETE' }),

  markBillPaid: (id: string) =>
    http<{ bill: Bill }>(`/api/bills/${id}/mark-paid`, { method: 'POST' }).then(
      (r) => r.bill,
    ),

  upcomingBills: (days = 30) =>
    http<{ days: number; bills: Bill[] }>(
      `/api/bills/upcoming?days=${days}`,
    ),

  listRecurringIncome: () =>
    http<{ income: RecurringIncome[] }>('/api/recurring-income').then(
      (r) => r.income,
    ),

  createRecurringIncome: (input: {
    name: string;
    amountCents: number;
    frequency: IncomeFrequency;
    nextExpectedDate: string;
    accountId?: string;
  }) =>
    http<{ income: RecurringIncome }>('/api/recurring-income', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.income),

  deleteRecurringIncome: (id: string) =>
    http<void>(`/api/recurring-income/${id}`, { method: 'DELETE' }),

  cashFlow: (days = 90) =>
    http<{
      days: number;
      starting_cents: number;
      ending_cents: number;
      series: Array<{ date: string; projected_cents: number }>;
    }>(`/api/cash-flow?days=${days}`),

  // ── Recurring (Phase 6.1) ────────────────────────────────
  detectRecurring: () =>
    http<{ scanned: number; candidates: number; inserted: number; skipped: number }>(
      '/api/recurring/detect',
      { method: 'POST' },
    ),

  listRecurringSuggestions: (status: string = 'pending') =>
    http<{ status: string; suggestions: RecurringSuggestion[] }>(
      `/api/recurring/suggestions?status=${encodeURIComponent(status)}`,
    ).then((r) => r.suggestions),

  confirmRecurringSuggestion: (
    id: string,
    input: { name?: string; frequency?: string; nextDate?: string } = {},
  ) =>
    http<{ suggestion: RecurringSuggestion; resolvedId: string }>(
      `/api/recurring/suggestions/${id}/confirm`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  rejectRecurringSuggestion: (id: string) =>
    http<{ suggestion: RecurringSuggestion }>(
      `/api/recurring/suggestions/${id}/reject`,
      { method: 'POST' },
    ),

  snoozeRecurringSuggestion: (id: string) =>
    http<{ suggestion: RecurringSuggestion }>(
      `/api/recurring/suggestions/${id}/snooze`,
      { method: 'POST' },
    ),

  bulkRecurringAction: (
    ids: string[],
    action: 'confirm' | 'reject' | 'snooze',
  ) =>
    http<{
      action: string;
      updated?: number;
      confirmed?: number;
      skipped?: Array<{ id: string; reason: string }>;
    }>('/api/recurring/suggestions/bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, action }),
    }),

  // ── Bulk transaction edits (Phase 6.2) ───────────────────
  bulkUpdateTransactions: (
    ids: string[],
    updates: { categoryId?: string | null; merchant?: string },
  ) =>
    http<{ updated: number; ids: string[] }>('/api/transactions/bulk', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids, updates }),
    }),

  // ── Bulk transaction delete (Phase 7.4) ──────────────────
  bulkDeleteTransactions: (ids: string[]) =>
    http<{ deleted: number }>('/api/transactions/bulk-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    }),

  // ── Normalization rules ──────────────────────────────────
  listNormalizationRules: () =>
    http<{ rules: NormalizationRule[] }>('/api/normalization-rules').then(
      (r) => r.rules,
    ),

  createNormalizationRule: (input: {
    pattern: string;
    normalizedMerchant?: string | null;
    categoryId?: string | null;
  }) =>
    http<{ rule: NormalizationRule }>('/api/normalization-rules', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.rule),

  deleteNormalizationRule: (id: string) =>
    http<void>(`/api/normalization-rules/${id}`, { method: 'DELETE' }),

  previewNormalizationRule: (pattern: string) =>
    http<{ pattern: string; total: number; manual: number }>(
      '/api/normalization-rules/preview',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pattern }),
      },
    ),

  applyNormalizationRules: (opts: { ruleIds?: string[]; includeManual?: boolean } = {}) =>
    http<{ totalUpdated: number; perRule: Array<{ id: string; updated: number }> }>(
      '/api/normalization-rules/apply',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(opts),
      },
    ),

  // ── Splits ───────────────────────────────────────────────
  listSplits: (transactionId: string) =>
    http<{ splits: TransactionSplit[] }>(
      `/api/transactions/${transactionId}/splits`,
    ).then((r) => r.splits),

  saveSplits: (
    transactionId: string,
    splits: Array<{ categoryId: string | null; amountCents: number; memo?: string }>,
  ) =>
    http<{ splits: TransactionSplit[] }>(
      `/api/transactions/${transactionId}/splits`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ splits }),
      },
    ).then((r) => r.splits),

  clearSplits: (transactionId: string) =>
    http<void>(`/api/transactions/${transactionId}/splits`, {
      method: 'DELETE',
    }),

  // ── Holdings (Phase 7.0) ─────────────────────────────────
  listHoldings: (accountId?: string) =>
    http<{ holdings: Holding[] }>(
      `/api/holdings${accountId ? `?accountId=${accountId}` : ''}`,
    ).then((r) => r.holdings),

  createHolding: (input: {
    accountId: string;
    symbol?: string;
    name: string;
    quantity: number;
    costBasisCents?: number;
    lastPriceCents?: number;
    lastPriceDate?: string | null;
  }) =>
    http<{ holding: Holding }>('/api/holdings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.holding),

  updateHolding: (
    id: string,
    input: Partial<{
      symbol: string;
      name: string;
      quantity: number;
      costBasisCents: number;
      lastPriceCents: number;
      lastPriceDate: string | null;
    }>,
  ) =>
    http<{ holding: Holding }>(`/api/holdings/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.holding),

  deleteHolding: (id: string) =>
    http<void>(`/api/holdings/${id}`, { method: 'DELETE' }),

  // ── Vehicles + tolls + fuel prices (Phase 7.1) ────────────
  listVehicles: () =>
    http<{ vehicles: Vehicle[] }>('/api/vehicles').then((r) => r.vehicles),

  createVehicle: (input: {
    name: string;
    fuelType: VehicleFuelType;
    mpg?: number;
    kwhPerMile?: number;
    electricityRateCentsPerKwh?: number;
    weeklyAvgMiles: number;
  }) =>
    http<{ vehicle: Vehicle }>('/api/vehicles', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.vehicle),

  updateVehicle: (
    id: string,
    input: Partial<{
      name: string;
      mpg: number | null;
      kwhPerMile: number | null;
      electricityRateCentsPerKwh: number | null;
      weeklyAvgMiles: number;
      active: boolean;
    }>,
  ) =>
    http<{ vehicle: Vehicle }>(`/api/vehicles/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.vehicle),

  deleteVehicle: (id: string) =>
    http<void>(`/api/vehicles/${id}`, { method: 'DELETE' }),

  listCommuteRoutes: () =>
    http<{ routes: CommuteRoute[] }>('/api/commute-routes').then((r) => r.routes),

  createCommuteRoute: (input: {
    name: string;
    distanceMiles: number;
    tollPerCrossingCents?: number | null;
    assignments?: Array<{ vehicleId: string; crossingsPerWeek: number }>;
  }) =>
    http<{ route: CommuteRoute }>('/api/commute-routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.route),

  updateCommuteRoute: (
    id: string,
    input: Partial<{
      name: string;
      distanceMiles: number;
      tollPerCrossingCents: number | null;
      active: boolean;
    }>,
  ) =>
    http<{ route: CommuteRoute }>(`/api/commute-routes/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.route),

  setRouteAssignments: (
    id: string,
    assignments: Array<{ vehicleId: string; crossingsPerWeek: number }>,
  ) =>
    http<{ ok: true; count: number }>(`/api/commute-routes/${id}/assignments`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ assignments }),
    }),

  deleteCommuteRoute: (id: string) =>
    http<void>(`/api/commute-routes/${id}`, { method: 'DELETE' }),

  aiModels: (provider: string) =>
    http<{ provider: string; models: AiModelOption[]; note?: string }>(
      `/api/settings/ai-models?provider=${encodeURIComponent(provider)}`,
    ),

  listFuelPrices: () =>
    http<{ prices: FuelPrice[]; eiaConfigured: boolean }>('/api/fuel-prices'),

  setManualFuelPrice: (fuelType: string, priceCentsPerGallon: number) =>
    http<{ price: FuelPrice }>('/api/fuel-prices', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ fuelType, priceCentsPerGallon }),
    }).then((r) => r.price),

  refreshFuelPrices: () =>
    http<{
      summary: {
        refreshed: string[];
        skippedManual: string[];
        failed: string[];
        configured: boolean;
      };
    }>('/api/fuel-prices/refresh', { method: 'POST' }).then((r) => r.summary),

  // ── Budget wizard (Phase 7.1) ────────────────────────────
  budgetWizardPreview: (input: {
    periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    anchor: string;
    count: number;
    groceriesOverrideCents?: Record<number, number>;
    fuelOverrideCents?: Record<number, number>;
    tollsOverrideCents?: Record<number, number>;
    miscOverrideCents?: Record<number, number>;
    miscNoteOverride?: Record<number, string>;
    savingsOverrideCents?: Record<number, number>;
    savingsIncomePctOverride?: number;
    savingsLeftoverPctOverride?: number;
  }) =>
    http<{ preview: WizardPreview }>('/api/budgets/wizard/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.preview),

  budgetWizardCommit: (input: {
    periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    anchor: string;
    count: number;
    groceriesOverrideCents?: Record<number, number>;
    fuelOverrideCents?: Record<number, number>;
    tollsOverrideCents?: Record<number, number>;
    miscOverrideCents?: Record<number, number>;
    miscNoteOverride?: Record<number, string>;
    savingsOverrideCents?: Record<number, number>;
    savingsIncomePctOverride?: number;
    savingsLeftoverPctOverride?: number;
  }) =>
    http<{
      result: {
        created: number;
        skipped: number;
        perPeriod: Array<{ index: number; created: number; skipped: number }>;
      };
    }>('/api/budgets/wizard/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.result),

  // ── Settings (Phase 7.2) ─────────────────────────────────
  listSettings: () =>
    http<{ settings: AppSetting[] }>('/api/settings').then((r) => r.settings),

  putSetting: (key: string, value: string) =>
    http<{ ok: true; restart_required: boolean }>(`/api/settings/${key}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ value }),
    }),

  clearSetting: (key: string) =>
    http<void>(`/api/settings/${key}`, { method: 'DELETE' }),

  restartServer: () =>
    http<{ restarting: boolean }>('/api/admin/restart', { method: 'POST' }),

  smtpTest: (to: string) =>
    http<{
      ok: boolean;
      message_id?: string;
      stage?: string;
      reason?: string;
    }>('/api/admin/smtp-test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to }),
    }),

  // ── Exchange rates (Phase 7.1 / 0.10.0) ──────────────────
  listExchangeRates: () =>
    http<{ rates: ExchangeRate[]; display_currency: string }>(
      '/api/exchange-rates',
    ),

  refreshExchangeRates: () =>
    http<{ inserted: number; base: string; fetchedAt: string }>(
      '/api/exchange-rates/refresh',
      { method: 'POST' },
    ),

  setExchangeRate: (input: { fromCurrency: string; toCurrency: string; rate: number }) =>
    http<{ rate: ExchangeRate }>('/api/exchange-rates', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  deleteExchangeRate: (fromCurrency: string, toCurrency: string) =>
    http<{ removed: number }>(
      `/api/exchange-rates/${encodeURIComponent(fromCurrency)}/${encodeURIComponent(toCurrency)}`,
      { method: 'DELETE' },
    ),

  // ── Retirement projections (Phase 7.2 / 0.10.1) ──────────
  listProjections: () =>
    http<{ projections: RetirementProjection[] }>('/api/projections').then(
      (r) => r.projections,
    ),

  createProjection: (input: {
    name: string;
    startingBalanceCents: number;
    monthlyContributionCents: number;
    annualReturnPct: number;
    annualInflationPct?: number;
    horizonYears?: number;
    targetYear?: number | null;
    targetAmountCents?: number | null;
  }) =>
    http<{ projection: RetirementProjection }>('/api/projections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.projection),

  updateProjection: (
    id: string,
    input: Partial<{
      name: string;
      monthlyContributionCents: number;
      annualReturnPct: number;
      annualInflationPct: number;
      horizonYears: number;
      targetYear: number | null;
      targetAmountCents: number | null;
    }>,
  ) =>
    http<{ projection: RetirementProjection }>(`/api/projections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.projection),

  deleteProjection: (id: string) =>
    http<void>(`/api/projections/${id}`, { method: 'DELETE' }),

  projectionSeries: (id: string) =>
    http<ProjectionSeries>(`/api/projections/${id}/series`),

  // ── OFX Direct Connect (Phase 8.1 / 0.11.1) ──────────────
  listOfxDcConnections: () =>
    http<{ connections: OfxDcConnection[] }>('/api/ofx-dc/connections').then(
      (r) => r.connections,
    ),

  createOfxDcConnection: (body: OfxDcConnectionInput) =>
    http<{ connection: OfxDcConnection }>('/api/ofx-dc/connections', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.connection),

  updateOfxDcConnection: (id: string, body: Partial<OfxDcConnectionInput>) =>
    http<{ connection: OfxDcConnection }>(`/api/ofx-dc/connections/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }).then((r) => r.connection),

  deleteOfxDcConnection: (id: string) =>
    http<void>(`/api/ofx-dc/connections/${id}`, { method: 'DELETE' }),

  testOfxDcConnection: (id: string) =>
    http<OfxDcActionResult>(`/api/ofx-dc/connections/${id}/test`, {
      method: 'POST',
    }),

  syncOfxDcConnection: (id: string) =>
    http<OfxDcActionResult>(`/api/ofx-dc/connections/${id}/sync`, {
      method: 'POST',
    }),

  // ── Health (Phase 7.6 + 7.8) ─────────────────────────────
  healthMetrics: () => http<HealthSnapshot>('/api/health/metrics'),

  healthTimeseries: (windowSec?: number) => {
    const q = windowSec ? `?window=${windowSec}` : '';
    return http<{ window_seconds: number; points: MetricSample[] }>(
      `/api/health/timeseries${q}`,
    );
  },

  healthLive: () =>
    http<{ latest: MetricSample | null }>('/api/health/live'),

  // ── Backups (Phase 7.6) ──────────────────────────────────
  listBackupsHistory: () =>
    http<{ backups: BackupRecord[] }>('/api/backups').then((r) => r.backups),

  getBackupConfig: () => http<BackupConfig>('/api/backups/config'),

  runBackupNow: () =>
    http<{ backup: BackupRecord }>('/api/backups/run', { method: 'POST' }).then(
      (r) => r.backup,
    ),

  pruneBackups: () =>
    http<{ removed: number }>('/api/backups/prune', { method: 'POST' }),

  deleteBackupRecord: (id: string) =>
    http<void>(`/api/backups/${id}`, { method: 'DELETE' }),

  restoreBackup: (id: string) =>
    http<{ ok: true; warnings: string[] }>(`/api/backups/${id}/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: 'RESTORE' }),
    }),

  // ── Reports (Phase 7.6) ──────────────────────────────────
  listReports: () =>
    http<{ reports: ReportDef[] }>('/api/reports').then((r) => r.reports),

  runReport: (id: string, params: Record<string, string>) =>
    http<{ id: string; label: string; result: ReportResult }>(
      `/api/reports/${id}/run`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      },
    ),
};
