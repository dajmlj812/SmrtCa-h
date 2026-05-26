import type { FastifyInstance } from 'fastify';
import { errorSink } from '../domain/error-sink.js';

/**
 * 0.19.4 — receiver for client-side error reports.
 *
 *   POST /api/errors  — body { message, stack?, route?, userAgent?, extra? }
 *
 * The React error boundary POSTs here when it catches an uncaught
 * exception. We re-throw into the configured error sink (Sentry or
 * Noop) so server-side + client-side errors land in the same
 * external aggregator.
 *
 * Auth: optional. We forward whatever session context exists so
 * Sentry events get a tenant/user tag, but unauthenticated clients
 * (e.g. errors on the login page) still report through.
 */
export async function errorReportRoutes(app: FastifyInstance): Promise<void> {
  app.post<{
    Body: {
      message?: unknown;
      stack?: unknown;
      route?: unknown;
      userAgent?: unknown;
      extra?: unknown;
    };
  }>('/api/errors', async (req, reply) => {
    const body = req.body ?? {};
    const message =
      typeof body.message === 'string' ? body.message.slice(0, 500) : 'Unknown';
    const stack = typeof body.stack === 'string' ? body.stack.slice(0, 4000) : undefined;
    const route = typeof body.route === 'string' ? body.route.slice(0, 200) : undefined;
    const userAgent =
      typeof body.userAgent === 'string' ? body.userAgent.slice(0, 200) : undefined;
    const extra =
      body.extra && typeof body.extra === 'object'
        ? (body.extra as Record<string, unknown>)
        : undefined;

    // Synthesize an Error so the sink's stacktrace parser sees a real
    // .stack property.
    const err = new Error(message);
    if (stack) err.stack = stack;

    errorSink().capture(err, {
      source: 'web',
      route,
      reqId: req.id,
      tenantId: req.user?.tenantId ?? undefined,
      userId: req.user?.id,
      extra: {
        ...(userAgent ? { user_agent: userAgent } : {}),
        ...(extra ?? {}),
      },
    });

    req.log.warn(
      { msg: 'client error reported', message, route, userAgent },
      'web error',
    );
    return reply.code(204).send();
  });
}
