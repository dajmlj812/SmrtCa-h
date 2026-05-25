# Runbook — Fix the duplicate DMARC record on `builditsmrt.com`

The 2026-05-25 security audit (F-28) found that `_dmarc.builditsmrt.com` has **two** TXT records:

```
v=DMARC1; p=none;
v=DMARC1; p=reject;
```

RFC 7489 §6.6.3 says: when a Mail Receiver finds more than one DMARC record at the `_dmarc.<domain>` label, it **MUST NOT** apply DMARC policy. So today DMARC is **effectively disabled** for the domain. Verification, password-reset, and billing emails sent from `noreply@builditsmrt.com` (or any `@builditsmrt.com` address) are spoofable, and Gmail / Outlook will mostly tolerate the spoof.

This isn't a code change — it's a DNS change you'll do in your domain registrar / Cloudflare DNS dashboard. The whole fix is ~5 minutes.

## What "good" looks like

A single TXT record at `_dmarc.builditsmrt.com` that:

1. Starts with `v=DMARC1`.
2. Sets a policy (`p=reject` for strongest; `p=quarantine` for "send to spam"; `p=none` for monitoring only).
3. Optionally specifies an `rua=` (aggregate report) address so you find out about authentication failures.

The recommended record:

```
v=DMARC1; p=reject; rua=mailto:dmarc-reports@builditsmrt.com; pct=100; adkim=s; aspf=s
```

Breakdown:
- `p=reject` — receivers reject mail that fails DMARC. The strongest policy.
- `pct=100` — apply the policy to 100% of failing mail (the default, but explicit is good).
- `rua=mailto:…` — daily aggregate reports of who's authenticating as your domain. Use a mailbox you actually read (or a service like Postmark / Dmarcian).
- `adkim=s aspf=s` — strict alignment for DKIM and SPF, matching the From-domain literally instead of relaxing to a parent domain.

If you want to start cautious, swap `p=reject` for `p=quarantine` first; watch the rua reports for a week to confirm Maileroo is the only sender; then promote to `p=reject`.

## Step-by-step (Cloudflare DNS)

1. Log in to Cloudflare → select `builditsmrt.com` → DNS → Records.
2. Filter by Name = `_dmarc`. You should see **two** TXT records.
3. Click the row for the `v=DMARC1; p=none;` record → **Edit** → **Delete**. Confirm.
4. Click the row for the `v=DMARC1; p=reject;` record → **Edit**. Replace the value with:
   ```
   v=DMARC1; p=reject; rua=mailto:dmarc-reports@builditsmrt.com; pct=100; adkim=s; aspf=s
   ```
   Or, if you want the cautious rollout, use `p=quarantine` for now and revisit in a week.
5. Save.
6. Wait 5-15 minutes for caches to clear, then verify (see below).

## Step-by-step (other DNS providers)

The dashboard wording varies but the change is the same: find both TXT records on the `_dmarc` subdomain, delete one, edit the other so the value matches what's recommended above.

## Verification

From any machine with `nslookup` or `dig`:

```sh
# Should return EXACTLY ONE line starting with "v=DMARC1"
nslookup -type=TXT _dmarc.builditsmrt.com
```

Or from PowerShell on Windows:

```powershell
(Resolve-DnsName -Type TXT "_dmarc.builditsmrt.com").Strings
```

Online verifiers:
- https://mxtoolbox.com/dmarc.aspx (paste `builditsmrt.com`)
- https://dmarcian.com/dmarc-inspector/

A passing setup gets a single record + a green "no record-set inconsistencies" indicator.

## Confirm SPF and DKIM too

DMARC is the policy layer; SPF and DKIM are the authentication layers underneath. You already have SPF:

```
v=spf1 include:_spf.maileroo.com ~all
```

The `~all` (soft-fail) is fine for the transition; once you're confident Maileroo is the only sender, tighten to `-all` (hard-fail) for the strongest position.

DKIM under the common `maileroo._domainkey` selector returned empty in the audit. Maileroo uses per-account selectors — log in to your Maileroo dashboard, navigate to Domains → builditsmrt.com → DKIM, copy the selector name + value they show, and add it as a TXT record at:

```
<selector>._domainkey.builditsmrt.com
```

Verify with:

```powershell
(Resolve-DnsName -Type TXT "<selector>._domainkey.builditsmrt.com").Strings
```

## Send a test email through Maileroo

After the records are in place, send a verification email from the test server (sign up a new test user, or click "resend" on an existing unverified account). Check the received-message headers in Gmail (View Original → expand "Authentication-Results"). You want:

```
Authentication-Results: mx.google.com;
       dkim=pass header.i=@builditsmrt.com
       spf=pass smtp.mailfrom=... smtp.helo=...
       dmarc=pass header.from=builditsmrt.com
```

All three `pass`. If any fail, fix that record before declaring victory.

## Operational tip

Set a Cloudflare DNS-record audit reminder for once a year. DNS records grow like garden weeds — last year's DMARC migration / vendor experiment / Cloudflare Page Rules trial all leave TXT artifacts behind, and a stray duplicate is exactly how DMARC gets accidentally turned off again.
