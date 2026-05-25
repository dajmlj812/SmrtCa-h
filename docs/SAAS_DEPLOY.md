# SmrtCash — SaaS deploy walkthrough

Step-by-step for putting SmrtCash on a fresh Linux box behind
[Nginx Proxy Manager (NPM)](https://nginxproxymanager.com/) with
public HTTPS, billing webhooks, and outbound email. Distilled from
the smrtcash-test deploy.

The self-host single-container doc (`docs/INSTALLATION.md`) covers
a developer's laptop. **This covers a real internet-facing deploy.**
If you only need it on `localhost`, read that one instead.

## Prerequisites

- Linux box (Ubuntu/Debian works; any modern distro is fine).
- Docker + Docker Compose v2 installed (`docker compose version`
  should print v2.x).
- A domain you control with DNS pointing at the box (an A record
  for the subdomain you'll serve from, e.g.
  `smrtcash.example.com`).
- An [NPM](https://nginxproxymanager.com/) instance already running
  on the same box, with its `proxy` Docker network created and
  listening on `:80` + `:443`. (Standard NPM compose stack; not
  covered here.)
- An SMTP relay account (Maileroo, SendGrid, AWS SES, your
  hosting provider's mail relay — any will work). You'll need
  host, port, username, password, and a verified `From` address.

## 1. SSH preflight

```bash
ssh root@<box-ip>
# Confirm Docker:
docker compose version
# Confirm NPM is running + the proxy network exists:
docker network ls | grep proxy
```

If `proxy` doesn't exist:

```bash
docker network create proxy
```

## 2. Clone the repo with a deploy key

Generate a deploy key so the box can pull updates without
broad GitHub credentials:

```bash
ssh-keygen -t ed25519 -C "smrtcash-deploy-$(hostname)" \
  -f /root/deploy_key -N ""
cat /root/deploy_key.pub
```

Add the printed pubkey to the repo's GitHub **Deploy keys**
(Settings → Deploy keys → Add deploy key). Read-only access is
enough — no need to grant write.

Configure SSH to use the key for github.com:

```bash
cat >> /root/.ssh/config <<'EOF'
Host github.com-smrtcash
  HostName github.com
  User git
  IdentityFile /root/deploy_key
  IdentitiesOnly yes
EOF
chmod 600 /root/.ssh/config
```

Clone:

```bash
mkdir -p /opt
cd /opt
git clone git@github.com-smrtcash:<your-fork>/SmrtCash.git smrtcash
cd /opt/smrtcash
```

## 3. Compose override for the NPM `proxy` network

NPM routes traffic via its Docker network, NOT by publishing a
host port. We don't want to publish 4000 to the host either —
that bypasses NPM and exposes the app directly.

Create `/opt/smrtcash/docker-compose.override.yml`:

```yaml
services:
  app:
    networks:
      - default
      - proxy
    # Drop the host port publish — NPM reaches us over the
    # `proxy` network.
    ports: []

networks:
  proxy:
    external: true
```

## 4. `.env` with strong secrets

```bash
cd /opt/smrtcash
cp .env.example .env
# Generate strong secrets:
echo "SESSION_SECRET=$(openssl rand -base64 48 | tr -d '\n')"  >> .env
echo "ATTACHMENT_ENCRYPTION_KEY=$(openssl rand -base64 32 | tr -d '\n')" >> .env
echo "POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -d '\n')" >> .env
# Required runtime config:
cat >> .env <<EOF
NODE_ENV=production
PUBLIC_BASE_URL=https://smrtcash.example.com
COOKIE_SECURE=true
PUBLIC_SIGNUP_ENABLED=true
EOF
```

Edit `.env` to remove the placeholders that came from
`.env.example` and to set anything else specific to your
deploy (Stripe keys, Plaid, etc.).

**Critical:** `PUBLIC_BASE_URL` must match the public URL
visitors will use, including the scheme. Outgoing email links
(signup verification, password reset, invitations) and Stripe
Checkout success/cancel URLs are all built from it. A typo
here breaks every outbound flow.

## 5. First boot

```bash
cd /opt/smrtcash
docker compose up -d
# Migrations + category seed run automatically on boot:
docker compose logs -f app | head -20
```

Wait for `SmrtCash API listening on http://localhost:4000` —
that's the readiness signal.

## 6. NPM proxy host

In the NPM UI:

1. **Hosts → Proxy Hosts → Add Proxy Host**
2. Domain name: `smrtcash.example.com`
3. Scheme: `http` (NPM terminates TLS; the upstream is plain HTTP)
4. Forward Hostname / IP: `smrtcash-app` (the container name)
5. Forward Port: `4000`
6. ☑ **Block Common Exploits**
7. ☑ **Websockets Support** (the app uses SSE-style streaming
   in a few places)
8. **Advanced** tab — paste:

```nginx
# Pass the real client IP + scheme to SmrtCash so audit logs +
# rate-limit-by-IP work, and so the app builds correct cookies.
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
proxy_set_header X-Forwarded-Proto $scheme;
proxy_set_header X-Forwarded-Host $host;

# Allow large attachment uploads (server enforces 25 MB
# per-file / 100 MB per-request).
client_max_body_size 110m;
```

9. **SSL** tab — request a Let's Encrypt cert. Tick
   ☑ Force SSL, ☑ HTTP/2 Support.

## 7. SMTP — pick a relay and configure

In the SmrtCash super-admin **Settings** page, fill in:

- `SMTP_HOST` — e.g. `smtp.maileroo.com`
- `SMTP_PORT` — `587` (STARTTLS) or `465` (TLS-on-connect)
- `SMTP_USER` — relay username
- `SMTP_PASS` — relay password
- `SMTP_FROM` — verified sending address
- `SMTP_SECURE` — `true` for port 465, leave blank for 587

Then click **Test SMTP** on the same panel.

### Maileroo — *known gotcha*

Maileroo's **click tracking** is on by default and rewrites every
URL through their redirect domain. For SmrtCash invitation links
(`https://smrtcash.example.com/invite/<token>`), the rewriter has
been observed mangling the host into `smrtcash@example.com` —
likely because the `<subdomain>.<domain>.<tld>` pattern matches
the FROM address and the rewriter substitutes `.` for `@`.

Recipients click the button and land on a 404 / connection error.

**Fix:** as of v0.17.2, every SmrtCash send adds
`X-Maileroo-Track: no` to disable click tracking. If you're on
v0.17.2+ you don't need to do anything; if you're on an older
deploy, either upgrade or turn off click tracking in your
Maileroo account settings.

This bug took *hours* to diagnose because the symptoms looked
like a misconfigured `PUBLIC_BASE_URL` (which is why 0.18.8
unified that into one setting — see CHANGELOG).

## 8. DNS verification

From the box:

```bash
dig +short smrtcash.example.com
# Should print the box's public IP
```

From your workstation:

```bash
curl -sSL https://smrtcash.example.com/api/health
# {"status":"ok","time":"..."}
```

## 9. Create the first super-admin

```bash
docker compose exec app node scripts/create-super-admin.mjs \
  --email you@example.com --password '<long-strong-password>'
```

That account can log in at `/login`, then visit `/system` to
manage tenants, `/settings` for runtime config, `/billing` to
hook Stripe.

## 10. Sandbox cleanup

When testing wraps and you're ready for real traffic:

```bash
# Clear test tenants + their data:
docker compose exec db psql -U smrtcash -d smrtcash -c \
  "DELETE FROM tenants WHERE slug LIKE 'test-%';"

# Rotate the session secret + attachment key now that the box
# has been touched by anyone with shell access during testing:
# (regenerate via openssl + redeploy as in step 4)
```

## 11. Day-2 ops

- **Updates:**
  ```bash
  cd /opt/smrtcash
  git fetch --tags
  git checkout v<latest>
  docker compose build app
  docker compose up -d app
  ```
- **Backups:** see `docs/ADMIN_GUIDE.md` § Backups + restore.
- **On-call symptoms ↔ recovery:** `docs/OPERATOR_RUNBOOK.md`.
- **Stripe-specific gotchas:** `docs/STRIPE_SETUP.md`.

## Troubleshooting

| Symptom | First check |
|---|---|
| Public URL returns 502 | `docker compose logs app` — container alive? `docker network inspect proxy` — is smrtcash-app on the proxy net? |
| Invitation links broken | Send yourself a test invite; check the URL in the email. If it has `@` where `.` should be, see § 7 Maileroo gotcha. |
| User says they verified email but still can't log in | See `docs/OPERATOR_RUNBOOK.md` § "User stuck on verification gate". |
| Stripe Checkout redirects to localhost | `PUBLIC_BASE_URL` not set (or stale because pre-0.18.8 used `STRIPE_PUBLIC_BASE_URL`). Set in `/settings` UI or `.env`. |
| Migration on boot fails | `docker compose logs app | grep -i migrat`. Usually permissions or a partial restore. Read the error; the SQL file is verbatim in `server/src/db/migrations/`. |
