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

### Database backup

Dump inside the container, then copy the file out — this avoids shell-encoding
problems on Windows:

```powershell
docker exec smrtcash-db pg_dump -U smrtcash -d smrtcash -f /tmp/smrtcash.sql
docker cp smrtcash-db:/tmp/smrtcash.sql ./backup-smrtcash-$(Get-Date -Format yyyyMMdd).sql
```

Back up regularly — there is no automated backup yet. Store backups securely:
they contain all of your financial data.

### Database restore

```powershell
docker cp ./backup-smrtcash.sql smrtcash-db:/tmp/restore.sql
docker exec smrtcash-db psql -U smrtcash -d smrtcash -f /tmp/restore.sql
```

Restore into an empty database. To start fresh first, see *Reset the database*
below.

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

Phase 1 has **no authentication** ([KI-03](./KNOWN_ISSUES.md)). Until Phase 5:

- [ ] Run SmrtCash only on `localhost` or a trusted, firewalled LAN.
- [ ] Do **not** port-forward or expose ports 5173 / 4000 / 5432 to the internet.
- [ ] Set a strong, unique `POSTGRES_PASSWORD`.
- [ ] Keep `.env` and database backups in a secure location.
- [ ] Keep dependencies current; review `npm audit` (see [KI-02](./KNOWN_ISSUES.md)).
- [ ] Treat exported backup files as sensitive financial data.

Phase 5 adds authentication, encryption at rest, and a hardened container.

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
