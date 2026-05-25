# SmrtCash Terms of Service

> **DRAFT — NOT YET IN EFFECT.** This document is a draft prepared for legal review. It is not binding on either BuildITSmrt LLC or any user of SmrtCash until approved by counsel and published with an effective date.

**Effective date**: 2026-05-25
**Last updated**: 2026-05-25

## 1. Agreement

These Terms of Service (**"Terms"**) are a contract between you and **BuildITSmrt LLC**, a limited liability company organized under the laws of the State of Wisconsin, United States ("**BuildITSmrt**", "**we**", "**us**", or "**our**"). They govern your use of **SmrtCash**, our hosted personal-finance application, including the web application, public marketing site, public read-only API, and any related software or services we offer (collectively, the **"Service"**).

**By creating a SmrtCash account, clicking "I agree" on the sign-up form, or otherwise accessing or using the Service, you accept these Terms.** If you do not accept them, do not use the Service.

Please also read our [Privacy Policy](/privacy), which explains how we handle information about you. The Privacy Policy is part of these Terms.

> **Important provisions.** Section 11 disclaims warranties. Section 12 limits our liability. Section 14 requires you to resolve most disputes through individual arbitration and waives your right to participate in a class action. **Read those sections carefully.**

## 2. Eligibility and accounts

### 2.1 Eligibility

You may use the Service only if you are at least 18 years old (or the age of majority where you live, whichever is greater) and able to form a binding contract under applicable law. By using the Service you represent that you meet these requirements.

