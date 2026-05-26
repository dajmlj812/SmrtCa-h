-- Migration 060 (0.19.3): investment-analysis fields on holdings.
--
-- Two new nullable columns let us run Empower-class portfolio
-- analysis on top of the existing holdings rows:
--
--   expense_ratio  — annual fee percentage (0.04 = 4 basis points,
--                    e.g. VTI's typical ETF expense). Drives the
--                    portfolio-wide fee-drag analyzer + 30-year
--                    compounded opportunity-cost figure.
--
--   asset_class    — buckets a holding for the allocation pie chart
--                    + target-vs-actual deviation. Five values cover
--                    a typical retail portfolio; users editing per-
--                    holding can leave NULL and the analyzer falls
--                    back to a derived class based on asset_type
--                    (stock/etf/mutual_fund → 'stocks', bond →
--                    'bonds', crypto → 'alts', commodity → 'alts').
--
-- Both are operator-fillable at any time without re-running prices.
-- The analyzer surfaces NULL fields so users can see what they need
-- to fill in.

ALTER TABLE holdings
  ADD COLUMN expense_ratio NUMERIC(6,3) NULL,
  ADD COLUMN asset_class   TEXT          NULL;

ALTER TABLE holdings
  ADD CONSTRAINT holdings_expense_ratio_check
    CHECK (expense_ratio IS NULL OR (expense_ratio >= 0 AND expense_ratio <= 10));

ALTER TABLE holdings
  ADD CONSTRAINT holdings_asset_class_check
    CHECK (asset_class IS NULL OR asset_class IN (
      'stocks', 'bonds', 'cash', 'alts', 'real_estate'
    ));

COMMENT ON COLUMN holdings.expense_ratio IS
  '0.19.3 — annual expense ratio as a percentage (e.g. 0.040 = 0.040%/yr = 4 basis points). NULL = unknown. Used by /api/investments/analysis to compute total annual fee drag and 30-year compounded opportunity cost.';
COMMENT ON COLUMN holdings.asset_class IS
  '0.19.3 — manual asset-class tag for the allocation pie chart. One of: stocks, bonds, cash, alts, real_estate. NULL falls back to a derived class based on asset_type.';
