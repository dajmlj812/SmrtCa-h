-- Migration 022: Phase 8.1 — OFX Direct Connect bank connections.
--
-- One row per (tenant, bank user). Each connection targets ONE account
-- for now (a future migration can split a "connection" from an "account
-- link" so a single login serves multiple accounts).
--
-- Credentials (OFX username, OFX password) are stored encrypted via
-- AES-256-GCM under the same ATTACHMENT_ENCRYPTION_KEY that protects
-- attachments. The wire format is the standard
--   [ 12-byte IV ][ ciphertext ][ 16-byte GCM tag ].
--
-- last_sync_at doubles as the incremental cursor: subsequent syncs
-- request transactions from (last_sync_at - 7 days) to handle late-
-- clearing items. last_sync_status reflects the most recent attempt
-- ('ok', 'auth_failed', 'http_error', 'parse_error', 'never').

CREATE TABLE ofx_dc_connections (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id           uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name                 text NOT NULL,
  ofx_url              text NOT NULL,
  ofx_org              text NOT NULL,
  ofx_fid              text NOT NULL,
  -- Most banks accept Quicken Windows ('QWIN') with a recent version
  -- string. A few require Quicken Mac ('QMOFX') or a real Intuit BID.
  ofx_app_id           text NOT NULL DEFAULT 'QWIN',
  ofx_app_version      text NOT NULL DEFAULT '2700',
  -- Intuit-issued BID, required by a handful of banks (Chase, etc).
  intu_bid             text,
  username_encrypted   bytea NOT NULL,
  password_encrypted   bytea NOT NULL,
  -- OFX statement request coordinates.
  bank_acct_id         text NOT NULL,
  bank_acct_type       text NOT NULL CHECK (bank_acct_type IN (
    'CHECKING', 'SAVINGS', 'MONEYMRKT', 'CREDITLINE', 'CREDITCARD'
  )),
  -- Routing/ABA number for bank accounts; NULL for credit cards.
  bank_id              text,
  -- Sync state. last_sync_at also serves as the incremental cursor.
  last_sync_at         timestamptz,
  last_sync_status     text NOT NULL DEFAULT 'never',
  last_sync_error      text,
  last_sync_imported   integer,
  last_sync_skipped    integer,
  enabled              boolean NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ofx_dc_connections_tenant_idx ON ofx_dc_connections (tenant_id);
CREATE INDEX ofx_dc_connections_account_idx ON ofx_dc_connections (account_id);
