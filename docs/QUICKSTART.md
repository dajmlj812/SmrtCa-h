# SmrtCash — Quick Start

Get SmrtCash running and import your first statement in about five minutes.
For a fuller walkthrough see the [Installation Guide](./INSTALLATION.md).

## Prerequisites

- **Node.js 20+** and **Docker** installed and running.

## 1. Configure

From the project root, create your local config file:

```powershell
# PowerShell (Windows)
Copy-Item .env.example .env
```
```sh
# macOS / Linux
cp .env.example .env
```

The defaults work for local development as-is.

## 2. Start everything

```powershell
# Start the PostgreSQL database
docker compose -p smrtcash up -d db

# Install dependencies
npm install --prefix server
npm install --prefix web

# Create the database tables
npm run migrate --prefix server
```

Now start the two dev servers — **each in its own terminal**:

```powershell
# Terminal 1 — API
npm run dev --prefix server

# Terminal 2 — Web app
npm run dev --prefix web
```

## 3. Open the app

Go to **http://localhost:5173**.

## 4. Import your first statement

1. Click **New Account** — give it a name, pick a type (e.g. *Credit Card*),
   and save.
2. Go to the **Import** tab.
3. Choose the account you just created.
4. Select a CSV or Excel statement export from your bank.
5. SmrtCash detects the format and shows a **preview** — number of rows, a
   sample, and any problems.
6. Click **Import** to save the transactions.
7. Open the **Transactions** tab to see them.

Re-importing the same file is safe — duplicates are skipped automatically.

## Troubleshooting

| Problem | Fix |
|---------|-----|
| `docker compose` fails | Make sure Docker Desktop is running |
| API won't start | Confirm Postgres is up: `docker ps`; check `.env` |
| "Could not recognize this file's format" | Use a CSV export; other banks may need column mapping (see [Documentation](./DOCUMENTATION.md#7-the-import-pipeline)) |
| Port already in use | Change `PORT` in `.env`, or free port 5173/4000 |

More help: [Admin Guide](./ADMIN_GUIDE.md) · [Known Issues](./KNOWN_ISSUES.md)
