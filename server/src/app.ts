import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import { pool } from './db/pool.js';
import { ImportError } from './import/importer.js';
import { accountRoutes } from './routes/accounts.js';
import { categoryRoutes } from './routes/categories.js';
import { transactionRoutes } from './routes/transactions.js';
import { importRoutes } from './routes/imports.js';
import { normalizeRoutes } from './routes/normalize.js';
import { suggestionRoutes } from './routes/suggestions.js';
import { attachmentRoutes } from './routes/attachments.js';

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
  const app = Fastify({ logger: opts.logger ?? true });

  await app.register(cors, { origin: true });
  await app.register(multipart, {
    // `files: 10` lets the attachment route accept multiple receipts per
    // request. The single-file routes (import) just grab the first file part.
    limits: { fileSize: 25 * 1024 * 1024, files: 10 },
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

  await app.register(accountRoutes);
  await app.register(categoryRoutes);
  await app.register(transactionRoutes);
  await app.register(importRoutes);
  await app.register(normalizeRoutes);
  await app.register(suggestionRoutes);
  await app.register(attachmentRoutes);

  return app;
}
