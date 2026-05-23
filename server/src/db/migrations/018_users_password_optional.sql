-- Migration 018: relax users.password_hash to allow OIDC/SAML-only users.
--
-- Phase 8 lets a user authenticate exclusively via an external provider
-- (Google, Microsoft, etc) — they never set a local password, so the
-- column has to accept NULL. The local-auth path still requires a hash
-- and the route layer enforces it at INSERT time; the constraint
-- relaxation is purely about storage.

ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
