# SmrtCash — Performance Recommendations

Prepared 2026-05-25 alongside the security re-audit. This doc rolls up specific, actionable opportunities to make SmrtCash faster — most of them small, a few worth a real slice. Listed in approximate **value-per-hour-of-work** order so the quick wins land first.

The complementary `/health` widgets shipped today (query metrics, slow-query log, error log) are the tooling that lets you verify each of these fixes — if you make a change and the slow-query log stops showing the offending pattern, you're done.

## Quick wins (each <1 hour)

### P-1. Collapse the per-table COUNT loop in `collectDb`

**File**: `server/src/domain/health.ts:140-146`

Today: 8 separate `SELECT COUNT(*) FROM <table>` queries fired in a synchronous loop. Each call to `/api/health/metrics` does 11 round-trips total. At a 5s page refresh that's ~7,900 queries per dashboard-day per operator.

Fix: replace the loop with a single UNION ALL query.

```sql
SELECT 'accounts'     AS t, COUNT(*)::bigint AS n FROM accounts UNION ALL
SELECT 'transactions',     COUNT(*)::bigint FROM transactions UNION ALL
SELECT 'categories',       COUNT(*)::bigint FROM categories UNION ALL
...
```

Result: 11 round-trips → 4 (ping, size, the single counts query, last_migration). About **2.5× faster** for the page that the operator stares at all day.

**Effort**: 15 min. **Visibility**: shows up immediately in the new slow-query log.

### P-2. Add the usage_counters lookup index

**File**: new migration

`billing.ts:49-63` runs:
```sql
SELECT used_count FROM usage_counters
 WHERE tenant_id = $1 AND feature_key = $2 AND period_end >= now()
```

The PK is `(tenant_id, feature_key, period_start)`. `period_end >= now()` is a range scan over the per-feature slice — fast at low scale, sequential-scan'y once a tenant has many historical period rows.

Fix:
```sql
CREATE INDEX usage_counters_current_idx
  ON usage_counters (tenant_id, feature_key, period_end DESC);
```

Each `/api/billing/status` and every `requireFeature()` gate runs this lookup — so every AI-assistant call, every paid-feature route. Worth it.

**Effort**: 5 min for the migration, 0 code change.

### P-3. Cache the active subscription per tenant (60s TTL)

**Files**: `server/src/auth/entitlements.ts:193-226`, `server/src/routes/billing.ts:79-95`

Today every `requireFeature()` call (which happens on most paid-tier routes) reads the subscriptions row from the DB. Subscriptions change only when a Stripe webhook lands or an operator manually edits — minutes-to-hours apart, not per-request.

Fix: small in-memory `Map<tenantId, { sub, expires }>` with a 60s TTL. Invalidate the entry when a `customer.subscription.*` webhook handler updates that tenant's row. A normal Node process easily holds thousands of cached subscriptions.

**Effort**: ~1 hour. **Cost**: one cache-invalidation hook added to webhook handlers.

### P-4. Lazy-load `recharts` and `marked` in the web bundle

**File**: `web/vite.config.ts` (none today)

The Vite production bundle is 1.09 MB. `recharts` (~90 KB gz) is only used by Health, Reports, and Insights pages. `marked` (~30 KB gz) only by the three legal pages. Both are top-level imports today and ship with the initial bundle.

Fix: convert those pages to `React.lazy()` + `Suspense`. Vite handles route-level code-splitting automatically once the import is dynamic. Estimated saving: ~120 KB gz off the first paint.

```tsx
// In App.tsx
const HealthPage = lazy(() => import('./pages/HealthPage'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage'));
// ... wrap render in <Suspense fallback={<p className="empty">Loading…</p>}>
```

**Effort**: ~30 min for 6 pages.

### P-5. Drop the duplicate HSTS header

**File**: `server/src/app.ts:200`

Cloudflare already sets `strict-transport-security: max-age=63072000; preload`. Helmet adds its own `max-age=63072000; includeSubDomains; preload`. RFC 6797 says receivers use the first one they see, so functionally fine, but it's two header lines we don't need.

Fix: pass `strictTransportSecurity: false` in the helmet options. Operators not behind Cloudflare can flip it back via env if needed.

**Effort**: 2 min.

## Medium wins (1-4 hours each)

### P-6. Materialize `/health/metrics` for read-mostly traffic

Today every health page poll triggers `collectHealth()` which does several DB hits, a disk walk for attachment bytes, and a statfs per mount. If multiple operators have the page open simultaneously they each pay.

Fix: cache the full `HealthSnapshot` in-process for 2 seconds. Five concurrent dashboards then share one collection instead of running five. The metricsRecorder timeseries is already an in-memory rolling buffer — same pattern applies.

**Effort**: 2 hours.

### P-7. Replace OCR-pending polling with Server-Sent Events

**File**: `web/src/components/AttachmentsModal.tsx:13`

The current pattern: after upload, poll every 2s until `ocr_status` flips off `pending`. A user uploading 10 receipts can generate 50+ requests/min just waiting.

Fix: open a single `EventSource('/api/attachments/events?tx_id=...')` while the modal is open; server push transitions. Fastify has `@fastify/sse-v2` if you want a plugin, or you can hand-roll the response stream. The OCR worker emits events on completion.

