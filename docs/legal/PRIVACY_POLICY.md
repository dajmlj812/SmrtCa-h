# SmrtCash Privacy Policy

> **DRAFT — NOT YET IN EFFECT.** This document is a draft prepared for legal review. It is not binding on either BuildITSmrt LLC or any user of SmrtCash until approved by counsel and published with an effective date.

**Effective date**: 2026-05-25
**Last updated**: 2026-05-25

## 1. Who we are

SmrtCash (the **"Service"**) is a hosted personal-finance manager operated by **BuildITSmrt LLC**, a limited liability company organized under the laws of the State of Wisconsin, United States, with its mailing address at 8859 Creekside Cir, Pleasant Prairie, WI 53158 (**"BuildITSmrt"**, **"we"**, **"us"**, or **"our"**).

For the purposes of state and federal privacy laws (such as the California Consumer Privacy Act, as amended by the California Privacy Rights Act — collectively, "**CCPA/CPRA**"), BuildITSmrt is the **business** (or, under similar laws using the term, the **data controller**) of personal data we process about you when you use SmrtCash.

You can reach our privacy team at **privacy@builditsmrt.com** for any question covered by this policy or to exercise any right described in Section 10.

## 2. Scope

This policy describes how we collect, use, disclose, and safeguard information when you:

- Visit the public SmrtCash website at smrtcash.builditsmrt.com;
- Create an account and use the SmrtCash application; or
- Interact with us by email or via the in-app support links.

If you ever encounter a SmrtCash-branded surface that does not link back to this policy, please tell us at privacy@builditsmrt.com — we'd like to investigate.

**Geographic scope.** SmrtCash is offered to residents of the United States. The Service is not currently directed to, or marketed in, the European Economic Area, the United Kingdom, or Switzerland, and we have not appointed a representative under Article 27 of the EU or UK General Data Protection Regulation. If you reside in one of those regions and choose to use the Service anyway, please understand that your data will be stored in the United States and that, while we honor the universal rights described in Section 10.1 as a matter of company policy, we cannot guarantee compliance with every EU- or UK-specific obligation. We expect to expand to additional regions in the future and will update this policy accordingly.

## 3. What information we collect

We collect three broad categories of information from or about you. We try to be specific so you can see exactly what is going where.

### 3.1 Information you provide when you create an account

| Field | Purpose | Required? |
|---|---|---|
| Email address | To identify you, send verification + security notices, and recover access | Yes |
| Display name | Shown in the application; can be changed any time | Yes (defaults to the local part of your email if blank) |
| Password | Authenticates you. Stored only as an argon2id hash; the plaintext password never touches durable storage and is never logged | Yes (unless you sign in via a future single-sign-on integration) |

We do not require — and do not ask for — your date of birth, address, phone number, government identifier, or photograph at sign-up. If we ever add an optional field, we will tell you at the point we ask for it why we want it and whether the answer is required.

### 3.2 Financial and product data you create or import while using the Service

This is the core of what SmrtCash stores. By design, all of the following stays scoped to your "tenant" — your single-user account or your household — and is not shared with other tenants or with us for any purpose other than running the Service for you.

- **Accounts**: the financial accounts you add (checking, savings, credit card, brokerage, etc.), their nicknames, opening balances, currency, and per-account settings.
- **Transactions**: dates, amounts, descriptions, merchant names, categories, memos, transfer pairings, and similar metadata for each transaction you import or sync.
- **Receipts and attachments**: any image (JPEG, PNG, WebP) or PDF you attach to a transaction. These files are encrypted at rest using a per-tenant data-encryption key (see Section 7).
- **Budgets, goals, recurring bills, recurring income**: the categories you budget against, target amounts, savings-goal names and target dates, and the bills/income you mark as recurring.
- **Holdings**: investment and crypto holdings you manually record or that arrive via bank sync, including symbol, quantity, and cost basis if you provide it.
- **Vehicles and commute data**: optional, for users of the fuel-economy module — vehicle make/model/year, MPG, commute routes, mileage entries.
- **Bank-connection credentials**:
  - If you opt to connect a bank via **Plaid**, the bank credentials are entered directly into a Plaid-hosted widget that runs in your browser and never reach BuildITSmrt's servers. We store only the Plaid access token (encrypted), which lets us pull transaction history and account balances on your behalf. See Section 6 for Plaid's role.
  - If you opt to connect a bank via **OFX Direct Connect**, the username and password for the bank are stored encrypted in our database using AES-256-GCM with a key not present in standard backups; they are decrypted in memory only when a sync runs.
  - You can also import bank statements as CSV, OFX, QFX, or QIF files. In that case we store only the transaction data, not any credentials.