The Service is intended for personal use by individuals and households. It is not designed for, and we do not knowingly accept, accounts that exist to process the financial data of customers, clients, or employees of a business (other than the individual's personal finances).

### 2.2 Your account

You are responsible for keeping your account credentials secure. You agree to:

- choose a unique, sufficiently strong password and not reuse it elsewhere;
- not share your account or password with another person;
- notify us promptly at legal@builditsmrt.com if you believe your account has been compromised;
- keep the email address on file current so we can reach you about security or billing issues.

You are responsible for everything that happens under your account, except where the cause is our fault.

### 2.3 Household members

A household tenant on the Family plan may include up to the seat count permitted by the plan. The household administrator (typically the account owner) is responsible for what other members do within the tenant. We treat each member as a separate user with their own account, but the administrator can revoke a member's access at any time.

## 3. The Service

### 3.1 What we do

SmrtCash provides tools that help you organize, categorize, budget, and forecast your personal finances. It does **not** provide:

- Tax advice;
- Investment, brokerage, or retirement-planning advice;
- Legal or accounting advice;
- A bank account, money-transmission service, or stored-value account.

You are solely responsible for the financial decisions you make. Information SmrtCash displays (including the output of the AI assistant) is informational. See Sections 6 and 11.

### 3.2 What we may add or change

We are constantly working on the Service. We may add, remove, or modify features. We will not, without notice, remove a paid feature in a way that materially degrades the value of your current subscription tier. If we do so, you may cancel and receive a pro-rata refund of the unused portion of any prepaid term.

### 3.3 Beta features

Features we label "beta," "preview," "experimental," or similar are still under development. They may break, change, or be removed without notice. We do not provide service-level commitments for beta features.

## 4. Subscription, billing, free trial, and cancellation

### 4.1 Plans

SmrtCash is sold as an auto-renewing subscription on one of the following tiers:

| Tier | Price | Notes |
|---|---|---|
| **Starter (monthly)** | US $5.99 / month | Core features |
| **Starter (annual)** | US $29.99 / year | ~58% savings vs monthly |
| **Plus (monthly)** | US $14.99 / month | Adds AI assistant, anomaly alerts, OCR, additional bank connections |
| **Plus (annual)** | US $74.99 / year | ~58% savings vs monthly |
| **Family (monthly)** | US $19.99 / month | Adds household seats, per-account permissions, bill splitting |
| **Family (annual)** | US $99.99 / year | ~58% savings vs monthly |

Current pricing and the specific feature breakdown by tier are listed at /billing within the Service. The Service treats your subscription state as the source of truth; if there is a discrepancy with this document, the application's billing page controls.

### 4.2 Free trial

New accounts may receive a free trial of up to 14 days. **A payment method is required to start the trial**, and your subscription will automatically convert to a paid subscription at the end of the trial unless you cancel before the trial ends. You can cancel any time during the trial from /billing.

### 4.3 Auto-renewal

**Your subscription renews automatically** at the end of each billing period (monthly or annual) at the then-current published price until you cancel. We will charge the payment method on file. You authorize us, through our payment processor Stripe, to do so.

### 4.4 How to cancel

You can cancel any time at /billing → "Manage subscription" → "Cancel subscription," or by visiting Stripe's customer portal at the URL the Service provides. Cancellation takes effect at the end of your current billing period. You retain access to paid features through that date.

We do not require you to call us, write to us, or speak to a person to cancel. The cancellation flow has the same number of steps as the signup flow.

### 4.5 Refunds

Subscription fees are non-refundable except as required by law or as expressly provided in these Terms. Specifically:

- If you cancel during the free trial, no charge is made.
- If you cancel after the trial ends, we do not refund the partial period.
- If you cancel annual within 14 days of paying, we will refund the annual fee in full.
- If we materially degrade the Service in a way that you've relied on (see Section 3.2), you may cancel and we will refund the pro-rata unused portion of any prepaid term.

### 4.6 Failed payments and grace period

If a payment fails, we will notify you by email and retry the payment on the schedule set by Stripe. If we cannot collect within a reasonable retry window, we will downgrade your account to read-only access. After a further grace window (typically 30 days), we may suspend your account. Your data is retained per Section 8 of the Privacy Policy.

### 4.7 Taxes

Prices listed are in U.S. dollars and **exclude** any applicable sales tax, VAT, GST, or similar tax. If a tax applies in your jurisdiction, we may add it to your bill in compliance with the law of your jurisdiction. If we are required to collect VAT in the EU or GST in another country, that amount will appear separately on your receipt.

### 4.8 Price changes

We may change the price of the Service. If we do, we will email you at least 30 days before the change takes effect. The new price will apply to your next renewal. If you do not accept the new price, you can cancel before the change takes effect and continue at the old price through the end of your current period.

## 5. Bank connections

### 5.1 Plaid (recommended)

The Service offers an optional integration with Plaid, Inc. so you can link a bank account and have transactions synced automatically. When you choose to link via Plaid:

- You enter your bank credentials directly into Plaid's hosted widget; **we never see your bank password**.
- Plaid grants us a per-account access token that lets us pull transactions and balances. We store that token encrypted (see Privacy Policy, Section 7).
- Plaid's own privacy policy (https://plaid.com/legal/) governs Plaid's handling of your bank credentials and the data it pulls on your behalf.
- The Service uses Plaid only to read your data — not to move money, initiate payments, or change anything at your bank.

### 5.2 OFX Direct Connect (advanced)

If your bank does not support Plaid and exposes OFX Direct Connect, you can enter your bank username and password directly into the Service. We encrypt those credentials at rest with AES-256-GCM and decrypt them only at sync time. If you use OFX Direct Connect, **you are entrusting us with those credentials**; rotate them and remove the connection from the Service if you ever suspect compromise.

### 5.3 File imports

If you do not want to link a bank, you can import bank-exported CSV/OFX/QFX/QIF files manually. The Service stores the resulting transactions but not any credentials.

### 5.4 Accuracy of synced data

Bank-synced data is only as accurate as the source. Plaid and OFX Direct Connect occasionally miss or misclassify transactions. We are not responsible for errors in the underlying data. You should reconcile against your bank's official statements periodically — the Service includes a reconciliation tool to help.

## 6. AI Assistant

### 6.1 What it does

The optional AI assistant is powered by Anthropic's Claude API. When you interact with it, your messages (and the read-back data from the tools it calls on your behalf, scoped to your tenant only) are sent to Anthropic. Anthropic processes the data per its API terms and does not train on it (consistent with Anthropic's commercial API policy as of the effective date of these Terms).

