-- Migration 011: Phase 7.0 — investment holdings + manual asset/liability accounts.
--
-- Two changes:
--
-- 1. holdings — one row per position in an investment account
--    (e.g. 50 shares of VOO with a $200 cost basis and $230 last
--    price). The investment account's reported balance includes its
--    cash transactions PLUS the market value of every holding
--    (quantity × last_price_cents). Holdings are entered manually;
--    auto-price-fetching is a future hook.
--
-- 2. New account types: manual_asset (house, car, art) and
--    manual_liability (mortgage, auto loan). These accounts have no
--    transactions — their value lives in opening_balance_cents and
--    the user adjusts it periodically. Convention: liabilities are
--    stored as NEGATIVE amounts so they reduce net worth via the same
--    SUM() that sums everything else.

CREATE TABLE holdings (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  symbol           text,
  name             text NOT NULL,
  -- Six decimals supports fractional shares + crypto.
  quantity         numeric(18, 6) NOT NULL CHECK (quantity > 0),
  cost_basis_cents bigint NOT NULL DEFAULT 0,
  last_price_cents bigint NOT NULL DEFAULT 0 CHECK (last_price_cents >= 0),
  last_price_date  date,
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX holdings_account_idx ON holdings(account_id);

-- The original 001_init.sql constraint listed seven types. Add the two new
-- ones. Drop-and-recreate via DO block so we don't depend on the
-- auto-generated constraint name (it's `accounts_type_check` in practice
-- but lookup it up is robust).
DO $$
DECLARE
  cname text;
BEGIN
  SELECT con.conname INTO cname
    FROM pg_constraint con
    JOIN pg_class rel ON rel.oid = con.conrelid
   WHERE rel.relname = 'accounts'
     AND con.contype = 'c'
     AND pg_get_constraintdef(con.oid) ILIKE '%type%checking%savings%';
  IF cname IS NOT NULL THEN
    EXECUTE 'ALTER TABLE accounts DROP CONSTRAINT ' || quote_ident(cname);
  END IF;
END $$;

ALTER TABLE accounts
  ADD CONSTRAINT accounts_type_check
    CHECK (type IN (
      'checking','savings','credit_card','cash',
      'investment','loan','other',
      'manual_asset','manual_liability'
    ));
