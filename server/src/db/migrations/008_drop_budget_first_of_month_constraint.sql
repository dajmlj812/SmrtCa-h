-- Migration 008: relax budgets.period_month to accept any date.
--
-- The original 006 schema constrained period_month to the 1st of a month
-- because monthly was the only supported cadence. With weekly / biweekly /
-- semimonthly / custom budgets now allowed (migration 007), the anchor
-- can fall on any day, so the constraint has to go.
--
-- Postgres named CHECK constraints get an auto-name like
-- `budgets_period_month_check` since the original definition was
-- inline (`CHECK (extract(day from period_month) = 1)`). We drop by
-- looking up the constraint name first so the migration works even if
-- the auto-name differs slightly.

DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'budgets'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%extract%day%period_month%';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE budgets DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;