### 6.2 It is not financial advice

**The AI assistant is informational, not advisory.** It can answer questions about your existing data, run categorical analyses, and execute simple write operations you have explicitly authorized. It does not:

- Provide personalized financial planning;
- Recommend investments, securities, or insurance;
- Provide tax advice;
- Provide legal or accounting advice.

Information the assistant produces may be inaccurate, outdated, or simply wrong. Verify any number before relying on it.

### 6.3 Audit trail and reversibility

Every write the assistant performs is recorded in the audit log with the action, the affected resource, and the input the assistant used. You can review and reverse those changes from the in-app audit view.

### 6.4 Quotas

The AI assistant is metered. Each user message counts as one assistant interaction against your plan's monthly cap. When you exceed the cap, the assistant returns an over-quota response until the next billing period or until you upgrade.

## 7. Your content

### 7.1 You own your data

You retain all rights to the data and content you upload, enter, or generate within the Service ("**Your Content**"). Your Content includes your transactions, attachments, budgets, goals, AI conversation history, and anything else you create.

### 7.2 License to us

To operate the Service for you, you grant us a non-exclusive, worldwide, royalty-free license to host, store, process, transmit, display, and make backup copies of Your Content. The license exists solely to provide the Service to you and ends when you delete Your Content or close your account (subject to the retention periods in Section 8 of the Privacy Policy).

### 7.3 You are responsible for what you upload

You represent that you have the right to upload Your Content and that doing so does not violate any third party's rights or any applicable law. Do not upload:

- Other people's financial data unless you have their explicit permission;
- Anything illegal in your jurisdiction;
- Content that infringes copyright, trademark, or other intellectual property;
- Malware or attempts to attack the Service.

If we believe Your Content violates this section, we may remove it and (in serious cases) terminate the account responsible.

### 7.4 Feedback

If you send us feedback or suggestions, we may use them for any purpose without compensation or attribution. We won't claim you said anything specifically unless you give us permission.

## 8. Acceptable use

You may not, and you may not authorize anyone else to:

