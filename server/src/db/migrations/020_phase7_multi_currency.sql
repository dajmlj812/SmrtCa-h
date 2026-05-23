-- Migration 020: Phase 7.1 multi-currency support.
--
-- `accounts.currency` already exists (ISO 4217 string, e.g. 'USD',
-- 'EUR'). What's missing is a place to store exchange rates so the
-- dashboard, net-worth chart, and insights endpoints can sum across
-- accounts denominated in different currencies.
--
-- The shape: one row per (from_currency, to_currency, fetched_at).
-- We keep history so a user can audit which rate was used for a given
-- moment. Lookups always pick the most-recent row per pair. A small
-- index on (from, to, fetched_at desc) makes that O(log n).
--
-- `source` distinguishes 'manual' rows (super-admin override) from
-- 'open.er-api.com' (or whichever fetcher we wire). Manual rows win
-- over auto-fetched rows when both exist — same pattern as
-- fuel_prices.

CREATE TABLE exchange_rates (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_currency text NOT NULL,
  to_currency   text NOT NULL,
  rate          numeric(20, 10) NOT NULL CHECK (rate > 0),
  source        text NOT NULL CHECK (source IN ('manual', 'open-er-api', 'frankfurter')),
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  CHECK (from_currency <> to_currency)
);
CREATE INDEX exchange_rates_pair_latest_idx
  ON exchange_rates (from_currency, to_currency, fetched_at DESC);

-- Identity row helper: USD → USD = 1.0. We don't actually store these
-- because the convert() helper short-circuits when from === to, but
-- the constraint above forbids them anyway.
