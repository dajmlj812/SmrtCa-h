# Runbook — Rotating the KEK (`ATTACHMENT_ENCRYPTION_KEY`)

The KEK is the platform-level encryption key that:

- Wraps every tenant's data-encryption key (DEK) in `tenant_encryption_keys.wrapped_dek`. The DEK in turn encrypts each tenant's attachments.
- Directly encrypts the few short secrets we hold per-tenant in DB columns: `plaid_items.access_token_encrypted`, `ofx_dc_connections.username_encrypted`, `ofx_dc_connections.password_encrypted`.

Rotating the KEK means re-wrapping every DEK and re-encrypting every short secret under a new KEK, then telling the server the new KEK is the current one.

## When to rotate

- **A KEK has been exposed** (in a backup, a transcript, a screenshot, a stack trace). The audit's F-13 finding caused this on the test server during the security review of 0.18.12 — the old backup format wrote the KEK to disk in plaintext.
- **A scheduled rotation** every 6-12 months as a good-hygiene practice.
- **Migrating from one operator to another** (the new operator should not inherit a KEK the previous operator knew).

If a tenant's DEK is suspected of being compromised but the KEK is fine, **don't rotate the KEK** — use `POST /api/system/tenants/:id/rotate-encryption-key` (the per-tenant DEK rotation) instead. KEK rotation is much heavier.

## Pre-flight

1. **Take a backup**. The rotation is transactional at the DB layer, but a crash between the DB commit and the `.env` write would leave the system in a recover-by-hand state. The backup is your return path.
   ```sh
   ssh srv-prod 'cd /opt/smrtcash && docker exec smrtcash-app node /app/scripts/backup.mjs'
   ```
2. **Confirm `server/dist/attachments/kek-rotation.js` exists**. The CLI imports the compiled JS — if you haven't done `npm run build --prefix server` since pulling the latest code, the CLI will fail with a clear error.
3. **Coordinate downtime** if this is the production server. The rotation itself takes seconds, but the container restart that follows interrupts every active session. For a low-traffic install, do it in your maintenance window. For a busier install, announce it.

## Run

```sh
# SSH into the server
ssh srv-prod
cd /opt/smrtcash

# Generate + apply a fresh KEK (interactive — asks for "ROTATE" confirmation)
docker exec -it smrtcash-app node /app/scripts/rotate-kek.mjs

# Or non-interactive:
docker exec smrtcash-app node /app/scripts/rotate-kek.mjs --yes

# Or use your own key (must be 32 bytes base64 or 64 hex chars):
docker exec smrtcash-app node /app/scripts/rotate-kek.mjs --new-kek "$(openssl rand -base64 32)" --yes

# Or rehearse without changing .env:
docker exec smrtcash-app node /app/scripts/rotate-kek.mjs --dry-run
```

The script will:

1. Confirm with you ("Type ROTATE to proceed").
2. Open a DB transaction.
3. Rewrap every `tenant_encryption_keys.wrapped_dek` row.
4. Re-encrypt every `plaid_items.access_token_encrypted`.
5. Re-encrypt every `ofx_dc_connections.{username,password}_encrypted` pair.
6. Commit the transaction.
7. Write the new KEK into `.env` (backing up the old file to `.env.bak.<timestamp>`).
8. Print a "now restart the container" reminder.

If anything fails before step 7, the DB transaction is rolled back and the old KEK is still the correct one. Nothing on disk changed.

If the script fails after the DB commit but before the `.env` write — extremely unlikely, but: the script prints the new KEK before it tries to write. Save that value, then either re-run with `--new-kek <that-value>` or paste it into `.env` manually.

## Restart

The running container still has the OLD KEK in its `process.env` from boot. Until you restart, every write to a KEK-encrypted column will use the OLD KEK, which can no longer be unwrapped on the next read.

```sh
docker compose up -d --force-recreate app
```

Confirm:

```sh
curl https://your-host/api/health    # should return {"status":"ok"}
# Then log in via the web app and verify:
#   - Existing receipts open (image preview renders without error)
#   - Plaid sync runs (Settings → Connections → Sync now)
#   - OFX-DC sync runs if you use one
```

## Verify

If anything is mis-encrypted after the rotation, the server logs will show:

```
Error: Unsupported state or unable to authenticate data
   at Decipheriv.final ...
```

That's AES-GCM tag mismatch. It means data in DB was written under one KEK but the running process holds another. Recovery options:

- **The DB was rewrapped but the container still has the old KEK loaded** → restart the container, then everything should work.
- **Some new data was written between the DB commit and the restart** → that data was encrypted under the OLD KEK because the running process still had it. The fix is to delete those specific rows and re-do whatever action created them (re-link Plaid, re-enter OFX-DC creds).
- **The `.env` file got the new KEK but the rotation transaction was somehow aborted** → very unlikely (the script commits before writing). Restore `.env.bak.<timestamp>` and you're back on the old KEK.

## After rotation

- Delete the `.env.bak.<timestamp>` file once you're confident the rotation worked. It still contains the OLD KEK, which is the value you were trying to invalidate.
- If the OLD KEK was in any backup snapshot prior to 0.18.13, those backups must also be deleted or have their `env.snapshot.json` files removed. (Post-0.18.13, secret keys are never written to backups in the first place; see commit 16ad964.)
- Make a note in the operator log when the rotation happened.

## What rotation does NOT do

- It does **not** rotate per-tenant DEKs. Each tenant's DEK material is unchanged — only the envelope around it is replaced. A tenant whose DEK is suspected of being compromised still needs `rotate-encryption-key` (per-tenant) separately.
- It does **not** re-encrypt the actual attachment files on disk. Those are encrypted with the DEK, not the KEK, so they don't need to change.
- It does **not** rotate `SESSION_SECRET`, `STRIPE_*`, `SMTP_PASS`, or any other env-resident secret. Those are independent and have their own rotation procedures (mostly: change the env, restart).
- It does **not** touch the `audit_log` table or any other plaintext column. Nothing about the rotation is observable in audit history beyond the restart event.

## What gets logged

The rotation runs offline (script invocation), so no audit row is written from the script itself. Add an external operator log entry (PagerDuty event, Slack message, whatever your norm is) so there's a record outside the system.
