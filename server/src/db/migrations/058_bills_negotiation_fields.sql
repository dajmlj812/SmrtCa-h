-- Migration 058 (0.19.1): bill negotiation metadata.
--
-- Adjacent to 0.18.1's cancellation help: for detected recurring
-- bills that aren't really cancel candidates (utilities, internet,
-- cell, insurance), the lift is *negotiation* — surface the
-- provider's billing-dispute URL + a canned email asking for a
-- retention discount / lower tier / dispute review.
--
-- Same shape as the 043 cancellation columns (nullable text per
-- field). The Negotiate-info modal auto-fills blanks from a
-- shared library keyed by provider/category; users can edit
-- per-bill for their specific situation.

ALTER TABLE bills
  ADD COLUMN negotiate_url            text,
  ADD COLUMN negotiate_email_template text,
  ADD COLUMN negotiate_steps          text,
  ADD COLUMN negotiate_notes          text;

COMMENT ON COLUMN bills.negotiate_url IS
  '0.19.1 — provider URL for billing inquiries / rate review / dispute. Surfaced in the Negotiate-info modal.';
COMMENT ON COLUMN bills.negotiate_email_template IS
  '0.19.1 — canned email body asking for a retention discount, lower tier, or billing review.';
COMMENT ON COLUMN bills.negotiate_steps IS
  '0.19.1 — markdown step-by-step negotiation instructions (script outlines for phone calls, key phrases that unlock retention offers, etc.).';
COMMENT ON COLUMN bills.negotiate_notes IS
  '0.19.1 — caveats (best time to call, current promo windows, what the rep can vs. cannot do).';
