# Privacy Policy — SmrtCash

**THIS IS A PLACEHOLDER.** The text below is a structural stub
to be replaced by lawyer-reviewed copy before any commercial
launch, with specific attention to GDPR/CCPA/PIPEDA disclosure
requirements in the jurisdictions where customers live.

Last updated: 2026-05-24

---

## 1. What we collect

- **Account data**: email, hashed password (Argon2id), display
  name, household membership relationships.
- **Financial data you upload or sync**: account names,
  balances, transactions, attachments (receipts), bills,
  budgets, goals, holdings, vehicles.
- **Usage data**: which features you use, AI assistant message
  counts, OCR receipt counts (these power your /billing usage
  meters).
- **Operational telemetry**: process metrics, error logs.
  Logs are scrubbed of personally identifiable data.

## 2. What we don't collect

- We don't track marketing pixels, behavioral analytics, or
  third-party cookies.
- We don't read transaction descriptions for advertising
  targeting.
- We don't sell your data.

## 3. Third-party processors

- **Stripe** — payment processing. Card numbers never touch
  our servers; Stripe handles all PCI scope. We store only
  Stripe customer + subscription IDs.
- **Plaid** (optional) — bank-account aggregation. Only
  invoked when you connect a bank account. Plaid's privacy
  policy applies in addition.
- **Anthropic** (optional) — AI assistant + receipt OCR.
  Transaction descriptions you send to the assistant are
  transmitted to Anthropic per their data-handling agreement
  for the API tier in use.
- **SMTP provider** (operator-configured) — outbound mail
  (invitations, dunning emails) goes through whichever SMTP
  relay the deployment configures.

## 4. Storage + encryption

- Database: PostgreSQL on the operator's infrastructure.
- Attachments: stored on the operator's filesystem; encrypted
  at rest with `ATTACHMENT_ENCRYPTION_KEY` (envelope encryption
  upgrade planned).
- Passwords: Argon2id hashes (never plaintext, never
  reversible).

## 5. Retention

- Active subscription: all data retained.
- Cancellation: 30-day full-restore window (you may resubscribe
  and recover everything), then 60 additional days of
  export-only access, then deletion.
- You may request immediate deletion via the support contact
  below; we will purge within 30 days.

## 6. Your rights

- **Export**: full data export available from the Backups
  page at any time.
- **Correct**: edit any data via the application.
- **Delete**: see section 5; immediate deletion on request.
- **Access**: receive a structured copy of your data via the
  export feature.

(Specific rights vary by jurisdiction; this section will be
finalized by counsel.)

## 7. Children

SmrtCash is not directed at children under 13 (or the local
minimum where higher). We do not knowingly collect data from
children.

## 8. Changes

We will notify you of material changes 30 days before they
take effect.

## 9. Contact

[contact email — to be filled in before launch]
