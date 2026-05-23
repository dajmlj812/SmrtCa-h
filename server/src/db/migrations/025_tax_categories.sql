-- Migration 025 (backlog 0.13.1): tax-category tagging on categories.
--
-- One free-text column. NULL means "not tax-relevant" — the
-- year-end report only aggregates categories where this is set.
-- We deliberately don't enum the values: US Schedule A vs C vs
-- self-employed deductions are too varied to bake into a CHECK, and
-- the report doesn't care WHICH value as long as matching rows
-- aggregate under the same label.

ALTER TABLE categories
  ADD COLUMN tax_category text;

-- Helpful when the year-end report does a full-table scan grouped
-- by this column — typical category count is in the dozens, but the
-- partial index keeps the planner honest if it grows.
CREATE INDEX categories_tax_category_idx
  ON categories (tax_category)
  WHERE tax_category IS NOT NULL;
