-- SmrtCash initial schema (Phase 1)
-- Money is stored as integer cents (bigint). Never floating point.

CREATE TABLE accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  institution text,
  type        text NOT NULL
    CHECK (type IN ('checking','savings','credit_card','cash','investment','loan','other')),
  last4       text,
  currency    text NOT NULL DEFAULT 'USD',
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE categories (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL,
  parent_id  uuid REFERENCES categories(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- A category name is unique within its parent (top-level parent treated as a sentinel).
CREATE UNIQUE INDEX categories_unique_name ON categories
  (lower(name), COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE import_batches (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  format_id      text NOT NULL,
  row_count      integer NOT NULL DEFAULT 0,
  imported_count integer NOT NULL DEFAULT 0,
  skipped_count  integer NOT NULL DEFAULT 0,
  error_count    integer NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE transactions (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  import_batch_id      uuid REFERENCES import_batches(id) ON DELETE SET NULL,
  txn_date             date NOT NULL,
  post_date            date,
  amount_cents         bigint NOT NULL,
  raw_description      text NOT NULL,
  source_category      text,
  source_type          text,
  memo                 text,
  balance_cents        bigint,
  -- Phase 2: AI normalization
  normalized_merchant  text,
  category_id          uuid REFERENCES categories(id) ON DELETE SET NULL,
  normalization_status text NOT NULL DEFAULT 'pending'
    CHECK (normalization_status IN ('pending','normalized','manual','skipped')),
  normalization_note   text,
  -- Phase 4: transfer linking
  transfer_group_id    uuid,
  -- Import de-duplication
  dedup_hash           text NOT NULL,
  created_at           timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX transactions_dedup ON transactions (account_id, dedup_hash);
CREATE INDEX transactions_account_date ON transactions (account_id, txn_date DESC);
CREATE INDEX transactions_category ON transactions (category_id);

CREATE TABLE attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  transaction_id uuid NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
  filename       text NOT NULL,
  mime_type      text,
  byte_size      bigint,
  storage_path   text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX attachments_transaction ON attachments (transaction_id);
