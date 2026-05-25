-- Migration 043 (0.18.1): cancellation metadata on bills.
--
-- Roadmap slice 0.18.1 — for each detected subscription, store
-- the cancellation URL, a canned email template, and step-by-step
-- instructions so the user can cancel without searching. SmrtCash
-- doesn't try to be the concierge (legal + ops moat); it just
-- removes the friction Rocket Money charges for.
--
-- All four columns are nullable text; the Cancel-info modal
-- auto-fills blanks from a shared library keyed by merchant
-- name, but everything is user-editable per-bill in case a
-- merchant changes their flow.

ALTER TABLE bills
  ADD COLUMN cancel_url            text,
  ADD COLUMN cancel_email_template text,
  ADD COLUMN cancel_steps          text,
  ADD COLUMN cancel_notes          text;

COMMENT ON COLUMN bills.cancel_url IS
  '0.18.1 — direct URL to cancel this bill/subscription. Surfaced in the Cancel-info modal on the Bills page.';
COMMENT ON COLUMN bills.cancel_email_template IS
  '0.18.1 — canned email body the user can copy + send to cancel by email when a URL flow isn''t available.';
COMMENT ON COLUMN bills.cancel_steps IS
  '0.18.1 — markdown step-by-step cancellation instructions for merchants whose UX hides the cancel button.';
COMMENT ON COLUMN bills.cancel_notes IS
  '0.18.1 — caveats (phone-only, retention call expected, etc.).';
