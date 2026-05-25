# SmrtCash — Legal Documents (Lawyer Review Drafts)

These are **DRAFTS** prepared by the development team for review by a licensed attorney before being published to customers. They are not legal advice and are not yet binding on either SmrtCash or its users.

**Status as of 2026-05-25**: operator decisions have been filled in (see "Operator decisions made" below). All `[PLACEHOLDER]` markers have been replaced with concrete values. Documents are ready for attorney review.

## Documents in this folder

1. **`PRIVACY_POLICY.md`** — Notice to data subjects of what we collect, why, who we share it with, and how to exercise their rights. Drafted to satisfy GDPR (EU/UK), CCPA/CPRA (California), CalOPPA, COPPA, and Gramm-Leach-Bliley Act notice obligations (financial-data context).

2. **`TERMS_OF_SERVICE.md`** — The contract between BuildITSmrt LLC and the customer. Covers subscription terms, acceptable use, AI assistant disclaimers, intellectual property, dispute resolution, and termination.

3. **`COOKIE_NOTICE.md`** — Short notice covering the strictly-necessary cookies SmrtCash uses today (session auth + Cloudflare). No analytics, marketing, or third-party tracking cookies are in scope at launch.

## How to read these as the reviewing attorney

The drafts try to describe accurately what the SmrtCash product actually does as of version 0.18.12 — not a generic SaaS template with company name swapped in. Specifically the documents are written assuming:

- **Operator**: BuildITSmrt LLC (US-based limited liability company; state of formation TBD — see placeholders).
- **Service**: SmrtCash, a hosted (SaaS) personal finance manager. Customers pay a recurring subscription fee. Self-hosting is no longer marketed as a customer option.
- **Data**: customers store transaction history, account balances, financial goals, budgets, receipts (attachments), bank-connection credentials, and (optionally) bank-sync state via Plaid. The product also stores categorization rules, recurring bills/income, holdings (including crypto), vehicles, and household members.
- **Subprocessors**:
  - **Stripe, Inc.** — payment processing + billing.
  - **Plaid Inc.** — bank connectivity (customer's choice; opt-in per bank).
  - **Anthropic, PBC** — the optional AI assistant (Claude API). Customer prompts and (only) the read-back data needed to answer them are sent to Anthropic's API per call.
  - **Maileroo** — transactional email delivery (verify-email, password reset, billing notifications).
  - **Cloudflare, Inc.** — edge proxy, TLS termination, DNS, bot management.
  - **Hostinger International Ltd.** — the VPS / container host. Production environment is in Hostinger's Boston, Massachusetts data center.
  - **U.S. Energy Information Administration** — free public API for fuel-price data; no customer data leaves to EIA.
- **Encryption**: per-tenant envelope encryption for attachments and bank-connection credentials (AES-256-GCM, per-tenant data-encryption key wrapped by a platform key-encryption key). Passwords are hashed with argon2id. TLS 1.3 in transit.
- **Pricing model (as of 0.18.x)**: three tiers (Starter / Plus / Family) at $5.99 / $14.99 / [Family-monthly-TBD] per month, with annual discounts of ~58%. 14-day free trial. Auto-renewing subscription. Cancel-any-time via the Stripe customer portal.
- **AI Assistant**: 17 server-side tools available to the model. Read tools query the user's own tenant data. Write tools (recategorize, set budget, mark bill paid, etc.) are audit-logged. The model never sees a tenant ID — every tool is scoped server-side to the requesting user's tenant.

## Operator decisions made (2026-05-25)

The operator (Derek Johnson, sole member of BuildITSmrt LLC) made the following decisions when filling in the placeholders. These are all visible in the documents and the attorney is welcome to challenge any of them.

| Item | Decision |
|---|---|
| Formation type | Limited liability company |
| State of formation / operation | Wisconsin |
| Mailing address | 8859 Creekside Cir, Pleasant Prairie, WI 53158 |
| Registered agent address | Same as mailing |
| Privacy contact email | `privacy@builditsmrt.com` |
| Legal contact email | `legal@builditsmrt.com` |
| Governing-law state | Wisconsin (same as formation) |
| Arbitration venue | Milwaukee, Wisconsin |
| Arbitration clause + class-action waiver | **Kept** — standard for US consumer SaaS, with the 30-day opt-out provision |
| Arbitration carve-outs | Standard pair only: small-claims court + IP-enforcement injunctive relief |
| EU / UK / EEA customers at launch | **Deferred** — Service is not marketed in those regions, no Article 27 representative appointed. Privacy Policy reflects this in Sections 1, 2, 6, and 10.2. |
| Pricing — Starter | US $5.99 / month, US $29.99 / year |
| Pricing — Plus | US $14.99 / month, US $74.99 / year |
| Pricing — Family | US $19.99 / month, US $99.99 / year |
| Free trial | 14 days, payment method required at signup, auto-converts to paid |
| Hosting | Hostinger International Ltd. — Boston, Massachusetts, United States |
| Effective date | 2026-05-25 |

## Decisions the lawyer should advise on

1. **EU/UK customers at launch?** If yes, GDPR Article 27 representative is required; the Privacy Policy already includes the necessary lawful-basis disclosures. If no, simpler — note that the service is not marketed in the EEA/UK and don't accept signups from those regions. The current draft assumes EU customers ARE accepted and includes the disclosures; remove if otherwise.

2. **Mandatory arbitration + class-action waiver?** Standard for U.S. consumer SaaS but consumer-unfriendly. The current draft INCLUDES it (Section 14 of ToS). Strike if undesired.

3. **Free trial conversion mechanics.** Current code/roadmap: 14-day free trial, then auto-converts to paid unless canceled. The ToS reflects this. FTC's "Click-to-Cancel" rule (final form 2024-2025) requires the cancellation flow be as easy as the signup flow — confirm the implementation matches.

4. **Tax handling.** Stripe Automatic Tax is OFF by default (per code). If/when it goes on, the ToS section 4 needs a tax-clause that says the listed price excludes applicable sales/VAT.

5. **California consumer notices** — the CCPA "Do Not Sell or Share" right is referenced; since SmrtCash doesn't currently sell or share personal info for cross-context behavioral advertising, the answer is "we don't do that" but a contact path is still required. Confirm the language.

6. **CAN-SPAM / TCPA** — if marketing emails or SMS are ever added, both documents need new sections. Today the only emails sent are transactional (verify, reset, billing, alerts). The drafts treat marketing as out of scope.

7. **No-financial-advice + no-tax-advice disclaimers** — the AI Assistant produces analyses that look like advice but are not. The ToS includes a strong disclaimer; lawyer should confirm strength is appropriate for the jurisdiction.

8. **Children's accounts** — the product supports a "child" role within a household for parents to grant their kids visibility. The Privacy Policy says the service is not directed at children under 13 and we do not knowingly collect their data, while acknowledging that a parent may add a child account on behalf of the child. Confirm this stance is defensible under COPPA (the service is not "directed at children" — it's a financial tool for the parent — but the parent may surface it to the child).

