# SmrtCash — Installation Guide

A complete, step-by-step setup for a development / self-hosted installation.
For the condensed version, see the [Quick Start](./QUICKSTART.md).

> **Phase 1 note:** SmrtCash currently runs as a PostgreSQL container plus two
> local dev servers (API and web). Full single-command containerization
> arrives in Phase 5 — see the [Roadmap](./ROADMAP.md).

---

## 1. Prerequisites

| Requirement | Minimum | Verify with |
|-------------|---------|-------------|
| Node.js | 20 (24 recommended) | `node --version` |
| npm | bundled with Node | `npm --version` |
| Docker | 20+ (Desktop on Windows/macOS) | `docker --version` |
| Git | any recent | `git --version` |

Docker must be **running** before you start (Docker Desktop open on Windows).

---

## 2. Get the code

If the project is in a Git repository, clone it; otherwise work in the
existing project folder. All commands below are run from the **project root**
(the folder containing `docker-compose.yml`).

---

## 3. Configure the environment

SmrtCash reads all configuration from a single `.env` file at the project
root. Create it from the template:

```powershell
# Windows (PowerShell)
Copy-Item .env.example .env
```
```sh
# macOS / Linux
cp .env.example .env
```

Open `.env` and review the values. The defaults are fine for local use; for
anything beyond your own machine, **change `POSTGRES_PASSWORD`** and update the
password inside `DATABASE_URL` to match.

| Key | Change for production? |
|-----|------------------------|
| `POSTGRES_PASSWORD` | **Yes — set a strong password** |
| `DATABASE_URL` | Yes — must contain the same password |
| `POSTGRES_PORT`, `PORT` | Only if those ports are taken |
| `AI_PROVIDER` and keys | Leave as-is until Phase 2 |

`.env` is gitignored and must never be committed.

---

## 4. Start PostgreSQL

```powershell
docker compose -p smrtcash up -d db
```

The `-p smrtcash` flag sets an explicit Compose project name (the folder name
contains a `$`, which is best avoided as a derived name — see
[KI-08](./KNOWN_ISSUES.md)).

Confirm the container is healthy:

```powershell
docker ps --filter name=smrtcash-db
```

You should see `smrtcash-db` with status `healthy` (allow ~10 seconds).

---

## 5. Install dependencies

```powershell
npm install --prefix server
npm install --prefix web
```

> `npm audit` reports 2 moderate advisories from the Excel-parsing library.
> This is tracked as [KI-02](./KNOWN_ISSUES.md) and does not affect CSV import.

---

## 6. Run database migrations

This creates all tables:

```powershell
npm run migrate --prefix server
```

Expected output ends with `Applied 1 migration(s).` (or `Database is up to
date.` on later runs). Always run migrations with this command — see
[KI-04](./KNOWN_ISSUES.md).

---

## 7. Start the application

Open **two terminals**, both at the project root:

```powershell
# Terminal 1 — API server
npm run dev --prefix server
```
```powershell
# Terminal 2 — Web application
npm run dev --prefix web
```

Then open **http://localhost:5173**.

---

## 8. Verify the installation

| Check | How | Expected |
|-------|-----|----------|
| Database | `docker ps` | `smrtcash-db` healthy |
| API | open `http://localhost:4000/api/health` | `{"status":"ok",...}` |
| Web | open `http://localhost:5173` | The SmrtCash UI loads |
| End to end | Create an account, import a CSV | Transactions appear |

If all four pass, the installation is complete.

---

## Production build

To produce optimized builds instead of running the dev servers:

```powershell
npm run build --prefix server   # compiles to server/dist
npm run build --prefix web      # bundles to web/dist

npm start --prefix server       # runs the compiled API
```

Serve `web/dist` with any static file server. (A hardened, all-in-one Docker
image is a Phase 5 deliverable.)

---

## Updating

1. Pull the latest code.
2. Re-install dependencies: `npm install --prefix server` and `--prefix web`.
3. Apply any new migrations: `npm run migrate --prefix server`.
4. Restart the API and web servers.

---

## Uninstalling

```powershell
# Stop and remove the container (keeps your data volume)
docker compose -p smrtcash down

# Also delete the database volume — THIS ERASES ALL DATA
docker compose -p smrtcash down -v
```

Then delete the project folder. Back up first if you want to keep your data —
see the [Admin Guide](./ADMIN_GUIDE.md#database-backup).
