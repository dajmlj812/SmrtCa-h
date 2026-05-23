export interface Account {
  id: string;
  name: string;
  institution: string | null;
  type: string;
  last4: string | null;
  currency: string;
  created_at: string;
  balance_cents: number;
  transaction_count: number;
  opening_balance_cents: number;
  opening_balance_date: string | null;
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
  }) => {
    const q = new URLSearchParams();
    if (params.accountId) q.set('accountId', params.accountId);
    if (params.search) q.set('search', params.search);
    if (params.limit != null) q.set('limit', String(params.limit));
    if (params.offset != null) q.set('offset', String(params.offset));
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

  authSetup: (password: string) =>
    http<{ user: { id: string; created_at: string } }>('/api/auth/setup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  authLogin: (password: string) =>
    http<{ user: { id: string } }>('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    }),

  authLogout: () =>
    http<void>('/api/auth/logout', { method: 'POST' }),

  authMe: () =>
    http<{ user: { id: string; created_at: string; last_login_at: string | null } }>(
      '/api/auth/me',
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
};