## Pre-existing security context the lawyer should know

The security audit at `docs/security-audit-2026-05-25.md` (committed alongside these documents) identifies several P0/P1 items that should be fixed before publishing these legal documents and accepting paying customers. The privacy policy describes the encryption and access controls as they exist post-fixes — specifically:

- The "Security" section assumes F-13 (backup snapshot KEK leak) is fixed.
- The "Your Rights" section assumes F-35 (no user-initiated account deletion) is fixed — i.e., users can in fact delete their account.
- The "Your Rights" section's "Right to data portability" assumes the existing per-user data export at `/api/portability` (introduced in earlier 0.13.x work) remains functional.

If those audit items have NOT been remediated when the documents go live, the policy and the product disagree, which is its own legal problem.

## After lawyer review

Once approved:

1. Move the approved versions out of `docs/legal/` into customer-facing routes (e.g., `web/src/pages/PrivacyPage.tsx`, `web/src/pages/TermsPage.tsx`, `web/src/pages/CookieNoticePage.tsx`).
2. Wire `/privacy`, `/terms`, `/cookies` routes in React Router.
3. Add footer links to all three from unauthenticated pages (login, signup, forgot-password) and from `/billing` (before checkout).
4. Add a "By creating an account, you agree to the Terms of Service and Privacy Policy" checkbox on signup. Per CCPA/CPRA, this needs to be unchecked by default and not pre-ticked.
5. The effective date in the documents (2026-05-25) is a draft date; reset it to the actual publication date when the lawyer's revisions are accepted and the documents go live.
6. Set a calendar reminder for an annual review.
