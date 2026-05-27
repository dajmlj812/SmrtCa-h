-- Migration 069 (0.21.x): canonical-vs-custom flag on categories.
--
-- The single canonical taxonomy in server/src/domain/categories.ts
-- now includes federally-recognized tax-tied lines (Schedule C / A /
-- E / D / Schedule 1 / Schedule SE) plus the standard personal-finance
-- categories. Seeded rows get is_system = true so the UI can
-- distinguish "the canonical list everyone shares" from custom
-- per-tenant additions.

ALTER TABLE categories
  ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX categories_is_system_idx
  ON categories (tenant_id, is_system);

COMMENT ON COLUMN categories.is_system IS
  '0.21.x — true for rows seeded from the canonical taxonomy in domain/categories.ts. False for tenant-added customs.';
