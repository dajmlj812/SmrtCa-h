-- Migration 027 (backlog 0.13.3): asset_type on holdings.
--
-- Distinguishes crypto from stocks / ETFs / mutual funds so the
-- price-refresh path can filter to just the rows that have a live
-- price feed (CoinGecko for crypto; stocks would need a separate
-- provider, currently manual). Existing rows default to 'stock';
-- the user re-tags any actual crypto rows after migrate.

ALTER TABLE holdings
  ADD COLUMN asset_type text NOT NULL DEFAULT 'stock'
    CHECK (asset_type IN (
      'stock', 'etf', 'mutual_fund', 'bond',
      'crypto', 'commodity', 'other'
    ));

-- Partial index so refresh-all-crypto stays cheap as the holdings
-- table grows.
CREATE INDEX holdings_asset_type_crypto_idx
  ON holdings (asset_type)
  WHERE asset_type = 'crypto';
