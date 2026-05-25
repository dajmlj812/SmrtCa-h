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
  /** 0.18.6: APR + min payment power the /debt-payoff page. Null when unset. */
  interest_rate_apr: number | null;
  min_payment_cents: number | null;
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

export type AnomalyKind =
  | 'large_amount'
  | 'unusual_at_merchant'
  | 'duplicate_suspect';

export interface AnomalyRow {
  id: string;
  transaction_id: string;
  kind: AnomalyKind;
  severity: 'info' | 'warn' | 'high';
  message: string;
  details: Record<string, unknown>;
  dismissed: boolean;
  dismissed_at: string | null;
  detected_at: string;
  txn_date: string;
  txn_amount_cents: number;
  raw_description: string;
  normalized_merchant: string | null;
  account_name: string;
}

export interface TaxYearRow {
  tax_category: string;
  sign: 'income' | 'deductible';
  total_cents: number;
  txn_count: number;
  contributing_categories: string[];
}

export interface TaxYearReport {
  year: number;
  start_date: string;
  end_date: string;
  total_income_cents: number;
  total_deductible_cents: number;
  total_txn_count: number;
  by_tax_category: TaxYearRow[];
}

export interface CalendarDay {
  date: string;
  spend_cents: number;
  income_cents: number;
  txn_count: number;
  bill_due_ids: string[];
}

export interface CalendarMonthResponse {
  year: number;
  month: number;
  daysInMonth: number;
  monthStart: string;
  monthEnd: string;
  days: CalendarDay[];
  totals: {
    spend_cents: number;
    income_cents: number;
    budget_cents: number;
    today_position: number | null;
  };
  upcoming_bills: Array<{
    id: string;
    name: string;
    next_due_date: string;
    amount_cents: number;
    frequency: string;
  }>;
}

export interface SplitParticipant {
  id: string;
  name: string;
  email: string | null;
  user_id: string | null;
  archived: boolean;
  created_at: string;
}

export interface TransactionShare {
  id: string;
  participant_id: string;
  participant_name: string;
  share_cents: number;
  settled: boolean;
  settled_at: string | null;
  note: string | null;
}

export interface TransactionSharesResponse {
  transactionAmountCents: number;
  sharesTotalCents: number;
  yourShareCents: number;
  shares: TransactionShare[];
}

export interface ShareSummaryRow {
  participant_id: string;
  name: string;
  net_open_cents: number;
  net_all_cents: number;
  open_count: number;
}

export interface ShareRow {
  id: string;
  transaction_id: string;
  share_cents: number;
  settled: boolean;
  settled_at: string | null;
  note: string | null;
  created_at: string;
  txn_date: string;
  raw_description: string;
  txn_amount_cents: number;
  participant_id: string;
  participant_name: string;
}

export interface AssistantClientMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantToolCall {
  name: string;
  kind: 'read' | 'write';
  input: unknown;
  result?: unknown;
  error?: string;
}

export interface AssistantChatResponse {
  reply: string;
  toolCalls: AssistantToolCall[];
  iterations: number;
  stopReason: 'end_turn' | 'tool_use_loop_cap' | 'error';
}

export interface PlaidItemSummary {
  id: string;
  plaid_item_id: string;
  institution_id: string | null;
  institution_name: string | null;
  status: string;
  last_sync_at: string | null;
  last_sync_status: string;
  last_sync_error: string | null;
  last_sync_imported: number | null;
  last_sync_skipped: number | null;
  created_at: string;
  has_cursor: boolean;
}

export interface PlaidAccountInfo {
  account_id: string;
  name: string;
  official_name: string | null;
  type: string;
  subtype: string | null;
  mask: string | null;
}

export interface PlaidItemAccountLink {
  plaid_account_id: string;
  account_id: string;
  plaid_account_name: string | null;
  plaid_account_mask: string | null;
  plaid_account_type: string | null;
  plaid_account_subtype: string | null;
}

export interface PlaidItemWithLinks extends PlaidItemSummary {
  links: PlaidItemAccountLink[];
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
  /** 0.17.20 — when set, only the plan scoping this account counts this vehicle's fuel cost. */
  account_id: string | null;
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
  /** 0.17.20 — same semantics as Vehicle.account_id; gates per-plan toll inclusion. */
  account_id: string | null;
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
  /** 0.17.22 — three percentages of post-deduction leftover (low/mid/high). */
  pctLowCents: number;
  pctMidCents: number;
  pctHighCents: number;
  /** 0.17.22 — 100% of leftover. */
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
  /** 0.17.22 — three configurable percentages of post-deduction leftover. */
  savingsLowPct: number;
  savingsMidPct: number;
  savingsHighPct: number;
  periods: WizardPeriodPreview[];
}

