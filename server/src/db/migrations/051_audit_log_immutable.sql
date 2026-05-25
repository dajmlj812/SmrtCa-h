-- F-32 (security audit 2026-05-25) — audit log DB-layer immutability.
--
-- The app already has no route that UPDATEs or DELETEs from audit_log
-- (verified via grep across server/src/routes/). This trigger is
-- defense-in-depth: if a future bug, SQL injection, or compromised
-- DB credential tries to rewrite history, the database itself
-- refuses. The error message is intentionally precise so an attacker
-- can't claim "I didn't know" — and so future developers find this
-- comment when they go looking.
--
-- We allow INSERT (recordAudit needs that) and SELECT (super-admin
-- audit views read it). Nothing else.

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'audit_log rows are immutable (security audit F-32). % is not allowed; only INSERT and SELECT are.',
    TG_OP
    USING ERRCODE = '42501'; -- insufficient_privilege
END;
$$;

-- DROP first so re-running the migration is safe.
DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_delete ON audit_log;
DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;

CREATE TRIGGER audit_log_no_update
  BEFORE UPDATE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_log_no_delete
  BEFORE DELETE ON audit_log
  FOR EACH ROW
  EXECUTE FUNCTION reject_audit_log_mutation();

CREATE TRIGGER audit_log_no_truncate
  BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT
  EXECUTE FUNCTION reject_audit_log_mutation();

COMMENT ON FUNCTION reject_audit_log_mutation() IS
  'Defense in depth for F-32: refuses to rewrite audit_log history.';