- **Categorization rules** you create or that the Service learns from your usage.
- **AI assistant conversations**: if you use the in-app AI assistant, we store the messages you sent to the assistant and the assistant's replies (including the tool calls it made on your behalf), so the conversation history is available across sessions and so a complete audit log of every write the assistant performed exists.

### 3.3 Information we collect automatically when you use the Service

- **Session cookies**: the `smrtcash_session` cookie identifies your authenticated session. It is `HttpOnly`, `Secure`, `SameSite=Strict`, and signed (HMAC) to prevent tampering. See the separate Cookie Notice.
- **Cloudflare cookies**: our edge provider sets bot-management cookies (e.g., `__cf_bm`) that we cannot prevent and that exist for security purposes.
- **Server logs**: standard request metadata — timestamp, request method and path, response status, your IP address, your browser's User-Agent string, and a unique request ID. We use these for security monitoring, abuse investigation, and debugging. We do not log request bodies for endpoints that handle credentials, financial details, or attachments.
- **API key usage**: if you mint a read-only API key in your account settings, we log the IP address and timestamp of each request that key makes so you can audit it.
- **Audit log**: every state-changing action (mutation) — yours, an assistant tool's, or a backend job's — is recorded in an internal audit table with the actor's user ID, tenant ID, action name, and the affected target's ID. The audit log is visible to BuildITSmrt for security and abuse review and to you for the actions within your tenant via the in-app audit history view.

### 3.4 What we do NOT collect

To save us all time later, here is what SmrtCash explicitly does **not** do today:

- **No advertising or tracking pixels**. We do not embed Google Analytics, Meta pixel, Hotjar, Segment, Mixpanel, or any other third-party analytics or marketing tag in the application or on the marketing site.
- **No selling, renting, or sharing personal information** for any third-party advertising or "cross-context behavioral advertising" purpose, as those terms are defined under the California Consumer Privacy Act / California Privacy Rights Act ("CCPA/CPRA").
- **No biometric data**.
- **No location tracking** beyond the IP-derived city-level information our edge logs naturally contain. We do not request GPS or device-location permissions.
- **No microphone, camera, or contact-list access**.

## 4. How we use information

We use the information described in Section 3 only for the purposes listed in this section.

