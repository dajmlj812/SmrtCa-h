-- 0.18.13 — Daily capacity snapshots for the /health capacity widget.
--
-- The in-memory metricsRecorder keeps only ~1 hour of operational data.
-- Capacity planning ("when do I need a new server?") needs multi-day
-- growth trends. This table holds one row per day with the sizes we
-- need to project forward.
--
-- Writes are upsert-by-date — the operator gets one row per UTC day no
-- matter how many times the snapshot job fires. Hooked into the
-- existing backup scheduler so daily backups also leave a capacity
-- breadcrumb, and lazily written when the /api/health/capacity
-- endpoint is hit (so a fresh install has at least one data point
-- after the operator visits the page).

CREATE TABLE IF NOT EXISTS health_capacity_snapshots (
  -- UTC date. One snapshot per day; subsequent writes UPSERT.
  snapshot_date     date PRIMARY KEY,

  -- Wall-clock time the snapshot was taken (the latest update for that
  -- date). Useful for "is the data fresh" indicators.
  captured_at       timestamptz NOT NULL DEFAULT now(),

  -- Database size from pg_database_size().
  db_bytes          bigint NOT NULL,

  -- Sum of file sizes under the attachments dir.
  attachments_bytes bigint NOT NULL,

  -- Sum of file sizes under the backups dir.
  backups_bytes     bigint NOT NULL,

  -- Disk free space on the volume hosting attachments (statfs).
  -- NULL on platforms where statfs isn't available.
  disk_total_bytes  bigint,
  disk_free_bytes   bigint
);

-- The projection query reads recent rows; the PK on snapshot_date gives
-- us the index we need to scan in date order. No additional index.

COMMENT ON TABLE  health_capacity_snapshots IS
  'Daily byte-size snapshots for /health capacity projection. See 0.18.13.';
COMMENT ON COLUMN health_capacity_snapshots.snapshot_date IS
  'UTC date — one snapshot per day, upserted by the backup job and lazily by the /api/health/capacity endpoint.';
