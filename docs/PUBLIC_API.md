# SmrtCash — Public API

Introduced in **v0.18.4**.

Every signed-in user can mint one or more API keys for read-only HTTP
access to their own data. The same routes the web app reads from are
available — every list/get endpoint under `/api/*` works with a
Bearer token. Mutating requests (POST/PATCH/PUT/DELETE) are
**blocked** for token-authed callers.

The token is scoped to whichever tenant ("household") was active when
you minted it. A token minted under tenant A can never read tenant
B's data, even if you also belong to B.

## Mint a token

In the SmrtCash web UI:

1. Click your name in the sidebar footer → **My profile**.
2. Scroll to **API keys**.
3. Enter a label (e.g. `home dashboard script`) → **Create API key**.
4. **Copy the token immediately** — it is shown exactly once.
   We store only a SHA-256 hash; if you lose the token there is no
   recovery, only revocation and re-creation.

The displayed prefix (`smrt_abc12345…`) is a stable identifier you
can use in your scripts' logs without leaking the secret.

## Use the token

Send it as `Authorization: Bearer <token>` on any GET request.

```bash
# List your accounts.
curl https://your-smrtcash.example.com/api/accounts \
  -H "Authorization: Bearer smrt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Last 90 days of transactions.
curl 'https://your-smrtcash.example.com/api/transactions?days=90' \
  -H "Authorization: Bearer smrt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Cash-flow forecast (drives the dashboard hero).
curl 'https://your-smrtcash.example.com/api/cash-flow?days=90' \
  -H "Authorization: Bearer smrt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"

# Net worth over time (12-month series).
curl 'https://your-smrtcash.example.com/api/insights/net-worth-over-time?months=12' \
  -H "Authorization: Bearer smrt_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
```

A mutating request is rejected:

```bash
curl -X POST https://your-smrtcash.example.com/api/accounts \
  -H "Authorization: Bearer smrt_..." \
  -d '{}'
# → 403 {"error": "API keys are read-only. Mutating requests must use a session."}
```

## Available read endpoints

Anything the web app reads. The most useful for external integrations:

| Endpoint | What it returns |
| --- | --- |
| `GET /api/accounts` | Your accounts + balances |
| `GET /api/transactions?days=N` | Recent transactions |
| `GET /api/transactions/export?...` | CSV export (same filters as the web UI) |
| `GET /api/bills` | Bills + recurring expenses |
| `GET /api/recurring-income` | Income streams |
| `GET /api/cash-flow?days=N` | 90-day forecast with confidence band |
| `GET /api/insights/spending-by-category` | Pie-chart data |
| `GET /api/insights/income-expense?months=N` | Bar-chart data |
| `GET /api/insights/net-worth-over-time?months=N` | Net-worth line chart |
| `GET /api/holdings` | Investment positions |
| `GET /api/budgets/actual?month=YYYY-MM` | Budget vs actual |
| `GET /api/calendar/:YYYY-MM` | Day-by-day spending + bill markers |

## Rate limits & lifecycle

- Max **10 active keys per user**. Revoke an old key to mint another.
- Keys never expire on their own. Revoke them when you're done.
- `last_used_at` and `last_used_ip` are updated on every successful
  request and displayed in the My-profile UI so you can audit usage.
- Audit log records `api_key.create` and `api_key.revoke` against
  the bound tenant.

## Revoking

Profile modal → API keys → **Revoke** on the row.

Or via the API, using a session cookie (revocation itself is a
mutation and therefore not allowed via Bearer):

```bash
curl -X DELETE https://your-smrtcash.example.com/api/me/api-keys/<key-id> \
  -H "Cookie: smrtcash_session=..."
```

## What this is NOT

- **No write scope.** v0.18.4 is read-only. Adding a write scope is
  a separate slice — both because it needs a thoughtful permission
  shape (which RBAC role does the token act as?) and because the
  blast radius of a leaked write token is much larger.
- **No OAuth flow.** This is a personal-access-token model
  (GitHub-style), not a third-party-app authorization model.
- **No rate-limiting middleware yet.** A runaway script will work
  but is on the honor system; the per-user 10-key cap and the
  audit log are the only mitigations.
