-- Migration 016: Phase 7.6 — GUI-managed backups.
--
-- `backups` table records every backup attempt (manual or scheduled).
-- Each row points at the on-disk artifact (db.dump + attachments.tgz
-- inside a single timestamped directory) and tracks size + status so
-- the GUI can show history at a glance.
--
-- Backup *settings* (enabled / schedule / retention / target dir) ride
-- on the existing app_settings table; nothing schema-level needed for
-- them.

CREATE TABLE backups (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            text NOT NULL CHECK (kind IN ('manual','scheduled')),
  status          text NOT NULL DEFAULT 'running'
    CHECK (status IN ('running','success','failed','deleted')),
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  -- Absolute path to the directory containing db.dump + attachments.tgz.
  path            text NOT NULL,
  db_bytes        bigint,
  attachments_bytes bigint,
  total_bytes     bigint,
  error           text
);
CREATE INDEX backups_started_idx ON backups (started_at DESC);
CREATE INDEX backups_status_idx ON backups (status) WHERE status <> 'deleted';