export type AssetType =
  | 'stock'
  | 'etf'
  | 'mutual_fund'
  | 'bond'
  | 'crypto'
  | 'commodity'
  | 'other';

export const ASSET_TYPES: AssetType[] = [
  'stock',
  'etf',
  'mutual_fund',
  'bond',
  'crypto',
  'commodity',
  'other',
];

export interface Holding {
  id: string;
  account_id: string;
  symbol: string | null;
  name: string;
  asset_type: AssetType;
  quantity: number;
  cost_basis_cents: number;
  last_price_cents: number;
  last_price_date: string | null;
  market_value_cents: number;
  unrealized_gain_cents: number;
  created_at: string;
}

export interface CryptoRefreshResult {
  updated: number;
  symbols: string[];
  unknown: string[];
  fetched_at: string;
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

/**
 * 0.17.7 — period cash-flow summary. Powers the new "Period
 * overview" section on the Budgets page. The shape is per-period
 * income + bills + modifiable budgets + net, not the
 * budget-vs-actual table the same page also renders.
 */
export interface BudgetPeriodSummary {
  asOf: string;
  period: { start: string; end: string; type: BudgetPeriodType };
  income: Array<{
    id: string;
    name: string;
    amount_cents: number;
    date: string;
  }>;
  bills: Array<{
    /** 0.17.9 — null when no budget row has been committed for this
     *  bill in this period. The amount falls back to the bill's
     *  master amount in that case. */
    budget_id: string | null;
    bill_id: string;
    name: string;
    amount_cents: number;
    date: string;
  }>;
  editable: Array<{
    budget_id: string;
    category_id: string;
    category_name: string;
    amount_cents: number;
    /** True for Savings — the user has to physically move money. */
    requires_manual_action: boolean;
  }>;
  totals: {
    income_cents: number;
    bills_cents: number;
    editable_cents: number;
    /** Positive = leftover; negative = overextended for the period. */
    net_cents: number;
  };
  /**
   * 0.17.9 — true when AutoMagic (or a manual upsert) committed at
   * least one budget row for this period. False means the
   * set-aside section's empty state should show a "Run AutoMagic"
   * CTA; bills still render from the master bills table either way.
   */
  has_committed_budgets: boolean;
  /**
   * 0.17.11 — the account scope the wizard ran with for this
   * period (one entry per included account). null means "no
   * scope set — every account in the tenant counts toward this
   * period's actuals." UI can use this to render
   * "Includes accounts: …" on the card.
   */
  included_account_ids: string[] | null;
  /**
   * 0.17.16 — which budget plan owns this period. null for
   * legacy pre-0.17.16 rows that were imported without a plan,
   * or for the empty-state placeholder card.
   */
  plan_id: string | null;
  plan_name: string | null;
}

/**
 * 0.17.16 — a single paycheck-to-paycheck cycle. The tenant can
 * have many; each is scoped to a disjoint set of accounts.
 */
export interface BudgetPlan {
  id: string;
  name: string;
  period_type: BudgetPeriodType;
  anchor_date: string;
  account_ids: string[];
  created_at: string;
}

export interface NormalizationRule {
  id: string;
  pattern: string;
  normalized_merchant: string | null;
  category_id: string | null;
  source: 'manual' | 'ai';
  /** 0.13.6: disable a noisy rule without deleting it. Defaults to true. */
  enabled: boolean;
  /** 0.13.6: higher wins on overlapping matches. Defaults to 0. */
  priority: number;
  match_count: number;
  last_applied_at: string | null;
  created_at: string;
  tenant_id: string;
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
  /** 0.17.21 — account this goal is funded from; null = unscoped. */
  account_id: string | null;
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
  cancel_url: string | null;
  cancel_email_template: string | null;
  cancel_steps: string | null;
  cancel_notes: string | null;
  created_at: string;
}

export interface CancellationEntry {
  merchant: string;
  cancelUrl: string | null;
  emailTemplate: string | null;
  steps: string | null;
  notes: string | null;
}

// 0.18.4 — public-API key shown in the My profile modal. The full
// token is returned only by POST /api/me/api-keys; everywhere else
// we have just the prefix for display.
export interface ApiKeySummary {
  id: string;
  tenant_id: string | null;
  key_prefix: string;
  label: string;
  scopes: 'read';
  last_used_at: string | null;
  last_used_ip: string | null;
  revoked_at: string | null;
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
  tax_category: string | null;
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

/**
 * 0.15.5 — SaaS operator metrics. Super-admin only.
 *
 * Powers the SaaS section of the /health page: subscription
 * distribution + webhook ingest health, so the operator can spot
 * a Stripe outage or stalled webhook delivery without leaving the
 * app.
 */
export interface SaasMetrics {
  generated_at: string;
  tenants: { total: number; with_active_sub: number };
  subscriptions: {
    total: number;
    by_plan: { starter: number; plus: number; family: number };
    by_status: Record<string, number>;
  };
  webhooks: {
    processed_total: number;
    processed_24h: number;
    last_event_at: string | null;
  };
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
    timezone: string | null;
  };
  memberships: TenantMembership[];
  active_tenant_id: string | null;
  web_settings: {
    inactivity_timeout_minutes: number;
  };
}

export interface TenantSummary {
  id: string;
  name: string;
  slug: string;
  role: 'admin' | 'spouse' | 'child';
}

/**
 * 0.16.1 — one row in the super-admin subscriptions table. Tenant
 * fields are always populated; subscription fields are null when
 * the tenant has no row in `subscriptions` (a fresh signup with no
 * plan picked yet, for example).
 */
export interface SystemSubscriptionRow {
  tenant_id: string;
  tenant_name: string;
  tenant_slug: string;
  tenant_created_at: string;
  member_count: number;
  plan_id: 'starter' | 'plus' | 'family' | null;
  status:
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'incomplete'
    | 'incomplete_expired'
    | 'unpaid'
    | 'paused'
    | null;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  trial_end: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean | null;
  sub_updated_at: string | null;
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

/**
 * 0.15.4 — thrown when the server returns 402 (Payment Required).
 * Pages catch this to render `<UpgradePrompt>` instead of an error
 * toast, since the user can recover by upgrading.
 */
export class UpgradeRequiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UpgradeRequiredError';
  }
}

