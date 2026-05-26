/**
 * 0.19.4 — pluggable error sink.
 *
 * Captures server-side exceptions + frontend errors and forwards them
 * to an external sink (Sentry / no-op). The interface is intentionally
 * small so swapping sinks is a one-line change at boot.
 *
 * Default is `NoopErrorSink` — never sends anything anywhere. To
 * enable Sentry, set the `SENTRY_DSN` env var; the boot logic in
 * app.ts swaps in `SentryErrorSink`.
 *
 * Why not import the full @sentry/node SDK: it pulls in ~500 KB of
 * deps for what is, on our usage pattern, a single HTTP POST per
 * captured event. The minimal envelope-format adapter here keeps
 * the runtime small and avoids the SDK's instrumentation magic
 * (which would conflict with Fastify's own request hooks).
 */

import { request as httpsRequest } from 'node:https';

export interface ErrorContext {
  /** Route/path that triggered the error. */
  route?: string;
  /** Tenant id from the authenticated session, if any. */
  tenantId?: string;
  /** User id from the authenticated session, if any. */
  userId?: string;
  /** Pino-assigned request id for correlating with logs. */
  reqId?: string;
  /** Where the error came from. */
  source?: 'server' | 'web';
  /** Free-form extras the caller wants to attach. */
  extra?: Record<string, unknown>;
}

export interface ErrorSink {
  capture(err: unknown, context?: ErrorContext): void;
}

class NoopErrorSink implements ErrorSink {
  capture(): void {
    // Intentional no-op. Errors still surface via the regular log
    // stream (Fastify logs them before calling capture); this sink
    // is purely the external-aggregator forwarder.
  }
}

class SentryErrorSink implements ErrorSink {
  private readonly host: string;
  private readonly projectId: string;
  private readonly publicKey: string;
  private readonly environment: string;
  private readonly release: string | undefined;

  /**
   * Parse a Sentry DSN like:
   *   https://<publicKey>@<host>/<projectId>
   */
  constructor(dsn: string, opts: { environment?: string; release?: string } = {}) {
    const m = dsn.match(/^https:\/\/([^@]+)@([^/]+)\/(\d+)$/);
    if (!m) {
      throw new Error(
        'SENTRY_DSN must be of the form https://<publicKey>@<host>/<projectId>',
      );
    }
    this.publicKey = m[1]!;
    this.host = m[2]!;
    this.projectId = m[3]!;
    this.environment = opts.environment ?? 'production';
    this.release = opts.release;
  }

  capture(err: unknown, context?: ErrorContext): void {
    // Fire-and-forget — never block the request on the sink. Sentry
    // returns 200 within ~100ms typically; on transport failure we
    // log to stderr and move on.
    const payload = this.buildPayload(err, context);
    this.post(payload).catch((sinkErr) => {
      // eslint-disable-next-line no-console
      console.error(
        'error-sink: failed to forward to Sentry:',
        sinkErr instanceof Error ? sinkErr.message : String(sinkErr),
      );
    });
  }

  private buildPayload(err: unknown, context?: ErrorContext): Record<string, unknown> {
    const e = err instanceof Error ? err : new Error(String(err));
    return {
      event_id: randomHex(32),
      timestamp: new Date().toISOString(),
      platform: 'node',
      environment: this.environment,
      ...(this.release ? { release: this.release } : {}),
      level: 'error',
      logger: 'smrtcash',
      exception: {
        values: [
          {
            type: e.name,
            value: e.message,
            ...(e.stack ? { stacktrace: parseStack(e.stack) } : {}),
          },
        ],
      },
      tags: {
        ...(context?.source ? { source: context.source } : {}),
        ...(context?.route ? { route: context.route } : {}),
      },
      user: context?.userId
        ? { id: context.userId, ...(context?.tenantId ? { tenant_id: context.tenantId } : {}) }
        : undefined,
      extra: {
        ...(context?.reqId ? { req_id: context.reqId } : {}),
        ...(context?.extra ?? {}),
      },
    };
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    // Sentry envelope endpoint format:
    //   POST /api/<projectId>/store/?sentry_version=7&sentry_key=<publicKey>
    const path = `/api/${this.projectId}/store/?sentry_version=7&sentry_key=${this.publicKey}`;
    const body = JSON.stringify(payload);
    await new Promise<void>((resolve, reject) => {
      const req = httpsRequest(
        {
          method: 'POST',
          host: this.host,
          path,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: 5000,
        },
        (res) => {
          res.resume(); // drain
          if (!res.statusCode || res.statusCode >= 300) {
            reject(new Error(`Sentry returned HTTP ${res.statusCode}`));
            return;
          }
          resolve();
        },
      );
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy(new Error('Sentry POST timed out'));
      });
      req.write(body);
      req.end();
    });
  }
}

/** Convert an Error.stack string into a Sentry-flavored stacktrace.frames array. */
function parseStack(stack: string): { frames: Array<Record<string, unknown>> } {
  const lines = stack.split('\n').slice(1);
  const frames: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    const m = line.match(/^\s+at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/);
    if (!m) continue;
    frames.push({
      function: m[1] ?? '?',
      filename: m[2],
      lineno: Number(m[3]),
      colno: Number(m[4]),
    });
  }
  // Sentry expects oldest-first.
  return { frames: frames.reverse() };
}

function randomHex(chars: number): string {
  const bytes = Math.ceil(chars / 2);
  let out = '';
  for (let i = 0; i < bytes; i++) {
    out += Math.floor(Math.random() * 256)
      .toString(16)
      .padStart(2, '0');
  }
  return out.slice(0, chars);
}

// ── Singleton ─────────────────────────────────────────────

let _sink: ErrorSink = new NoopErrorSink();

/**
 * Replace the active error sink. Called once at boot from app.ts
 * based on env config. Tests can also call this to inject a stub.
 */
export function setErrorSink(sink: ErrorSink): void {
  _sink = sink;
}

export function errorSink(): ErrorSink {
  return _sink;
}

/**
 * Boot helper — pick a sink based on env. SENTRY_DSN set →
 * SentryErrorSink, otherwise NoopErrorSink. Called from
 * app.ts during startup.
 */
export function configureErrorSinkFromEnv(): void {
  const dsn = process.env.SENTRY_DSN?.trim();
  if (!dsn) {
    setErrorSink(new NoopErrorSink());
    return;
  }
  try {
    setErrorSink(
      new SentryErrorSink(dsn, {
        environment: process.env.NODE_ENV ?? 'production',
        release: process.env.APP_VERSION,
      }),
    );
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(
      'error-sink: SENTRY_DSN was set but invalid — falling back to Noop:',
      err instanceof Error ? err.message : String(err),
    );
    setErrorSink(new NoopErrorSink());
  }
}
