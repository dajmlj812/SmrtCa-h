import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { Writable } from 'node:stream';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
import helmet from '@fastify/helmet';
import { diagnosticsRecorder } from './domain/diagnostics-recorder.js';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { pool } from './db/pool.js';
import { ImportError } from './import/importer.js';
import { accountRoutes } from './routes/accounts.js';
import { categoryRoutes } from './routes/categories.js';
import { transactionRoutes } from './routes/transactions.js';
import { importRoutes } from './routes/imports.js';
import { normalizeRoutes } from './routes/normalize.js';
import { suggestionRoutes } from './routes/suggestions.js';
import { attachmentRoutes } from './routes/attachments.js';
import { transferRoutes } from './routes/transfers.js';
import { insightsRoutes } from './routes/insights.js';
import { authRoutes } from './routes/auth.js';
import { budgetRoutes } from './routes/budgets.js';
import { goalRoutes } from './routes/goals.js';
import { billRoutes } from './routes/bills.js';
import { cancellationRoutes } from './routes/cancellation.js';
import { apiKeyRoutes } from './routes/api-keys.js';
import { debtPayoffRoutes } from './routes/debt-payoff.js';
import { recurringRoutes } from './routes/recurring.js';
import { subscriptionRoutes } from './routes/subscriptions.js';
import { normalizationRuleRoutes } from './routes/normalization-rules.js';
import { splitRoutes } from './routes/splits.js';
import { holdingRoutes } from './routes/holdings.js';
import { vehicleRoutes } from './routes/vehicles.js';
import { commuteRouteRoutes } from './routes/commute-routes.js';
import { fuelPriceRoutes } from './routes/fuel-prices.js';
import { budgetWizardRoutes } from './routes/budget-wizard.js';
import { budgetPlansRoutes } from './routes/budget-plans.js';
import { settingsRoutes } from './routes/settings.js';
import { healthRoutes } from './routes/health.js';
import { backupRoutes } from './routes/backups.js';
import { reportRoutes } from './routes/reports.js';
import { tenantRoutes } from './routes/tenants.js';
import { authProviderRoutes } from './routes/auth-providers.js';
import { systemRoutes } from './routes/system.js';
import { exchangeRatesRoutes } from './routes/exchange-rates.js';
import { projectionRoutes } from './routes/projections.js';
import { ofxDcRoutes } from './routes/ofx-dc.js';
import { plaidRoutes } from './routes/plaid.js';
import { autoSyncRoutes } from './routes/auto-sync.js';
import { assistantRoutes } from './routes/assistant.js';
import { shareRoutes } from './routes/shares.js';
import { calendarRoutes } from './routes/calendar.js';
import { portabilityRoutes } from './routes/portability.js';
import { taxYearRoutes } from './routes/tax-year.js';
import { anomalyRoutes } from './routes/anomalies.js';
import { billingRoutes } from './routes/billing.js';
import { applyBootSettings } from './domain/settings.js';
import { startBackupScheduler } from './domain/backup-scheduler.js';
import { startAutoSyncScheduler } from './domain/auto-sync.js';
import { metricsRecorder } from './domain/metrics-recorder.js';
import { SESSION_COOKIE, loadSession } from './auth/sessions.js';
import { lookupKey } from './auth/api-keys.js';

// Augment FastifyRequest with the authenticated user. Set by the auth
// preHandler below. `tenantId` is the session's active tenant — null
// until the user picks one (or for fresh sessions where the user has
// no memberships yet).
// 0.18.4 — `via` records whether the request was authenticated via
// the session cookie or a public-API Bearer token. A second hook
// rejects non-GET methods for `apikey` requests (the public API is
// read-only in this slice).
declare module 'fastify' {
  interface FastifyRequest {
    user?: {
      id: string;
      tenantId: string | null;
      isSuperAdmin: boolean;
      via: 'session' | 'apikey';
    };
  }
}