/** True when the caught error is a 402-from-server. */
export function isUpgradeRequired(err: unknown): err is UpgradeRequiredError {
  return err instanceof UpgradeRequiredError;
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
    if (res.status === 402) {
      throw new UpgradeRequiredError(message);
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

// ── Billing (0.15.x) ─────────────────────────────────────

/** Stripe lookup_keys created by scripts/stripe-setup.mjs. */
export type PlanLookupKey =
  | 'starter_monthly' | 'starter_annual'
  | 'plus_monthly'    | 'plus_annual'
  | 'family_monthly'  | 'family_annual';

export type Plan = 'starter' | 'plus' | 'family';

export type SubscriptionStatus =
  | 'trialing' | 'active' | 'past_due' | 'canceled'
  | 'incomplete' | 'incomplete_expired' | 'unpaid' | 'paused';

/** One metered feature's usage for the current period. cap=null means unlimited. */
export interface UsageMeter {
  used: number;
  cap: number | null;
  remaining: number | null;
}

/** Hard caps (bank connections + household seats). */
export interface CapMeter {
  used: number;
  cap: number;
}

export interface BillingStatus {
  plan: Plan | null;
  status: SubscriptionStatus | null;
  trialEnd: string | null;        // ISO timestamp
  currentPeriodEnd: string | null; // ISO timestamp
  cancelAtPeriodEnd: boolean;
  hasStripeCustomer: boolean;
  usage: {
    aiAssistant: UsageMeter;
    receiptOcr: UsageMeter;
  };
  caps: {
    bankConnections: CapMeter;
    householdMembers: CapMeter;
  };
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
  /** 0.18.6 — debt fields. Null clears. */
  interest_rate_apr?: number | null;
  min_payment_cents?: number | null;
}

// 0.18.6 — debt-payoff plan calculator.
export interface PayoffAccount {
  id: string;
  name: string;
  balance_cents: number;
  apr_percent: number;
  min_payment_cents: number;
}
export interface PayoffPerAccountResult {
  accountId: string;
  name: string;
  monthsToPayoff: number;
  interestPaidCents: number;
  totalPaidCents: number;
}
export interface PayoffMonthSnapshot {
  month: number;
  totalBalanceCents: number;
  totalInterestThisMonth: number;
  totalPaidThisMonth: number;
}
export interface PayoffPlan {
  strategy: 'snowball' | 'avalanche';
  monthsToPayoff: number;
  totalInterestCents: number;
  totalPaidCents: number;
  perAccount: PayoffPerAccountResult[];
  schedule: PayoffMonthSnapshot[];
  unpayable: boolean;
  minTooLowAccountIds: string[];
}
export interface PayoffResponse {
  accounts: PayoffAccount[];
  snowball: PayoffPlan | null;
  avalanche: PayoffPlan | null;
  missing_data: Array<{ id: string; name: string; missing: string[] }>;
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

  // 0.18.6 — compute snowball + avalanche payoff plans.
  computeDebtPayoff: (input: {
    extraCents: number;
    overrides?: Record<string, { aprPercent?: number; minPaymentCents?: number }>;
  }) =>
    http<PayoffResponse>('/api/debt/payoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  listTransactions: (params: {
    accountId?: string;
    search?: string;
    limit?: number;
    offset?: number;
    uncategorized?: boolean;
    startDate?: string;
    endDate?: string;
  }) => {
    const q = new URLSearchParams();
    if (params.accountId) q.set('accountId', params.accountId);
    if (params.search) q.set('search', params.search);
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
    if (params.uncategorized) q.set('uncategorized', 'true');
    if (params.startDate) q.set('startDate', params.startDate);
    if (params.endDate) q.set('endDate', params.endDate);
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

  updateCategory: (
    id: string,
    input: { name?: string; tax_category?: string | null },
  ) =>
    http<{ category: Category }>(`/api/categories/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...(input.name !== undefined && { name: input.name }),
        ...(input.tax_category !== undefined && {
          tax_category: input.tax_category ?? '',
        }),
      }),
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

  normalize: (
    opts: {
      accountId?: string;
      limit?: number;
      // 0.17.5 — 'all' includes already-normalized rows in the
      // selection. 'manual' rows are still left alone in both
      // modes. Default 'pending' = legacy behavior.
      mode?: 'pending' | 'all';
    } = {},
  ) =>
    http<{ summary: NormalizationSummary }>('/api/normalize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(opts),
    }).then((r) => r.summary),

  // 0.17.4 — denominator for the progress bar on the
  // Transactions page; the client calls this once before
  // looping `normalize()` in chunks.
  normalizePendingCount: (accountId?: string) => {
    const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return http<{ pending: number }>(`/api/normalize/pending-count${q}`).then(
      (r) => r.pending,
    );
  },

  // 0.17.5 — richer counts for the "Re-normalize already-
  // normalized too?" prompt. Returns counts by status in one
  // round-trip; 'manual' is informational only (those rows
  // never get touched).
  normalizeCounts: (accountId?: string) => {
    const q = accountId ? `?accountId=${encodeURIComponent(accountId)}` : '';
    return http<{ pending: number; normalized: number; manual: number }>(
      `/api/normalize/counts${q}`,
    );
  },

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

  /**
   * 0.18.13 — XHR-backed upload that surfaces byte-level progress.
   *
   * Why XHR instead of fetch: as of 2026 there's still no standard
   * way to observe the request-body bytes-out of a fetch() call. The
   * Streams API can do it but isn't broadly supported as an upload
   * progress signal, and fetch's body iterator doesn't fire on bytes
   * sent. XHR's `upload.onprogress` has been reliable forever and
   * matches what every other "show me upload %" UI uses.
   *
   * Returns a thin {promise, abort} so the caller can cancel a slow
   * upload without leaking the XHR.
   */
  uploadAttachmentsWithProgress: (
    transactionId: string,
    files: File[],
    onProgress: (state: {
      phase: 'uploading' | 'processing';
      loaded: number;
      total: number;
    }) => void,
  ): { promise: Promise<UploadResult>; abort: () => void } => {
    const fd = new FormData();
    let totalBytes = 0;
    for (const file of files) {
      fd.append('file', file, file.name);
      totalBytes += file.size;
    }
    const xhr = new XMLHttpRequest();
    const promise = new Promise<UploadResult>((resolve, reject) => {
      xhr.open('POST', `/api/transactions/${transactionId}/attachments`);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) {
          onProgress({
            phase: 'uploading',
            loaded: e.loaded,
            total: e.total,
          });
        }
      };
      xhr.upload.onload = () => {
        // Bytes are all up — the server is now processing (parsing
        // multipart, sniffing the file, writing to disk, optionally
        // launching OCR). UI flips to indeterminate "Processing…".
        onProgress({ phase: 'processing', loaded: totalBytes, total: totalBytes });
      };
      xhr.onerror = () => reject(new Error('Network error during upload'));
      xhr.onabort = () => reject(new Error('Upload aborted'));
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try {
            resolve(JSON.parse(xhr.responseText) as UploadResult);
          } catch {
            reject(new Error('Server returned malformed JSON'));
          }
        } else {
          // Best-effort error parse — match what http() does.
          let message = `Upload failed (HTTP ${xhr.status})`;
          try {
            const body = JSON.parse(xhr.responseText) as { error?: string };
            if (body.error) message = body.error;
          } catch {
            /* keep generic message */
          }
          reject(new Error(message));
        }
      };
      xhr.send(fd);
    });
    return { promise, abort: () => xhr.abort() };
  },

  deleteAttachment: (id: string) =>
    http<void>(`/api/attachments/${id}`, { method: 'DELETE' }),

  attachmentPreviewUrl: (id: string) => `/api/attachments/${id}/preview`,
  attachmentDownloadUrl: (id: string) => `/api/attachments/${id}`,

  // ── Auth (Phase 5) ───────────────────────────────────────
  authStatus: () =>
    http<{
      isSetup: boolean;
      authenticated: boolean;
      // 0.16.0 — true when PUBLIC_SIGNUP_ENABLED is set on the
      // server. LoginPage shows the "Create account" link only
      // when this is true.
      signupEnabled: boolean;
      // 0.16.3 — support / feature-request URL. Surfaced in the
      // sidebar footer + login/signup pages. null when the
      // operator has cleared it.
      supportUrl: string | null;
    }>('/api/auth/status'),

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

  // 0.16.0 — public signup. Server returns 202 + { status:
  // 'verification_sent' } regardless of whether the email
  // address was already in use, so the client can't enumerate
  // accounts. The user must check email and click the link.
  authSignup: (input: { email: string; name?: string; password: string }) =>
    http<{ status: 'verification_sent' }>('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  // 0.16.0 — consume a verification token. On success: tenant is
  // provisioned, membership created, session cookie set. Caller
  // should reload auth state to land on the authenticated app.
  authVerifyEmail: (token: string) =>
    http<{
      user: { id: string; email: string; name: string; is_super_admin: boolean };
      tenantId: string;
    }>('/api/auth/verify-email', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token }),
    }),

  // 0.16.2 — request a password reset link. Always returns 202
  // regardless of whether the email is registered, so the client
  // can't enumerate accounts. Caller shows a generic "if the
  // address is on file you'll receive a link" message.
  authPasswordResetRequest: (email: string) =>
    http<{ status: 'reset_sent' }>('/api/auth/password-reset-request', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    }),

  // 0.16.2 — complete a password reset. Does NOT sign the user
  // in; they go through /login afterward with the new password.
  authPasswordResetConfirm: (input: { token: string; password: string }) =>
    http<{ reset: true }>('/api/auth/password-reset-confirm', {
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

  // 0.18.3 — self-service profile update (name + timezone).
  updateMyProfile: (input: { name?: string | null; timezone?: string | null }) =>
    http<{
      user: {
        id: string;
        email: string | null;
        name: string | null;
        timezone: string | null;
      };
    }>('/api/auth/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),

  // 0.18.4 — public-API key management.
  listApiKeys: () =>
    http<{ keys: ApiKeySummary[] }>('/api/me/api-keys').then((r) => r.keys),

  createApiKey: (label: string) =>
    http<{ key: ApiKeySummary; token: string }>('/api/me/api-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label }),
    }),

  revokeApiKey: (id: string) =>
    http<{ revoked: true }>(`/api/me/api-keys/${id}`, { method: 'DELETE' }),

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

  // 0.16.4 — mint a fresh per-tenant attachment encryption key
  // and re-encrypt every existing attachment under it. Returns
  // how many files were rewritten + the new generation number.
  systemRotateEncryptionKey: (tenantId: string) =>
    http<{ attachments_rewritten: number; new_generation: number }>(
      `/api/system/tenants/${tenantId}/rotate-encryption-key`,
      { method: 'POST' },
    ),

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

  // 0.16.1 — super-admin subscriptions console.
  systemListSubscriptions: () =>
    http<{ rows: SystemSubscriptionRow[] }>('/api/system/subscriptions').then(
      (r) => r.rows,
    ),

  systemGrantSubscription: (
    tenantId: string,
    input: { plan: 'starter' | 'plus' | 'family'; days: number; reason?: string },
  ) =>
    http<{ granted: true; plan: string; current_period_end: string }>(
      `/api/system/subscriptions/${tenantId}/grant`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      },
    ),

  systemSyncSubscription: (tenantId: string) =>
    http<{ synced: true }>(`/api/system/subscriptions/${tenantId}/sync`, {
      method: 'POST',
    }),

  systemForceCancelSubscription: (tenantId: string) =>
    http<{ cleared: true }>(`/api/system/subscriptions/${tenantId}`, {
      method: 'DELETE',
    }),

  // Child→account assignments (admin only)
  listMemberAccounts: (tenantId: string, userId: string) =>
    http<{
      accounts: Array<{
        account_id: string;
        account_name: string;
        permission: 'read' | 'read_write';
      }>;
    }>(
      `/api/tenants/${tenantId}/members/${userId}/accounts`,
    ).then((r) => r.accounts),

  setMemberAccounts: (
    tenantId: string,
    userId: string,
    accounts: Array<{ accountId: string; permission: 'read' | 'read_write' }>,
  ) =>
    http<{ ok: true; count: number }>(
      `/api/tenants/${tenantId}/members/${userId}/accounts`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accounts }),
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

  // 0.17.7 — period cash-flow shape. Income events + bill events
  // with dates + modifiable budgets + net for whatever period
  // covers `asOf`. Renders the "Period overview" section on
  // /budgets.
  budgetPeriod: (asOf: string) =>
    http<BudgetPeriodSummary>(`/api/budgets/period?asOf=${encodeURIComponent(asOf)}`),

  // 0.17.10 — ALL committed period windows, stacked. One card
  // per period that the wizard committed. Falls back to a
  // single calendar-month placeholder when no commits exist.
  budgetPeriods: () =>
    http<{ periods: BudgetPeriodSummary[] }>(`/api/budgets/periods`).then(
      (r) => r.periods,
    ),

  // ── Goals ────────────────────────────────────────────────
  listGoals: () =>
    http<{ goals: SavingsGoal[] }>('/api/goals').then((r) => r.goals),

  createGoal: (input: {
    name: string;
    targetAmountCents: number;
    currentAmountCents?: number;
    targetDate?: string | null;
    /** 0.17.21 */
    accountId?: string | null;
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
      /** 0.17.21 — null clears. */
      accountId: string | null;
    }>,
  ) =>
    http<{ goal: SavingsGoal }>(`/api/goals/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.goal),

  deleteGoal: (id: string) =>
    http<void>(`/api/goals/${id}`, { method: 'DELETE' }),

  // 0.18.5 — contribute against a savings goal.
  contributeGoal: (
    id: string,
    input: { amountCents: number; note?: string },
  ) =>
    http<{ goal: SavingsGoal }>(`/api/goals/${id}/contribute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.goal),

  listGoalContributions: (id: string) =>
    http<{
      contributions: Array<{
        id: string;
        amount_cents: number;
        note: string | null;
        contributed_at: string;
        transaction_id: string | null;
      }>;
    }>(`/api/goals/${id}/contributions`).then((r) => r.contributions),

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

  // 0.17.18 — partial update; accountId === null clears it.
  updateBill: (
    id: string,
    input: {
      name?: string;
      amountCents?: number;
      frequency?: BillFrequency;
      nextDueDate?: string;
      active?: boolean;
      accountId?: string | null;
      cancelUrl?: string | null;
      cancelEmailTemplate?: string | null;
      cancelSteps?: string | null;
      cancelNotes?: string | null;
    },
  ) =>
    http<{ bill: Bill }>(`/api/bills/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.bill),

  lookupCancellation: (name: string) =>
    http<{
      matched: boolean;
      entry: CancellationEntry | null;
      generic_email_template: string;
    }>(`/api/cancellation/lookup?name=${encodeURIComponent(name)}`),

  deleteBill: (id: string) =>
    http<void>(`/api/bills/${id}`, { method: 'DELETE' }),

  // 0.17.24 — clone a bill (e.g. two Netflix subs from one card).
  duplicateBill: (id: string) =>
    http<{ bill: Bill }>(`/api/bills/${id}/duplicate`, {
      method: 'POST',
    }).then((r) => r.bill),

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

  // 0.17.18 — partial update for recurring income.
  updateRecurringIncome: (
    id: string,
    input: {
      name?: string;
      amountCents?: number;
      frequency?: IncomeFrequency;
      nextExpectedDate?: string;
      active?: boolean;
      accountId?: string | null;
    },
  ) =>
    http<{ income: RecurringIncome }>(`/api/recurring-income/${id}`, {
      method: 'PATCH',
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
      daily_volatility_cents: number;
      milestones: { day_30: number; day_60: number; day_90: number };
      series: Array<{
        date: string;
        projected_cents: number;
        low_cents: number;
        high_cents: number;
      }>;
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
    assetType?: AssetType;
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
      assetType: AssetType;
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

  refreshCryptoPrices: () =>
    http<CryptoRefreshResult>('/api/holdings/refresh-prices/crypto', {
      method: 'POST',
    }),

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
    /** 0.17.20 */
    accountId?: string | null;
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
      /** 0.17.20 — null clears. */
      accountId: string | null;
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
    /** 0.17.20 */
    accountId?: string | null;
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
      /** 0.17.20 — null clears. */
      accountId: string | null;
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
    /**
     * 0.17.8 — INCLUDE these accounts in the wizard data sources.
     * Bills/income with NULL account_id (household-wide) are
     * always included regardless. Undefined or empty = include
     * every account.
     */
    accountIds?: string[];
    /** 0.17.22 — savings destination; null clears. */
    savingsAccountId?: string | null;
    groceriesOverrideCents?: Record<number, number>;
    fuelOverrideCents?: Record<number, number>;
    tollsOverrideCents?: Record<number, number>;
    miscOverrideCents?: Record<number, number>;
    miscNoteOverride?: Record<number, string>;
    savingsOverrideCents?: Record<number, number>;
    /** 0.17.22 — per-run % overrides for the three savings chips. */
    savingsLowPctOverride?: number;
    savingsMidPctOverride?: number;
    savingsHighPctOverride?: number;
  }) =>
    http<{ preview: WizardPreview }>('/api/budgets/wizard/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.preview),

  budgetWizardCommit: (input: {
    /** 0.17.16 — plan name; required on commit. */
    name: string;
    periodType: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
    anchor: string;
    count: number;
    /** 0.17.8 — see budgetWizardPreview.accountIds. */
    accountIds?: string[];
    /** 0.17.22 — savings destination; null clears. */
    savingsAccountId?: string | null;
    groceriesOverrideCents?: Record<number, number>;
    fuelOverrideCents?: Record<number, number>;
    tollsOverrideCents?: Record<number, number>;
    miscOverrideCents?: Record<number, number>;
    miscNoteOverride?: Record<number, string>;
    savingsOverrideCents?: Record<number, number>;
    savingsLowPctOverride?: number;
    savingsMidPctOverride?: number;
    savingsHighPctOverride?: number;
  }) =>
    http<{
      result: {
        planId: string;
        created: number;
        skipped: number;
        perPeriod: Array<{ index: number; created: number; skipped: number }>;
      };
    }>('/api/budgets/wizard/commit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.result),

  // ── Budget plans (0.17.16) ───────────────────────────────
  listBudgetPlans: () =>
    http<{ plans: BudgetPlan[] }>('/api/budget-plans').then((r) => r.plans),

  deleteBudgetPlan: (id: string) =>
    http<void>(`/api/budget-plans/${id}`, { method: 'DELETE' }),

  renameBudgetPlan: (id: string, name: string) =>
    http<{ plan: BudgetPlan }>(`/api/budget-plans/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.plan),

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

  // ── Plaid (Phase 8.2 / 0.11.2) — disabled by default ─────
  plaidStatus: () =>
    http<{ enabled: boolean; environment: string | null }>('/api/plaid/status'),

  plaidLinkToken: () =>
    http<{ link_token: string; expiration: string }>('/api/plaid/link-token', {
      method: 'POST',
    }),

  plaidExchange: (publicToken: string) =>
    http<{ item: PlaidItemSummary; accounts: PlaidAccountInfo[] }>(
      '/api/plaid/exchange',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ publicToken }),
      },
    ),

  plaidListItems: () =>
    http<{ items: PlaidItemWithLinks[] }>('/api/plaid/items').then((r) => r.items),

  plaidLinkAccounts: (
    itemId: string,
    links: Array<{
      plaidAccountId: string;
      accountId: string;
      plaidAccountName?: string;
      plaidAccountMask?: string;
      plaidAccountType?: string;
      plaidAccountSubtype?: string;
    }>,
  ) =>
    http<{ ok: true; linkedCount: number }>(
      `/api/plaid/items/${itemId}/link-account`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ links }),
      },
    ),

  plaidSyncItem: (itemId: string) =>
    http<{
      ok: boolean;
      importedCount?: number;
      skippedCount?: number;
      errorCount?: number;
      unmappedCount?: number;
      error?: string;
      kind?: string;
    }>(`/api/plaid/items/${itemId}/sync`, { method: 'POST' }),

  plaidDeleteItem: (itemId: string) =>
    http<void>(`/api/plaid/items/${itemId}`, { method: 'DELETE' }),

  // ── Auto-sync scheduler (Phase 8.3 / 0.11.3) ─────────────
  autoSyncStatus: () =>
    http<{
      enabled: boolean;
      frequency: string;
      time: string;
      sources: { ofx_dc: number; plaid: number };
    }>('/api/auto-sync/status'),

  autoSyncRunNow: () =>
    http<{
      enabled: boolean;
      frequency: string;
      ranAt: string;
      ofxDc: { attempted: number; succeeded: number; failed: number };
      plaid: { attempted: number; succeeded: number; failed: number };
    }>('/api/auto-sync/run', { method: 'POST' }),

  // ── Assistant (Phase 9.1 / 0.12.1) ───────────────────────
  assistantStatus: () =>
    http<{ available: boolean; reason?: string }>('/api/assistant/status'),

  assistantChat: (messages: AssistantClientMessage[]) =>
    http<AssistantChatResponse>('/api/assistant/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages }),
    }),

  // ── Calendar (Phase 9.3 / 0.12.3) ────────────────────────
  calendarMonth: (month: string) =>
    http<CalendarMonthResponse>(`/api/calendar/${month}`),

  // ── Tax year (backlog 0.13.1) ────────────────────────────
  taxVocabulary: () =>
    http<{ suggestions: string[] }>('/api/categories/tax-vocabulary').then(
      (r) => r.suggestions,
    ),

  taxYearReport: (year: number) =>
    http<TaxYearReport>(`/api/reports/tax-year/${year}`),

  taxYearCsvUrl: (year: number) => `/api/reports/tax-year/${year}.csv`,

  // ── Anomaly alerts (backlog 0.13.2) ──────────────────────
  listAnomalies: (includeDismissed = false) =>
    http<{ anomalies: AnomalyRow[] }>(
      `/api/anomalies${includeDismissed ? '?includeDismissed=1' : ''}`,
    ).then((r) => r.anomalies),

  anomalyCount: () => http<{ open: number }>('/api/anomalies/count'),

  scanAnomalies: () =>
    http<{
      enabled: boolean;
      scanned: number;
      newAlerts: number;
      byKind: Record<string, number>;
    }>('/api/anomalies/scan', { method: 'POST' }),

  dismissAnomaly: (id: string, dismissed = true) =>
    http<{ anomaly: { id: string; dismissed: boolean; dismissed_at: string | null } }>(
      `/api/anomalies/${id}/dismiss`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dismissed }),
      },
    ),

  // ── Bill-splitting (Phase 9.2 / 0.12.2) ──────────────────
  listSplitParticipants: (includeArchived = false) =>
    http<{ participants: SplitParticipant[] }>(
      `/api/split-participants${includeArchived ? '?includeArchived=1' : ''}`,
    ).then((r) => r.participants),

  createSplitParticipant: (input: { name: string; email?: string | null }) =>
    http<{ participant: SplitParticipant }>('/api/split-participants', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.participant),

  updateSplitParticipant: (
    id: string,
    input: { name?: string; email?: string | null; archived?: boolean },
  ) =>
    http<{ participant: SplitParticipant }>(`/api/split-participants/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }).then((r) => r.participant),

  deleteSplitParticipant: (id: string) =>
    http<void>(`/api/split-participants/${id}`, { method: 'DELETE' }),

  getTransactionShares: (transactionId: string) =>
    http<TransactionSharesResponse>(`/api/transactions/${transactionId}/shares`),

  putTransactionShares: (
    transactionId: string,
    shares: Array<{ participantId: string; shareCents: number; note?: string }>,
  ) =>
    http<{ ok: true; written: number }>(`/api/transactions/${transactionId}/shares`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ shares }),
    }),

  settleTransactionShare: (id: string, settled: boolean) =>
    http<{ share: { id: string; settled: boolean; settled_at: string | null } }>(
      `/api/transaction-shares/${id}/settle`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settled }),
      },
    ),

  sharesSummary: () =>
    http<{ summary: ShareSummaryRow[] }>('/api/shares/summary').then((r) => r.summary),

  listShares: (params?: { participantId?: string; onlyOpen?: boolean }) => {
    const q = new URLSearchParams();
    if (params?.participantId) q.set('participantId', params.participantId);
    if (params?.onlyOpen) q.set('onlyOpen', '1');
    const qs = q.toString();
    return http<{ shares: ShareRow[] }>(`/api/shares${qs ? `?${qs}` : ''}`).then(
      (r) => r.shares,
    );
  },

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

  healthSaas: () => http<SaasMetrics>('/api/health/saas'),

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

  // ── Billing (0.15.x) ─────────────────────────────────────
  getBillingStatus: () => http<BillingStatus>('/api/billing/status'),

  startBillingCheckout: (lookupKey: PlanLookupKey) =>
    http<{ url: string; id: string }>('/api/billing/checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lookupKey }),
    }),

  openBillingPortal: () =>
    http<{ url: string }>('/api/billing/portal'),
};
