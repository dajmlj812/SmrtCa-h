-- F-32 ↔ F-34 collision fix (re-audit 2026-05-25 evening).
--
-- Migration 051 added a BEFORE UPDATE OR DELETE trigger on audit_log
-- that raises on any mutation. Migration 052 made tenant_id FKs
-- cascade. But `audit_log.tenant_id` is ON DELETE SET NULL (we want
-- audit history to survive a tenant deletion). That SET NULL is
-- itself an UPDATE — and the F-32 trigger refused it, blowing up
-- the F-35 user-self-delete flow with a "audit_log rows are
-- immutable" error.
--
-- Same logic for `audit_log.actor_user_id` (SET NULL on user delete).
--
-- The fix: replace the trigger function with one that allows EXACTLY
-- the FK-cascade pattern (UPDATE where the ONLY change is tenant_id
-- or actor_user_id going from non-NULL to NULL) and rejects every
-- other mutation. This preserves the application-level immutability
-- guarantee — no route can rewrite the action, target_id, details,
-- or any other audit field — while letting the database's own
-- cascade housekeeping proceed.

CREATE OR REPLACE FUNCTION reject_audit_log_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  is_cascade_set_null boolean;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    -- The cascade pattern: exactly tenant_id or actor_user_id
    -- transitions from non-NULL to NULL. Every other column stays
    -- equal to the old row.
    is_cascade_set_null :=
      (OLD.id IS NOT DISTINCT FROM NEW.id) AND
      (OLD.occurred_at IS NOT DISTINCT FROM NEW.occurred_at) AND
      (OLD.actor_kind IS NOT DISTINCT FROM NEW.actor_kind) AND
      (OLD.action IS NOT DISTINCT FROM NEW.action) AND
      (OLD.target_kind IS NOT DISTINCT FROM NEW.target_kind) AND
      (OLD.target_id IS NOT DISTINCT FROM NEW.target_id) AND
      (OLD.details IS NOT DISTINCT FROM NEW.details) AND
      (
        -- tenant_id cascade: old non-null, new null; actor_user_id unchanged.
        (OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS NULL
           AND OLD.actor_user_id IS NOT DISTINCT FROM NEW.actor_user_id)
        OR
        -- actor_user_id cascade: old non-null, new null; tenant_id unchanged.
        (OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL
           AND OLD.tenant_id IS NOT DISTINCT FROM NEW.tenant_id)
        OR
        -- Both cascades fire in the same statement (deleting both
        -- the actor user AND their tenant).
        (OLD.tenant_id IS NOT NULL AND NEW.tenant_id IS NULL
           AND OLD.actor_user_id IS NOT NULL AND NEW.actor_user_id IS NULL)
      );

    IF is_cascade_set_null THEN
      RETURN NEW;
    END IF;
  END IF;

  RAISE EXCEPTION
    'audit_log rows are immutable (security audit F-32). % is not allowed; only INSERT and SELECT are. The only exception is the SET NULL cascade on tenant_id / actor_user_id when a tenant or user is deleted.',
    TG_OP
    USING ERRCODE = '42501';
END;
$$;

COMMENT ON FUNCTION reject_audit_log_mutation() IS
  'F-32: refuses to rewrite audit_log history. Exempts the ON DELETE SET NULL cascade on tenant_id and actor_user_id (re-audit 2026-05-25).';