// URL prefixes that do NOT require an authenticated session. The OIDC
// begin + callback paths are also public so a logged-out user can hit
// them; the rest of /api/auth/* (logout, me) require a session.
const PUBLIC_PATHS = new Set<string>([
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
  '/api/auth/providers',
  // 0.16.0: public signup + email verification. Both must be
  // reachable without a session; the routes themselves 404 when
  // PUBLIC_SIGNUP_ENABLED is off, so simply listing them here is
  // safe on self-host deployments.
  '/api/auth/signup',
  '/api/auth/verify-email',
  // 0.16.2: password reset request + confirm. Public — a
  // locked-out user has no session by definition. NOT gated by
  // PUBLIC_SIGNUP_ENABLED because self-host users still need to
  // recover their own passwords.
  '/api/auth/password-reset-request',
  '/api/auth/password-reset-confirm',
  // 0.15.1: Stripe webhook posts here. No session cookie; auth is
  // via Stripe-signature header which the route handler verifies.
  '/api/billing/webhook',
]);
const PUBLIC_PREFIXES = ['/api/auth/oidc/', '/api/invitations/'];

export interface BuildAppOptions {
  /** Enable Fastify's request logger. Off by default in tests. */
  logger?: boolean;
}

/**
 * Construct a fully-wired Fastify instance without starting a listener.
 * Used both by the production bootstrap (`index.ts`) and by integration
 * tests (which drive it with `app.inject()`).
 */