- **Reverse-engineer, decompile, or disassemble** the Service, except to the limited extent permitted by applicable law;
- **Probe, scan, or test the vulnerability** of the Service or any system or network connected to the Service, except under a written authorization from us. (Responsible disclosure: please email legal@builditsmrt.com with any security finding; we'll acknowledge within 5 business days.)
- **Bypass or attempt to bypass any access control, rate limit, authentication system, or quota** in the Service;
- **Use the Service to send spam, phishing, or unsolicited bulk messages**;
- **Scrape, crawl, or otherwise extract data from the Service** other than through documented APIs, with your own credentials, and at a reasonable rate;
- **Resell, sublicense, or commercially redistribute** the Service or your access to it;
- **Use the Service in a manner that violates applicable law** (e.g., to launder money, to facilitate fraud, to evade sanctions, to violate tax law);
- **Use the Service to develop a competing product** that is substantially derived from the Service's design, features, or user interface;
- **Impersonate another person or organization**;
- **Submit deliberately malicious files** to the attachments, OCR, or import features.

If you violate these rules, we may suspend or terminate your account, with or without notice depending on the severity.

## 9. Intellectual property

### 9.1 Our IP

The Service, including the software, design, content, trademarks, and "look and feel," is owned by BuildITSmrt or its licensors and is protected by U.S. and international intellectual-property laws. We grant you a personal, non-exclusive, non-transferable, revocable license to access and use the Service for its intended purpose for the duration of your subscription.

Nothing in these Terms transfers any of our intellectual property to you.

### 9.2 Trademarks

"SmrtCash" and the SmrtCash logo are trademarks of BuildITSmrt LLC. You may not use them without our prior written permission, except to factually identify the Service in commentary or reviews.

### 9.3 Open-source notices

The Service incorporates open-source software. Where required by the applicable open-source license, attribution is provided in the application's About page.

## 10. Termination

### 10.1 Termination by you

You can close your account any time from your settings page. Closing your account cancels any active subscription at the end of the current billing period and triggers the data-deletion procedure described in the Privacy Policy.

### 10.2 Termination by us

We may suspend or terminate your account if:

- You materially breach these Terms (including the Acceptable Use rules in Section 8);
- We are required to do so by law;
- Continuing to provide the Service to you would expose us to legal or financial risk we cannot reasonably manage;
- Your account remains delinquent for more than 60 days; or
- You die or are adjudged incompetent (we may, at our discretion, work with an estate executor or guardian to transfer or close the account).

Except in cases of material breach or legal compulsion, we will give you at least 30 days' notice before terminating an account in good standing, and we will refund the pro-rata unused portion of any prepaid term.

### 10.3 Effect of termination

After termination, your right to use the Service ends. Your data is retained, exported, or deleted according to Section 8 of the Privacy Policy. Sections that by their nature should survive termination (e.g., Sections 7.2, 9, 11, 12, 13, 14, 16) will survive.

## 11. Disclaimers

**THE SERVICE IS PROVIDED "AS IS" AND "AS AVAILABLE," WITHOUT ANY WARRANTIES OF ANY KIND, EXPRESS OR IMPLIED.** To the maximum extent permitted by law, we disclaim all warranties, including but not limited to implied warranties of merchantability, fitness for a particular purpose, title, and non-infringement.

We do not warrant that:

- The Service will be uninterrupted, error-free, or secure (though we take security seriously and Section 7 of the Privacy Policy describes what we do);
- The information displayed by the Service is accurate, complete, or current;
- Bank-synced data will be timely or complete;
- The AI assistant's output is correct, suitable, or risk-free;
- The Service will meet your particular needs.

**The Service is not a substitute for professional financial, tax, legal, or accounting advice.** Consult a qualified professional before making any decision based on the Service.

Some jurisdictions do not allow the exclusion of certain warranties. In those jurisdictions, this section applies to the maximum extent permitted.

## 12. Limitation of liability

**To the maximum extent permitted by law, in no event will BuildITSmrt LLC, its officers, directors, employees, agents, or licensors be liable for any indirect, incidental, special, consequential, exemplary, or punitive damages** — including but not limited to lost profits, lost data, lost goodwill, business interruption, or cost of substitute services — arising out of or in connection with the Service or these Terms, even if we have been advised of the possibility of such damages.

**Our aggregate liability for any claim arising out of or in connection with the Service or these Terms will not exceed the greater of (a) US $100, or (b) the total amount you paid us for the Service in the 12 months immediately preceding the event that gave rise to the claim.**

Some jurisdictions do not allow these limitations. In those jurisdictions, our liability is limited to the maximum extent permitted.

## 13. Indemnification

You will defend, indemnify, and hold harmless BuildITSmrt and its officers, directors, employees, and agents from and against any third-party claim, damage, loss, or expense (including reasonable attorneys' fees) arising out of (a) your breach of these Terms or applicable law, (b) your misuse of the Service, or (c) Your Content. We will notify you promptly of any such claim and let you control its defense (with our reasonable cooperation), provided you do not settle any matter that imposes liability on us without our consent.

## 14. Disputes — arbitration and class action waiver

**READ THIS SECTION CAREFULLY. IT AFFECTS YOUR RIGHTS.**

### 14.1 Informal resolution first

Most disputes can be resolved by talking. Before filing arbitration, please email legal@builditsmrt.com with a description of the dispute. We will try in good faith to resolve it within 60 days.

### 14.2 Arbitration

If we cannot resolve a dispute informally, **you and BuildITSmrt agree to resolve any dispute, claim, or controversy arising out of or relating to these Terms or the Service through final and binding arbitration**, except as described in Section 14.4.

Arbitration will be administered by the American Arbitration Association ("AAA") under its Consumer Arbitration Rules. The arbitration will take place in Milwaukee, Wisconsin or, if you prefer, by telephone or video conference if your claim is for less than US $25,000. The arbitrator's decision is binding.

We will pay our own filing, administrative, and arbitrator fees. We will also pay your filing fee if your claim is for less than US $10,000 and you are an individual consumer. For larger claims, fees follow the AAA rules.

### 14.3 Class action waiver

**You and BuildITSmrt agree that any arbitration or court proceeding will be conducted on an individual basis only, and not as a class, collective, consolidated, or representative action.** The arbitrator has no authority to consolidate more than one person's claims or preside over any form of class or representative proceeding. If a court finds this class-action waiver unenforceable, the entire Section 14 will be unenforceable and the dispute will proceed in court.

### 14.4 Carve-outs

The following disputes are not subject to arbitration:

- Small-claims-court disputes that fit within the court's jurisdictional limits;
- Disputes seeking injunctive or other equitable relief to stop unauthorized use of, or infringement of, intellectual property.

### 14.5 Opt-out

You can opt out of the arbitration agreement and class-action waiver by sending an email to legal@builditsmrt.com within 30 days of first accepting these Terms (or within 30 days of these Terms being amended in a way that materially changes Section 14). Include your name, the email address associated with your account, and a clear statement that you opt out. Opting out does not affect any other provision of these Terms.

### 14.6 Governing law and venue (if Section 14 is unenforceable)

These Terms are governed by the laws of the State of Wisconsin, without regard to its conflict-of-laws rules. If Section 14 is unenforceable for any reason, the state and federal courts in Wisconsin have exclusive jurisdiction over disputes that would otherwise have been arbitrated, and you and we both consent to that jurisdiction.

## 15. Changes to these Terms

We may update these Terms from time to time. If we make a material change — such as a change in price, in the scope of the license you grant us, in the limitation of liability, or in the arbitration clause — we will notify you by email at least 30 days before the change takes effect and require you to acknowledge the change before continuing to use the Service. Non-material changes (typos, formatting, contact-information updates) will be published with an updated "Last updated" date. If you continue to use the Service after a change takes effect, you accept the updated Terms.

## 16. Miscellaneous

### 16.1 Entire agreement

These Terms, the Privacy Policy, the Cookie Notice, and any plan-specific terms presented at sign-up are the entire agreement between you and BuildITSmrt regarding the Service. They supersede any prior agreement, oral or written.

### 16.2 Severability

If any provision of these Terms is found unenforceable, the remainder remains in effect. The parties (or a court) will replace the unenforceable provision with the closest enforceable provision that reflects the original intent.

### 16.3 No waiver

If we don't enforce a provision of these Terms in a particular case, that doesn't mean we won't enforce it in the future.

### 16.4 Assignment

You may not assign these Terms or any rights under them without our prior written consent. We may assign these Terms (in whole or in part) to any successor in interest, including in a merger or sale.

### 16.5 Force majeure

We are not liable for failure to perform if the failure results from a cause beyond our reasonable control (acts of God, war, terrorism, government action, internet or power outages, public health emergencies, etc.).

### 16.6 Independent contractors

Nothing in these Terms creates a partnership, joint venture, agency, employment, or fiduciary relationship between you and BuildITSmrt.

### 16.7 Headings

Section headings are for convenience and do not affect interpretation.

### 16.8 Notices

We may send notices to you by email at the address on file or by posting them in the Service. You can send notices to us at:

**BuildITSmrt LLC**
Attn: Legal
8859 Creekside Cir, Pleasant Prairie, WI 53158
Email: legal@builditsmrt.com

For service of process:

**BuildITSmrt LLC**
Attn: Registered Agent
8859 Creekside Cir, Pleasant Prairie, WI 53158

### 16.9 Government users

If you are a U.S. federal-government end user, you acknowledge that the Service is a "commercial item" and "commercial computer software" under FAR 2.101 and DFARS 252.227-7014. Your rights are no greater than those of any other end user under these Terms.

### 16.10 Export controls

You may not use the Service in a country subject to a U.S. government embargo, or if you are on a U.S. government list of prohibited or restricted parties.

---

If you have questions about these Terms, please email **legal@builditsmrt.com**.
