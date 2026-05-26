-- Migration 062 (0.20.1): assistant staged actions.
--
-- When the user asks the assistant for a complex multi-step change
-- ("reorganize my budgets along Ramsey 50/30/20"), we want a
-- stage/preview/commit gate so the user reviews the proposed diff
-- before any writes happen. Each batch:
--
--   • actions  — JSONB array of { tool, input } the assistant proposes.
--   • inverses — JSONB array of { tool_name, payload } captured at
--                commit time. Used by /undo to reverse.
--   • status   — 'pending' (created, not yet applied),
--                'applied'  (executed successfully),
--                'undone'   (reverted via /undo),
--                'failed'   (commit attempted but threw).
--
-- 30-day TTL: pending batches that never get applied get pruned. The
-- audit log captures the apply/undo events for forensic history.

CREATE TABLE assistant_staged_batches (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status      TEXT        NOT NULL DEFAULT 'pending',
  summary     TEXT        NOT NULL,
  actions     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  inverses    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  error       TEXT        NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  applied_at  TIMESTAMPTZ NULL,
  undone_at   TIMESTAMPTZ NULL,
  CONSTRAINT assistant_staged_batches_status_check CHECK (status IN (
    'pending', 'applied', 'undone', 'failed'
  ))
);

CREATE INDEX idx_assistant_staged_batches_tenant_user
  ON assistant_staged_batches (tenant_id, user_id, created_at DESC);

COMMENT ON TABLE assistant_staged_batches IS
  '0.20.1 — assistant stage-and-commit batches. Each row is a proposed multi-step change the assistant offered, which the user then reviewed + applied or discarded.';
