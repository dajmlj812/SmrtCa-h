-- Migration 033 (0.16.4): per-tenant attachment encryption.
--
-- Envelope-encryption pattern:
--
--   KEK (ATTACHMENT_ENCRYPTION_KEY env var, 32 bytes)
--     wraps DEK (per-tenant data encryption key, also 32 bytes)
--       which encrypts the actual attachment bytes on disk.
--
-- Why two layers:
--   • Compromise of one tenant's DEK is contained to that tenant —
--     before this migration a stolen KEK exposed every tenant's
--     attachments at once.
--   • Rotating a tenant's DEK doesn't re-encrypt with the KEK —
--     we re-wrap the existing DEK or generate a new one and
--     re-encrypt attachments; the KEK stays put.
--   • The DB never stores the unwrapped DEK; loss of the KEK
--     still means data loss (matches today's behavior), so the
--     KEK keeps its "back this up offline" status.
--
-- Compat: attachments rows from before this migration have
-- encryption_version = 0 (plaintext) or 1 (encrypted with the
-- KEK directly). New attachments get encryption_version = 2 +
-- key_generation set to the tenant's current generation. The
-- read path branches on (version, key_generation) so legacy
-- files stay decryptable until the operator runs the rotation
-- which re-encrypts in place at version 2.

CREATE TABLE tenant_encryption_keys (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  -- AES-GCM-wrapped DEK. Layout: [12 bytes IV][32 bytes ciphertext
  -- (the 256-bit DEK)][16 bytes GCM auth tag] = 60 bytes total.
  -- Stored as bytea; PG handles the binary fine.
  wrapped_dek bytea NOT NULL,
  -- Bumps on every rotation. Attachments record the generation
  -- they were encrypted with so a partial-rotation crash leaves
  -- the database self-consistent (rows at the old generation
  -- still decrypt with the wrapped DEK at the old generation
  -- if we ever needed to recover from backup; the live row
  -- only holds the current generation).
  generation  integer NOT NULL DEFAULT 1 CHECK (generation >= 1),
  created_at  timestamptz NOT NULL DEFAULT now(),
  rotated_at  timestamptz NOT NULL DEFAULT now()
);

-- attachments.key_generation — null for legacy rows (v0/v1
-- encryption), 1+ for envelope-encrypted rows. Routes check
-- encryption_version first (0=plaintext, 1=legacy KEK,
-- 2=envelope); key_generation is meaningful only when
-- encryption_version=2.
ALTER TABLE attachments
  ADD COLUMN key_generation integer;

-- Allow encryption_version=2.
ALTER TABLE attachments
  DROP CONSTRAINT IF EXISTS attachments_encryption_version_check;
ALTER TABLE attachments
  ADD CONSTRAINT attachments_encryption_version_check
    CHECK (encryption_version IN (0, 1, 2));
