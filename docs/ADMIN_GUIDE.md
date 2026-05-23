# SmrtCash — Administrator Guide

Operating, maintaining, and securing a SmrtCash installation.
For first-time setup, see the [Installation Guide](./INSTALLATION.md).

All commands are run from the **project root**.

---

## Service overview

| Service | What it is | Port | Lifecycle |
|---------|-----------|------|-----------|
| `smrtcash-db` | PostgreSQL 17 container | 5432 | `docker compose` |
| API | Fastify server | 4000 | `npm run dev` / `npm start` |
| Web | Vite dev server / static build | 5173 | `npm run dev` |

---

## Starting & stopping

```powershell
# Start the database
docker compose -p smrtcash up -d db

# Stop the database (data is preserved)
docker compose -p smrtcash stop db

# Stop and remove the container (data volume preserved)
docker compose -p smrtcash down

# Restart
docker compose -p smrtcash restart db
```

The API and web servers are stopped with `Ctrl+C` in their terminals.

Check status and health:

```powershell
docker compose -p smrtcash ps
docker ps --filter name=smrtcash-db
```

---

## Database administration

### Connect with psql

```powershell
docker exec -it smrtcash-db psql -U smrtcash -d smrtcash
```

Useful inside psql: `\dt` (list tables), `\d transactions` (describe a table),
`\q` (quit).

### Backup (database + attachments)

Phase 5 ships a one-shot backup script that snapshots both the Postgres
database AND the attachments directory into `./backups/<timestamp>/`:

```powershell
npm run backup
```

Requires `pg_dump` and `tar` on PATH. Each run produces two files:

- `db.dump` — `pg_dump --format=custom` archive (restored with `pg_restore`)
- `attachments.tgz` — gzipped tar of the attachments tree

Store backups off the same disk and treat them as sensitive financial data.
Schedule a regular run via Task Scheduler (Windows) or cron (Linux/macOS).

### Restore

The restore script is destructive — it drops and recreates every table in
the target database before reloading, then replaces the attachments tree.
**Stop the server first**:

```powershell
npm run restore -- ./backups/2026-05-22_12-00-00
```

You'll be prompted to type `restore` to confirm; add `--force` to skip.

### Reset the database

This **erases all data** and recreates empty tables:

```powershell
docker compose -p smrtcash down -v        # deletes the data volume
docker compose -p smrtcash up -d db
npm run migrate --prefix server
```

### Where the data lives

PostgreSQL data is stored in the Docker named volume
`smrtcash_smrtcash-db-data`. Inspect it with:

```powershell
docker volume inspect smrtcash_smrtcash-db-data
```

---

## Migrations

Schema changes ship as numbered `.sql` files in
`server/src/db/migrations/`. Apply all pending migrations with:

```powershell
npm run migrate --prefix server
```

The runner is idempotent — already-applied files are skipped (tracked in the
`schema_migrations` table). Always back up before migrating a database with
real data.

---

## Environment & secrets

- All configuration is in the project-root `.env` file.
- `.env` is gitignored — **never commit it**.
- The sensitive values are `POSTGRES_PASSWORD`, `DATABASE_URL`, and (from
  Phase 2) `ANTHROPIC_API_KEY`.
- After changing `.env`, restart the affected service (the DB container for
  `POSTGRES_*`, the API for everything else).
- If you change the database password, update it in **both** `POSTGRES_PASSWORD`
  and `DATABASE_URL`.

---

## AI provider configuration (Phase 2)

AI normalization is not active in Phase 1, but the settings already exist:

| `AI_PROVIDER` | Behavior |
|---------------|----------|
| `none` | No AI (current default) |
| `claude` | Use the Anthropic Claude API — requires `ANTHROPIC_API_KEY` |
| `ollama` | Use a local model via Ollama — requires `OLLAMA_BASE_URL` |

When Phase 2 ships, choose a provider here. `ollama` keeps all transaction
text on your own machine; `claude` sends transaction descriptions to
Anthropic's API.

---

## Logs & monitoring

| Source | How to view |
|--------|-------------|
| Database | `docker compose -p smrtcash logs -f db` |
| API | Output in the terminal running `npm run dev --prefix server` |
| Web | Output in the terminal running `npm run dev --prefix web` |

The API logs every request (method, path, status, duration) as JSON.

