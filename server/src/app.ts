import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import cookie from '@fastify/cookie';
import multipart from '@fastify/multipart';
import staticPlugin from '@fastify/static';
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
import { recurringRoutes } from './routes/recurring.js';
import { normalizationRuleRoutes } from './routes/normalization-rules.js';
import { splitRoutes } from './routes/splits.js';
import { holdingRoutes } from './routes/holdings.js';
import { vehicleRoutes } from './routes/vehicles.js';
import { commuteRouteRoutes } from './routes/commute-routes.js';
import { fuelPriceRoutes } from './routes/fuel-prices.js';
import { budgetWizardRoutes } from './routes/budget-wizard.js';
import { settingsRoutes } from './routes/settings.js';
import { applyBootSettings } from './domain/settings.js';
import { SESSION_COOKIE, loadSession } from './auth/sessions.js';

// Augment FastifyRequest with the authenticated user. Set by the auth
// preHandler below.
declare module 'fastify' {
  interface FastifyRequest {
    user?: { id: string };
  }
}

// URL prefixes that do NOT require an authenticated session.
const PUBLIC_PATHS = new Set<string>([
  '/api/health',
  '/api/auth/status',
  '/api/auth/setup',
  '/api/auth/login',
  '/api/auth/logout',
]);

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

  const app = Fastify({ logger: opts.logger ?? true });

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
    if (PUBLIC_PATHS.has(url)) {
      // For /api/auth/status we still try to populate req.user so the
      // endpoint can report `authenticated: true` when applicable.
      if (url === '/api/auth/status') {
        const raw = req.cookies[SESSION_COOKIE];
        if (raw) {
          const unsigned = req.unsignCookie(raw);
          if (unsigned.valid && unsigned.value) {
            const session = await loadSession(unsigned.value);
            if (session) req.user = { id: session.userId };
          }
        }
      }
      return;
    }

    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) {
      return reply.code(401).send({ error: 'Authentication required' });
    }
    const unsigned = req.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) {
      return reply.code(401).send({ error: 'Invalid session' });
    }
    const session = await loadSession(unsigned.value);
    if (!session) {
      return reply.code(401).send({ error: 'Session expired' });
    }
    req.user = { id: session.userId };
  });

  app.setErrorHandler(
    (err: Error & { statusCode?: number }, _req, reply) => {
      if (err instanceof ImportError) {
        return reply.code(400).send({ error: err.message });
      }
      app.log.error(err);
      const status = err.statusCode ?? 500;
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
  await app.register(recurringRoutes);
  await app.register(normalizationRuleRoutes);
  await app.register(splitRoutes);
  await app.register(holdingRoutes);
  await app.register(vehicleRoutes);
  await app.register(commuteRouteRoutes);
  await app.register(fuelPriceRoutes);
  await app.register(budgetWizardRoutes);
  await app.register(settingsRoutes);

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