export async function buildApp(
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  // Hot-load DB-resident settings into `config` BEFORE registering the
  // cookie plugin / parsing the attachment key — so GUI-set values win
  // over .env at boot.
  await applyBootSettings();

  // 0.18.13 — Pino destination that tees log lines into stdout (so
  // `docker logs` keeps working as the source of truth) AND into the
  // in-memory diagnostics recorder, where /api/health/logs reads
  // recent warn/error/fatal entries on demand. Tests pass logger=false
  // and skip this entirely.
  const loggerOption: import('fastify').FastifyServerOptions['logger'] =
    (opts.logger ?? true)
      ? { stream: createDiagnosticsLogStream() }
      : false;
  const app = Fastify({ logger: loggerOption });

  // 0.15.1: replace Fastify's default JSON parser with one that ALSO
  // stashes the raw request body on `req.rawBody`. Required by the
  // Stripe webhook route — `stripe.webhooks.constructEvent` verifies
  // the HMAC signature against the original bytes, NOT the
  // re-serialized JSON. Cost: one Buffer per JSON request, ~1 KB
  // typical; negligible.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (req, body, done) => {
      try {
        // Empty bodies are valid (some PATCH-without-body callers).
        const buf = body as Buffer;
        const parsed = buf.length === 0 ? {} : JSON.parse(buf.toString('utf8'));
        (req as FastifyRequest & { rawBody?: Buffer }).rawBody = buf;
        done(null, parsed);
      } catch (err) {
        done(err as Error, undefined);
      }
    },
  );

  // F-04 (security audit 2026-05-25) — security response headers.
  // CSP allows the bundle's own scripts + Cloudflare's rocket-loader
  // (which Cloudflare injects unconditionally on this site); 'self'
  // for other sources; explicit deny of frame ancestors so the
  // financial dashboard can't be iframed for clickjacking. Connect-
  // src includes the same origin (Fastify serves both the API and
  // the SPA from one host) plus Stripe's checkout/dashboard URLs
  // the embedded portal redirects to.
  await app.register(helmet, {
    // We set CSP explicitly below because helmet's default is too
    // strict for the Cloudflare rocket-loader script tag we get for
    // free with the CF proxy. If you remove CF (or its rocket-loader)
    // you can drop the 'cdn-cgi' source.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          // Cloudflare rocket-loader injects an inline-bootstrap +
          // a script from /cdn-cgi/scripts. The bootstrap is hashed
          // each page load, so we use 'unsafe-inline' here. If we
          // turn off rocket-loader in CF, this can drop to just
          // 'self'.
          "'unsafe-inline'",
          'https://static.cloudflareinsights.com',
        ],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        connectSrc: ["'self'", 'https://api.stripe.com'],
        frameSrc: ["'self'", 'https://js.stripe.com'],
        // PWA manifest + workers may load
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        // Don't allow ANY ancestor — defense against clickjacking.
        frameAncestors: ["'none'"],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        // upgradeInsecureRequests is browser-only protection; we're
        // already HTTPS-only behind Cloudflare with HSTS but cheap.
        upgradeInsecureRequests: [],
      },
    },
    // The rest are the safe defaults from helmet — we keep them all.
    crossOriginEmbedderPolicy: false, // would block 3rd-party images
    crossOriginResourcePolicy: { policy: 'same-site' },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    xFrameOptions: { action: 'deny' },
    xContentTypeOptions: true,
    strictTransportSecurity: {
      maxAge: 63072000,
      includeSubDomains: true,
      preload: true,
    },
    // permissions-policy: deny everything sensitive by default.
    permittedCrossDomainPolicies: { permittedPolicies: 'none' },
  });

  await app.register(cors, { origin: true, credentials: true });
  await app.register(cookie, { secret: config.auth.sessionSecret });
  await app.register(multipart, {
    // `files: 10` lets the attachment route accept multiple receipts per
    // request. The single-file routes (import) just grab the first file part.
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
  });

  // Auth gate. Every /api/* route is private except the small set above —
  // health, status, setup, login, logout. Static asset requests (the SPA
  // bundle that the browser fetches BEFORE login) are unaffected so the
  // login screen itself can load.
  app.addHook('preHandler', async (req, reply) => {
    const url = (req.url.split('?')[0] ?? '').replace(/\/+$/, '');
    if (!url.startsWith('/api/') && url !== '/api') return;
    const isPublic =
      PUBLIC_PATHS.has(url) || PUBLIC_PREFIXES.some((p) => url.startsWith(p));
    if (isPublic) {
      // For /api/auth/status we still try to populate req.user so the
      // endpoint can report `authenticated: true` when applicable.
      if (url === '/api/auth/status') {
        const raw = req.cookies[SESSION_COOKIE];
        if (raw) {
          const unsigned = req.unsignCookie(raw);
          if (unsigned.valid && unsigned.value) {
            const session = await loadSession(unsigned.value);
            if (session)
              req.user = {
                id: session.userId,
                tenantId: session.activeTenantId,
                isSuperAdmin: session.isSuperAdmin,
                via: 'session',
              };
          }
        }
      }
      return;
    }

    const raw = req.cookies[SESSION_COOKIE];
    if (raw) {
      const unsigned = req.unsignCookie(raw);
      if (!unsigned.valid || !unsigned.value) {
        return reply.code(401).send({ error: 'Invalid session' });
      }
      const session = await loadSession(unsigned.value);
      if (!session) {
        return reply.code(401).send({ error: 'Session expired' });
      }
      // F-36 (security audit 2026-05-25) — verify membership on every
      // tenant-scoped request. The on-delete invalidation in
      // tenants.ts:removeMember handles the proactive case, but this
      // gate catches any race where the session was loaded before the
      // membership delete and still holds an active_tenant_id. We
      // surface tenantId=null to the route, which the existing
      // requireTenant() helpers translate to a 403.
      let activeTenantId = session.activeTenantId;
      if (activeTenantId !== null && !session.isSuperAdmin) {
        const m = await pool.query<{ n: string }>(
          `SELECT COUNT(*)::text AS n
             FROM memberships
            WHERE user_id = $1 AND tenant_id = $2`,
          [session.userId, activeTenantId],
        );
        if (Number(m.rows[0]?.n ?? '0') === 0) {
          activeTenantId = null;
        }
      }
      req.user = {
        id: session.userId,
        tenantId: activeTenantId,
        isSuperAdmin: session.isSuperAdmin,
        via: 'session',
      };
      return;
    }

    // 0.18.4 — fall back to a Bearer API token. The token is read-
    // only; a second preHandler rejects non-GET methods so a leaked
    // token can't be used to mutate data. Tenant binding comes from
    // the api_keys row, NOT from the request, so a key minted under
    // tenant A can never see tenant B's data even if the caller
    // tries to set headers/query to mislead us.
    const authHeader = req.headers.authorization;
    if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
      const token = authHeader.slice('Bearer '.length).trim();
      const key = await lookupKey(token, req.ip ?? null);
      if (!key) {
        return reply.code(401).send({ error: 'Invalid or revoked API key' });
      }
      req.user = {
        id: key.userId,
        tenantId: key.tenantId,
        isSuperAdmin: false,
        via: 'apikey',
      };
      return;
    }

    return reply.code(401).send({ error: 'Authentication required' });
  });

  // 0.18.4 — public-API tokens are read-only. Block any non-GET
  // method for apikey-authed requests. Runs AFTER the auth hook,
  // so req.user is populated for legitimate requests by the time
  // this fires; cookie-authed requests pass through unchanged.
  app.addHook('preHandler', async (req, reply) => {
    if (req.user?.via !== 'apikey') return;
    const method = req.method.toUpperCase();
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
      return reply.code(403).send({
        error: 'API keys are read-only. Mutating requests must use a session.',
      });
    }
  });

  app.setErrorHandler(
    (err: Error & { statusCode?: number; code?: string }, req, reply) => {
      if (err instanceof ImportError) {
        return reply.code(400).send({ error: err.message });
      }
      // F-09 (security audit 2026-05-25) — don't leak the JSON parser's
      // internal state to the caller. Malformed JSON gets a generic
      // 400 with the details only in the server log; same for Fastify
      // schema-validation errors and Fastify's content-type parser
      // errors. Without this, "Expected ',' or '}' after property
      // value in JSON at position 21 (line 1 column 22)" was being
      // sent back to the client.
      const code = err.code ?? '';
      const isParserError =
        err instanceof SyntaxError ||
        code === 'FST_ERR_CTP_INVALID_MEDIA_TYPE' ||
        code === 'FST_ERR_CTP_BODY_TOO_LARGE' ||
        code === 'FST_ERR_VALIDATION' ||
        code.startsWith('FST_ERR_CTP_');
      if (isParserError) {
        req.log.warn({ err, code }, 'Request body could not be parsed');
        return reply.code(400).send({ error: 'Malformed request body' });
      }
      app.log.error(err);
      const status = err.statusCode ?? 500;
      // For 5xx, hide the message — internal errors shouldn't leak
      // stack-trace adjacent context. For 4xx that the route itself
      // threw with a statusCode, the message is intentional (auth
      // failures, "not found", etc.) so let it through.
      if (status >= 500) {
        return reply.code(status).send({ error: 'Internal Server Error' });
      }
      return reply
        .code(status)
        .send({ error: err.message || 'Internal Server Error' });
    },
  );

  app.get('/api/health', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok', time: new Date().toISOString() };
  });

  await app.register(authRoutes);
  await app.register(accountRoutes);
  await app.register(categoryRoutes);
  await app.register(transactionRoutes);
  await app.register(importRoutes);
  await app.register(normalizeRoutes);
  await app.register(suggestionRoutes);
  await app.register(attachmentRoutes);
  await app.register(transferRoutes);
  await app.register(insightsRoutes);
  await app.register(budgetRoutes);
  await app.register(goalRoutes);
  await app.register(billRoutes);
  await app.register(cancellationRoutes);
  await app.register(apiKeyRoutes);
  await app.register(debtPayoffRoutes);
  await app.register(recurringRoutes);
  await app.register(subscriptionRoutes);
  await app.register(normalizationRuleRoutes);
  await app.register(splitRoutes);
  await app.register(holdingRoutes);
  await app.register(vehicleRoutes);
  await app.register(commuteRouteRoutes);
  await app.register(fuelPriceRoutes);
  await app.register(budgetWizardRoutes);
  await app.register(budgetPlansRoutes);
  await app.register(settingsRoutes);
  await app.register(healthRoutes);
  await app.register(backupRoutes);
  await app.register(reportRoutes);
  await app.register(tenantRoutes);
  await app.register(authProviderRoutes);
  await app.register(systemRoutes);
  await app.register(exchangeRatesRoutes);
  await app.register(projectionRoutes);
  await app.register(ofxDcRoutes);
  await app.register(plaidRoutes);
  await app.register(autoSyncRoutes);
  await app.register(assistantRoutes);
  await app.register(shareRoutes);
  await app.register(calendarRoutes);
  await app.register(portabilityRoutes);
  await app.register(taxYearRoutes);
  await app.register(anomalyRoutes);
  await app.register(billingRoutes);

  // Kick off the in-process backup scheduler. No-op until BACKUP_ENABLED
  // = true is set via the GUI; the loop reads settings on every tick.
  startBackupScheduler();
  // Phase 8.3 — periodic OFX-DC + Plaid sync. Same pattern: settings
  // read on every tick, no-op until AUTO_SYNC_ENABLED=true.
  startAutoSyncScheduler();

  // Start the rolling-metrics recorder and instrument every HTTP
  // response. The /api/health/timeseries endpoint reads its buffer.
  metricsRecorder.start();
  app.addHook('onResponse', (req, reply, done) => {
    metricsRecorder.incRequest(reply.statusCode);
    done();
  });

  // Optional: serve the prebuilt web bundle from the same process. The
  // Docker image copies `web/dist` into `server/dist/public`; in dev the
  // directory doesn't exist and Vite serves the frontend on its own port.
  const here = dirname(fileURLToPath(import.meta.url));
  const staticDir = process.env.STATIC_DIR
    ? resolve(process.env.STATIC_DIR)
    : resolve(here, 'public');
  if (existsSync(staticDir)) {
    await app.register(staticPlugin, {
      root: staticDir,
      prefix: '/',
      wildcard: false,
    });
    // SPA fallback — any non-API GET that didn't match a static file
    // returns index.html so React Router can take over on the client.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        return reply.type('text/html').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  return app;
}

