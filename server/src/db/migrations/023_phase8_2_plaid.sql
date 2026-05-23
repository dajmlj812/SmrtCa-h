-- Migration 023: Phase 8.2 — Plaid integration.
--
-- DISABLED BY DEFAULT. The PLAID_ENABLED app_setting (defaults to
-- false) gates every code path. These tables exist so that turning
-- the feature on doesn't require a schema change, not because the
-- feature is on.
--
-- Plaid "Item" = one user@institution login. Multiple Plaid accounts
-- (a person's checking + savings + credit card) hang off one Item.
-- The Plaid access_token is durable and is what we store; we never
-- store the user's bank credentials themselves (Plaid handles the
-- bank auth inside their Link widget).
--
-- The cursor column drives /transactions/sync's incremental delta —
-- empty string on first call, advances on every successful sync.

CREATE TABLE plaid_items (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- Plaid's primary key for the item — opaque, returned by /item/public_token/exchange.
  plaid_item_id            text NOT NULL,
  institution_id           text,
  institution_name         text,
  -- AES-256-GCM encrypted access_token under ATTACHMENT_ENCRYPTION_KEY.
  access_token_encrypted   bytea NOT NULL,
  -- Plaid's /transactions/sync cursor. NULL = never synced, '' = explicit
  -- empty-string cursor (Plaid's "give me everything from the start").
  sync_cursor              text,
  status                   text NOT NULL DEFAULT 'active',
  last_sync_at             timestamptz,
  last_sync_status         text NOT NULL DEFAULT 'never',
  last_sync_error          text,
  last_sync_imported       integer,
  last_sync_skipped        integer,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, plaid_item_id)
);
CREATE INDEX plaid_items_tenant_idx ON plaid_items (tenant_id);

CREATE TABLE plaid_account_links (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plaid_item_id       uuid NOT NULL REFERENCES plaid_items(id) ON DELETE CASCADE,
  -- Plaid's account_id — opaque per-account string within an item.
  plaid_account_id    text NOT NULL,
  -- The SmrtCash account that receives the transactions.
  account_id          uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Cached display info from Plaid's /accounts/get.
  plaid_account_name  text,
  plaid_account_mask  text,
  plaid_account_type  text,
  plaid_account_subtype text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (plaid_item_id, plaid_account_id)
);
CREATE INDEX plaid_account_links_item_idx ON plaid_account_links (plaid_item_id);
CREATE INDEX plaid_account_links_account_idx ON plaid_account_links (account_id);