**Effort**: 3-4 hours. **Carries the bonus** of making the future agentic-AI moat work better (proactive cards in 0.20.x can use the same channel).

### P-8. Add transactions composite index for the dashboard query

**File**: new migration

The dashboard's "this month" query is roughly:
```sql
SELECT ... FROM transactions t
  JOIN accounts a ON a.id = t.account_id
 WHERE a.tenant_id = $1
   AND t.txn_date >= $2 AND t.txn_date <= $3
   [AND t.raw_description ILIKE '%'||$4||'%']
```

The `transactions_account_date` index helps when an `accountId` is supplied; without it, we hit per-account index seeks fanned across the tenant. The trigram extension (`pg_trgm`) on `raw_description` would also accelerate the search-box case.

Fix: 
```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX transactions_search_idx
  ON transactions USING gin (raw_description gin_trgm_ops);
```

Plus a covering index for the (tenant_id, txn_date) variant via a denormalized column — but only do that if a slow-query log entry actually proves the need. Don't pre-index.

**Effort**: ~30 min for the trgm; defer the denorm until you see it.

### P-9. Move the OCR sweep + auto-sync to a separate worker process

**Files**: `server/src/index.ts`, `server/src/ocr/extract-service.ts`, `server/src/domain/auto-sync.ts`

The current process does both: serve HTTP requests AND run background OCR, daily backup, daily auto-sync, periodic crypto/fuel-price refresh. When OCR hits a slow Claude vision call, it blocks an event-loop tick that could have been serving a dashboard request.

Fix: split into two containers (or one container with two Node processes via PM2 / a tiny supervisor). Workers share the same database; their state is durable in the existing tables. Health page reports both processes' stats via the same `/api/health/metrics` route (worker pid + uptime).

This is the right groundwork for 0.23.1 (stateless app + horizontal scale).

**Effort**: 4-6 hours; do it as a single 0.23.1 slice rather than ad-hoc.

## Bigger plays (defer until measured)

### P-10. Materialized view for the dashboard "month so far" rollup

The dashboard runs an aggregation across the current month's transactions on every load. For a household with thousands of transactions/month it's fine; the moment you have a power-user with 50K+ transactions/year, the page slows.

Fix: materialized view refreshed on transaction INSERT/UPDATE/DELETE via a trigger, or refreshed nightly via a job.

**Wait for evidence**: only do this if /api/health/slow-queries actually shows dashboard aggregations crossing the threshold. Premature.

### P-11. Postgres `pg_stat_statements` extension

This is the right tool for ongoing performance work but isn't installed today. Once enabled, you can ask Postgres directly "what are my slowest queries by total time" — much more accurate than the in-process slow-query log I added today (which is single-process, single-instance, lost on restart).

Fix: add `shared_preload_libraries = 'pg_stat_statements'` to postgresql.conf, restart, then `CREATE EXTENSION pg_stat_statements;`. Add a `/api/health/pg-stat-statements` endpoint that surfaces the top-20 by mean and total time.

**Effort**: ~30 min once you have a maintenance window for the postgres restart. Pair with P-7's worker split.

### P-12. CDN-cache the static legal docs

`/privacy`, `/terms`, `/cookies` serve the React SPA shell + bundle. After lazy-loading lands (P-4), each of those pages would serve a tiny shell + the legal-specific chunk. You could go further: serve pre-rendered static HTML for these three pages (no React at all) so they're cacheable at Cloudflare's edge.

Hold off until you actually see legal-page traffic worth caching.

## What to track to know if these worked

The `/health` page now has three diagnostic surfaces I shipped today:

- **DB qps gauge** — should drop after P-1 (the per-table loop) and P-3 (subscription cache).
- **Slow queries panel** — entries above the threshold (default 100ms) should drop after P-2 and P-8.
- **Recent warnings & errors panel** — should be largely empty in steady state; spikes signal real problems.

Iterate: pick the highest-value item, ship it, watch the panel, repeat.

## Non-goals (deliberate)

- **Premature N+1 fixes elsewhere**. The grep'd-for `for-loop-around-query` pattern in `routes/` is small. Only the health.ts case is hot enough to matter; the rest are typically per-request, not per-row.
- **Bundle splitting beyond P-4**. Modern browsers HTTP/2-multiplex so dozens of small chunks aren't free. Stop after the high-value lazy-loads.
- **Microservices / queue**. The monolith is the right architecture for this scale. The worker split in P-9 is the boundary — don't add Redis-as-queue, RabbitMQ, etc. until concrete metrics demand it.
- **Adding Redis for application caching now**. P-3's per-process Map is enough until 0.23.1 lands; Redis is the right answer ONCE the app goes multi-instance, not before.

## Suggested ship order

1. P-1 (table count UNION)        — 15 min
2. P-2 (usage_counters index)     — 5 min
3. P-5 (drop HSTS dup)            — 2 min
4. P-4 (lazy-load recharts/marked)— 30 min
5. P-3 (subscription cache)       — 60 min
6. P-8 trigram only               — 30 min

That's ~2.5 hours of work for measurable improvements on the operator dashboard, the billing path, and the transactions search.

Then P-6 / P-7 / P-9 as larger slices when you have appetite. P-10–P-12 are deferred-until-evidence.