| Purpose | Categories of information used | Legal basis (GDPR) |
|---|---|---|
| Provide the Service: store your data, run categorization, render reports, sync banks, etc. | Account info, financial data, server logs | Performance of a contract (Art. 6(1)(b)) |
| Authenticate you and secure your account | Account info, session cookies, server logs | Performance of a contract; legitimate interest in security (Art. 6(1)(f)) |
| Process subscription payments | Account info, plan + billing state (held by Stripe) | Performance of a contract |
| Send transactional emails (verify-email, password reset, billing receipts, anomaly alerts you've enabled) | Account info, financial data | Performance of a contract |
| Run the optional AI assistant when you ask it a question | The text of your question, the read-back data the tools query within your tenant | Performance of a contract |
| Detect and prevent abuse, fraud, security incidents | Server logs, audit log, account info | Legitimate interest in security |
| Improve the Service (fix bugs, plan features) | Aggregated, non-identifying usage information; survey responses you choose to share | Legitimate interest in improving our product |
| Comply with legal obligations (tax, accounting, law-enforcement requests with valid legal process) | As required by the applicable obligation | Legal obligation (Art. 6(1)(c)) |

We do **not** use your financial data to train AI models, sell to data brokers, or build cross-customer marketing audiences. We do not currently use it for product analytics either — see Section 3.4.

## 5. How we share information

We disclose information only as described in this section. We will update this list before adding any new disclosure category.

### 5.1 With our subprocessors (acting on our behalf)

A "subprocessor" is a vendor that processes information for us, under contract, to provide a specific part of the Service. The current list:

| Subprocessor | Role | What it sees | Location |
|---|---|---|---|
| **Stripe, Inc.** | Payment processing, subscription billing, customer portal | Your name, email, billing address, payment-method details (card data goes directly to Stripe, never to us), subscription state | United States |
| **Plaid Inc.** | (Optional) Bank account connection. Used only if you connect a bank account through Plaid. | Bank credentials (entered into Plaid's widget; never touch our servers), the resulting access token, and the transactions Plaid returns to us on your behalf | United States |
| **Anthropic, PBC** | (Optional) The AI assistant. Used only when you actively interact with the assistant. | The text of your message, prior assistant turns in the same conversation, the description of the tools the model may call, and the JSON results from the tools the model actually called within your tenant | United States |
| **Maileroo** | Transactional email delivery (verify-email, password reset, alerts you enabled) | Your email address, your display name, and the body of the transactional email | [Maileroo region — confirm] |
| **Cloudflare, Inc.** | Edge proxy, TLS termination, DNS, bot protection | All HTTP request metadata (IP, headers, request path) | Global edge |
| **Hostinger International Ltd.** | The compute and storage that runs the SmrtCash application and database | All data stored by the Service | Boston, Massachusetts, United States |
| **U.S. Energy Information Administration** | Public fuel-price data for the optional fuel-economy module | Nothing about you — only public queries made by our server | United States |

Each subprocessor is bound by a contract that limits how they may use the information we send them. We pick subprocessors that publish their own privacy and security commitments and we keep that list available on request at privacy@builditsmrt.com.

### 5.2 With law enforcement and in legal proceedings

We will disclose information when required by law (e.g., a valid subpoena, court order, or other legal process), or when we believe in good faith that disclosure is necessary to protect rights, property, or safety. If we receive a request from a government for your account data, we will, where lawful and reasonable, notify you before complying so you can challenge the request.

### 5.3 In a business transaction

If BuildITSmrt is involved in a merger, acquisition, financing, reorganization, bankruptcy, or sale of all or a portion of its assets, your information may be transferred as part of that transaction. We will notify you and the successor entity will be bound by the commitments in this policy unless you affirmatively agree otherwise.

### 5.4 With your direction

If you choose to share data — for example, by exporting a CSV or PDF from the Service, by inviting another person into your household tenant, or by generating a public read-only API key — your data goes where you direct it. Anyone you invite or share with becomes a separate user of the Service and is subject to this same policy.

## 6. International transfers

BuildITSmrt is based in the United States and our infrastructure runs in the United States — specifically, the production environment is hosted with Hostinger International Ltd. in their Boston, Massachusetts data center. All subprocessors we currently use either operate in the United States or, in the case of edge providers like Cloudflare, route traffic through global edges before terminating at U.S. origin servers.

If you access the Service from outside the United States, you are causing your information to be transferred to and processed in the United States. As stated in Section 2, the Service is not currently marketed in the EEA, UK, or Switzerland. If we expand to those regions, we will publish the relevant transfer mechanisms (Standard Contractual Clauses, the UK International Data Transfer Addendum, and any adequacy mechanisms then in effect) at that time.

## 7. Security

We use the following measures to protect the information we store about you:

- **Encryption in transit**: all connections between your browser and our edge use TLS 1.3 with modern ciphers. HSTS is set with a two-year max-age and the preload directive.
- **Encryption at rest, financial attachments and bank credentials**: each tenant has its own data-encryption key ("DEK"), which is wrapped (encrypted) by a platform key-encryption key ("KEK") using AES-256-GCM. Receipts and attachments, Plaid access tokens, and OFX Direct Connect credentials are encrypted under the tenant's DEK before being written to disk or the database. The KEK is held only in the application's runtime environment.
- **Passwords**: stored as argon2id hashes with the parameters recommended by OWASP (memory cost 19 MiB, time cost 2, parallelism 1). The plaintext password is never stored or logged.
- **Session cookies**: HttpOnly, Secure, SameSite=Strict, and HMAC-signed. Logout invalidates the session server-side. A successful password reset invalidates every active session for the user.
- **Authorization**: every request is gated by both an authenticated session (or read-only API key) and tenant-membership checks. Cross-tenant data access by another customer is prevented at the SQL layer in every read and write.
- **Audit logging**: every write performed by you, by the AI assistant, or by a backend job is recorded in our audit log with actor and target.
- **Independent security testing**: we engage third-party reviewers (and internal automated review) to test the security of the Service on a recurring basis, and we maintain a written record of findings and remediations.

No system is perfectly secure. If we ever experience a breach of personal data, we will notify affected users and applicable regulators within the timeframes required by law (72 hours for GDPR; statutory windows for state-level laws in the United States).

## 8. Data retention

We retain information for as long as your account is active and as long as we need it to provide the Service to you. After your account is closed:

- **Account credentials and personal identifiers** are deleted within 30 days of account closure, except where we are required by law to retain them longer (e.g., a tax record for which we must keep an invoice for 7 years).
- **Financial data, attachments, audit log entries, and bank-connection tokens** are deleted within 30 days of account closure. Stripe customer records may be retained by Stripe under its own retention policy for legal and reconciliation purposes; if you want them removed there too, you can ask Stripe directly through their support channels.
- **Server logs** are retained for up to 30 days for security and abuse investigation, then deleted.
- **Audit log entries** are retained for a maximum of 12 months after account closure for fraud and abuse investigation, then deleted.
- **Backup snapshots** that contain your data are retained on a rolling 30-day basis. We do not extract individual users from historical backups; instead, the rolling window ensures that data scheduled for deletion is purged from backups within 60 days of deletion.

You can request earlier deletion (Section 10).

## 9. Children's privacy

The Service is intended for users who are at least 18 years old, or the age of majority in their place of residence, whichever is greater. The Service is not directed to children under 13, and we do not knowingly collect personal information from children under 13. If you are a parent or guardian and you believe a child under 13 has provided personal information to us, please contact privacy@builditsmrt.com and we will delete it.

A SmrtCash account holder can add a "child" member to their household tenant so that the child can see selected accounts and transactions. The data we collect about that child is limited to what the parent enters (display name) and what the child generates by using the Service while logged in. The parent is responsible for whatever they choose to share with their child and is responsible for parental consent under applicable law (including COPPA in the United States) when adding a child under 13. We recommend not creating SmrtCash logins for children under 13.

## 10. Your rights

Depending on where you live, you may have any of the following rights with respect to your personal information. To exercise any of them, email **privacy@builditsmrt.com** from the email address on file with your account, or use the corresponding self-service controls in your account settings where they are provided.

### 10.1 Universal rights

- **Right to access**: a copy of the personal information we hold about you. Self-service: use the in-app data-export feature, which generates a portable JSON archive of your tenant.
- **Right to correct**: ask us to fix inaccurate information.
- **Right to delete**: close your account and have your data deleted as described in Section 8. Self-service: use the "Delete account" option in your settings.
- **Right to a copy in a portable format**: receive your data in a machine-readable format that can be moved to another service. Self-service: the data-export feature outputs JSON.

### 10.2 If you are in the European Economic Area, the United Kingdom, or Switzerland (GDPR)

The Service is not currently marketed in these regions (see Section 2). The rights below are listed as a matter of company policy in case you have nonetheless become a user. If you reside in one of these regions and want to exercise a right we cannot fulfill, the most reliable remedy is to close your account, which triggers the deletion procedure in Section 8.

In addition to the universal rights above, you have:

- **Right to restrict processing** while a dispute is resolved.
- **Right to object** to processing based on our legitimate interests (Section 4).
- **Right not to be subject to a decision based solely on automated processing** that produces legal or similarly significant effects. The Service does not currently make such decisions; the AI assistant's suggestions are always reviewable and reversible by you.
- **Right to lodge a complaint** with a supervisory authority. In the EEA this is your country's data protection authority; in the UK it is the Information Commissioner's Office (ico.org.uk).

### 10.3 If you are a California resident (CCPA/CPRA)

In addition to the universal rights above, you have:

- **Right to know** the specific pieces of personal information we have collected about you in the past 12 months and the categories of sources, purposes, and recipients of that information.
- **Right to delete** the personal information we have collected about you (subject to the same limitations as Section 8).
- **Right to correct** inaccurate information.
- **Right to opt out of sale or sharing**. As of the effective date of this policy, **SmrtCash does not sell or share personal information** as those terms are defined in the CCPA/CPRA. We will publish a "Do Not Sell or Share My Personal Information" link if that ever changes.
- **Right to limit the use of sensitive personal information**. Categories of sensitive personal information we collect (account-access credentials and financial information) are used only for the purposes described in Section 4 — there is no further "use" to limit.
- **Right to non-discrimination**: we will not deny you the Service, charge you a different price, or provide a different level of service because you exercised any of these rights.

You may designate an authorized agent to exercise these rights on your behalf. The agent must provide signed written permission and we may ask you to confirm directly that the agent is authorized.

### 10.4 If you are a resident of Colorado, Connecticut, Utah, Virginia, or another U.S. state with comprehensive privacy legislation

Your state may give you rights similar to those described in Section 10.2 or 10.3. Please contact privacy@builditsmrt.com and describe what you want to do; we will respond consistently with the applicable law.

### 10.5 Identity verification

To prevent fraudulent rights requests, we may need to confirm that the requester is actually the account holder. For most requests, this means we'll ask you to send the request from the email address on file with the account and click a confirmation link.

### 10.6 Response time

We respond to rights requests within the timeframe required by the applicable law (45 days for CCPA, 30 days for GDPR, etc.). If we need more time we will tell you why.

## 11. Cookies and similar technologies

See the separate **Cookie Notice** at [/cookies] for the full list of cookies the Service uses and what each one does. In short:

- **Strictly necessary cookies only**: the session cookie that keeps you logged in, plus Cloudflare's bot-management cookies. These cannot be turned off because the Service would not function.
- **No analytics, advertising, or social cookies** are set by SmrtCash today.

## 12. Do Not Track signals

Some web browsers send a "Do Not Track" ("DNT") signal. There is no industry consensus on how to interpret DNT, so we do not treat DNT signals as a special instruction. We do not engage in cross-context behavioral advertising either way (see Section 3.4 and 10.3).

## 13. Third-party links

The Service may contain links to third-party websites. We are not responsible for the privacy practices of those sites. Read their privacy policies before sharing anything with them.

## 14. Changes to this policy

We may update this policy from time to time. If we make a material change — adding a new subprocessor, broadening the purposes for which we use your data, or weakening any commitment in Section 5 or 7 — we will notify you by email and require you to acknowledge the change before continuing to use the Service. Non-material changes (typos, clarifications, contact-information updates) will be published with a new "Last updated" date.

A historical archive of previous versions of this policy is available on request at privacy@builditsmrt.com.

## 15. Contact

For privacy questions, rights requests, or any complaint about how we handle your information:

**BuildITSmrt LLC**
Attn: Privacy
8859 Creekside Cir, Pleasant Prairie, WI 53158
Email: privacy@builditsmrt.com

For service of legal process:

**BuildITSmrt LLC**
Attn: Legal — Registered Agent
8859 Creekside Cir, Pleasant Prairie, WI 53158