/**
 * 0.18.13 — tee log destination.
 *
 * Pino emits one JSON line per log call. This stream forwards every
 * line to stdout (so `docker logs smrtcash-app` is still the
 * authoritative source) and parses it on the way through to capture
 * warn/error/fatal entries in the diagnostics ring buffer. The
 * /api/health/logs endpoint reads from that buffer on demand — the
 * operator can spot whatever's been going wrong without SSH.
 *
 * Pino level numbers: trace=10, debug=20, info=30, warn=40, error=50,
 * fatal=60. We capture everything ≥ warn.
 */
function createDiagnosticsLogStream(): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const line = typeof chunk === 'string' ? chunk : chunk.toString('utf-8');
      // Always emit to stdout — that's the production logging path.
      process.stdout.write(line);
      // Best-effort parse + capture. Any JSON failure is silently
      // swallowed; we never want logger plumbing to fail a request.
      try {
        const entry = JSON.parse(line) as {
          level?: number;
          time?: number;
          msg?: string;
          err?: { code?: string; type?: string };
          reqId?: string;
          [key: string]: unknown;
        };
        const lvl = entry.level ?? 30;
        if (lvl >= 40) {
          const context: Record<string, unknown> = {};
          if (entry.reqId) context.reqId = entry.reqId;
          if (entry.err?.code) context.code = entry.err.code;
          if (entry.err?.type) context.type = entry.err.type;
          // Pull a few common operational fields without dragging the
          // whole serialized req/res blob.
          for (const k of ['userId', 'tenantId', 'eventId', 'action']) {
            if (entry[k] !== undefined) context[k] = entry[k];
          }
          diagnosticsRecorder.recordLog({
            ts: entry.time
              ? new Date(entry.time).toISOString()
              : new Date().toISOString(),
            level: lvl >= 60 ? 'fatal' : lvl >= 50 ? 'error' : 'warn',
            msg: entry.msg ?? '',
            context: Object.keys(context).length > 0 ? context : undefined,
          });
        }
      } catch {
        /* malformed line — leave it on stdout, skip the capture */
      }
      callback();
    },
  });
}