---

## Security checklist

- [ ] **Strong password.** Set at first launch on the setup screen. ≥ 8
      characters minimum; treat like banking credentials. No recovery flow —
      store in a password manager.
- [ ] **`SESSION_SECRET`** is set in `.env` to a long random value. Without
      it the server generates an ephemeral one and existing sessions are
      invalidated on every restart. Generate one with:
      `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
- [ ] **`ATTACHMENT_ENCRYPTION_KEY`** is set when you care about
      attachment-at-rest encryption. New uploads are then AES-256-GCM
      encrypted on disk. Generate the same way as `SESSION_SECRET`. Store
      it OUT of band — losing it makes encrypted attachments unrecoverable.
- [ ] **Strong `POSTGRES_PASSWORD`.** The DB credentials are stored in
      `.env` and never sent to the client.
- [ ] **`COOKIE_SECURE=1`** when running behind HTTPS — adds the `Secure`
      flag to the session cookie so it never leaks over plain HTTP.
- [ ] **Database volume on encrypted storage.** SmrtCash does not encrypt
      Postgres data inside the container — encrypt the host volume
      (LUKS / BitLocker / FileVault / encrypted ZFS dataset) instead.
- [ ] **HTTPS in front.** Don't expose port 4000 directly — put Caddy or
      nginx in front with a real cert. See *HTTPS via Caddy* below.
- [ ] **Run on localhost or a trusted LAN.** Single-user auth makes
      brute-force-by-network the main remaining risk.
- [ ] **Keep dependencies current.** See *Dependency vulnerability policy*
      below.
- [ ] **Backups are sensitive.** `backups/` contains everything — store
      with the same care as `.env`.

---

## HTTPS via Caddy

Caddy auto-provisions Let's Encrypt certificates and reverse-proxies to
SmrtCash with one line of config. From the host that runs Docker:

```caddyfile
finance.example.com {
    reverse_proxy localhost:4000
}
```

Set `COOKIE_SECURE=1` in `.env` so the session cookie is only sent over
HTTPS, then restart the app container.

For a LAN-only deployment, use Caddy's internal CA (`tls internal`) or
self-signed certs.

---

## Dependency vulnerability policy

- **Cadence.** Run `npm audit` in `server/`, `web/`, and `e2e/` monthly,
  and after every dependency change.
- **Triage by severity.**
  - **Critical / High** — patch within 7 days, or document the
    accepted-risk reason in `docs/KNOWN_ISSUES.md`.
  - **Moderate** — patch within 30 days. Existing moderate advisories live
    as KI entries with their planned resolution.
  - **Low** — patch at next dependency-bump cycle.
- **Pin majors, accept minors.** All dependencies in this repo use
  caret ranges (`^x.y.z`) so patch & minor updates pull in automatically
  on `npm install`; major bumps need an explicit review.
- **Transitive vulnerabilities** — prefer overriding the offending
  transitive dep via `overrides` in `package.json` rather than dropping
  the direct dep that pulls it in.

---

## Routine maintenance

| Task | Frequency |
|------|-----------|
| Database backup | Before each import session / weekly |
| `npm audit` review | Monthly, and after dependency updates |
| Apply migrations | After every code update |
| Docker image updates (`docker compose pull`) | Quarterly |

---

## Troubleshooting

| Symptom | Likely cause | Resolution |
|---------|-------------|------------|
| API exits with "Missing required environment variable" | No `.env`, or `DATABASE_URL` unset | Create `.env` from `.env.example` |
| API: `ECONNREFUSED` on startup | Postgres not running | `docker compose -p smrtcash up -d db` |
| `docker compose` errors | Docker not running | Start Docker Desktop |
| Container stuck "unhealthy" | Port 5432 in use / volume corruption | Change `POSTGRES_PORT`, or reset the volume |
| Web loads but shows API errors | API not running, or wrong `PORT` | Start the API; confirm `/api/health` |
| Migration fails midway | SQL error | It rolls back; fix the migration file, re-run |
| Import: "Could not recognize this file's format" | Unknown bank layout | Use a CSV export; supply a column mapping |
| Re-import added 0 rows | Duplicate detection working as intended | Expected — that file was already imported |

For known limitations and their planned fixes, see
[KNOWN_ISSUES.md](./KNOWN_ISSUES.md).
