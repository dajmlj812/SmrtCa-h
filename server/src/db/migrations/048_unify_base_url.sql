-- Migration 048 (0.18.8): collapse APP_BASE_URL +
-- STRIPE_PUBLIC_BASE_URL into a single PUBLIC_BASE_URL key.
--
-- Background: pre-0.18.8 we had two settings answering the same
-- question — "what URL should outgoing email/Stripe links use?".
-- During the smrtcash-test deploy an operator typo'd APP_BASE_URL
-- with `@` instead of `.`; only the invitation flow broke because
-- signup-verification reads the OTHER key. Took hours to diagnose.
--
-- Backfill order (strongest signal wins):
--   1. STRIPE_PUBLIC_BASE_URL — used by signup verification,
--      password reset, dunning, Stripe Checkout. If it's set
--      it's the one people have been actually using for emails.
--   2. APP_BASE_URL — used only by invitations.
--
-- We DO NOT delete the old rows here. Reasons:
--   - the old keys disappear from KNOWN_SETTINGS in 0.18.8 so the
--     UI stops showing them.
--   - but `getEffectiveValue('PUBLIC_BASE_URL')` falls back to the
--     env, and an operator might still have `APP_BASE_URL=...` in
--     their `.env`. The migration's job is just to seed the new
--     setting; the helper handles the rest.

INSERT INTO app_settings (key, value, is_secret)
SELECT 'PUBLIC_BASE_URL', value, false
  FROM app_settings
 WHERE key IN ('STRIPE_PUBLIC_BASE_URL', 'APP_BASE_URL')
   AND value IS NOT NULL
   AND value <> ''
 ORDER BY CASE key
            WHEN 'STRIPE_PUBLIC_BASE_URL' THEN 0
            WHEN 'APP_BASE_URL'           THEN 1
          END
 LIMIT 1
 ON CONFLICT (key) DO NOTHING;

-- Cleanup: remove the old rows now that PUBLIC_BASE_URL carries
-- the truth. The keys are no longer in KNOWN_SETTINGS so they
-- can't be set again from the UI; env-var fallback continues to
-- work via the base-url helper for operators who still have the
-- old names in `.env`.
DELETE FROM app_settings
 WHERE key IN ('STRIPE_PUBLIC_BASE_URL', 'APP_BASE_URL');
