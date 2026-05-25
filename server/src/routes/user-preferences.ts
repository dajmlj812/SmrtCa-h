import type { FastifyInstance } from 'fastify';
import { pool } from '../db/pool.js';

/**
 * 0.18.14 — per-user UI preferences.
 *
 * Stored as a JSONB column on users.preferences (migration 057). One
 * row per user, free-form keys. The dashboard-layout shape is just
 * the first consumer; future per-user prefs (theme, default account,
 * etc.) live in the same blob.
 *
 * No global validation of the JSON shape on the server — each
 * consumer in the UI knows its own keys. The CHECK constraint in
 * the migration limits total size to 32 KB to prevent a malicious
 * client from filling the row.
 */

const MAX_PREFS_BYTES = 32_768;

export async function userPreferencesRoutes(app: FastifyInstance): Promise<void> {
  // Whole prefs blob. The client uses ?? {} to handle a brand-new
  // user who hasn't written anything yet (the DB default is '{}').
  app.get('/api/me/preferences', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const r = await pool.query<{ preferences: Record<string, unknown> }>(
      `SELECT preferences FROM users WHERE id = $1`,
      [req.user.id],
    );
    if (r.rowCount === 0) return reply.code(404).send({ error: 'User not found' });
    return { preferences: r.rows[0]!.preferences ?? {} };
  });

  // Targeted updater for the dashboard layout. We keep it as its
  // own endpoint (instead of a generic PATCH /api/me/preferences)
  // so we can validate the layout shape lightly and avoid a client
  // accidentally overwriting OTHER prefs by sending a partial blob.
  app.put('/api/me/preferences/dashboard-layout', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    const body = (req.body ?? {}) as { layout?: unknown; hidden?: unknown };

    // The layout is whatever react-grid-layout's ResponsiveGridLayout
    // gives back — an object keyed by breakpoint, with arrays of
    // { i, x, y, w, h }. We don't enforce the shape strictly; just
    // require an object and a sensible size. Clients that submit
    // garbage just won't render their cards on next load.
    if (typeof body.layout !== 'object' || body.layout === null || Array.isArray(body.layout)) {
      return reply.code(400).send({ error: 'layout must be an object' });
    }
    if (body.hidden !== undefined && !Array.isArray(body.hidden)) {
      return reply.code(400).send({ error: 'hidden must be an array' });
    }

    const blob = {
      layout: body.layout,
      hidden: body.hidden ?? [],
    };

    // Cheap size guard before the DB CHECK fires — gives a friendlier
    // 400 than a generic constraint-violation 500.
    const serialized = JSON.stringify(blob);
    if (serialized.length > MAX_PREFS_BYTES / 2) {
      return reply.code(413).send({ error: 'Dashboard layout payload too large' });
    }

    // Merge into the existing preferences blob. `||` is the JSONB
    // merge operator; later keys win, so we splice in dashboard
    // without disturbing other future-pref keys.
    await pool.query(
      `UPDATE users
          SET preferences = preferences || jsonb_build_object('dashboard', $2::jsonb)
        WHERE id = $1`,
      [req.user.id, serialized],
    );

    return { ok: true };
  });

  // Reset to default — just clear the dashboard key out of prefs.
  app.delete('/api/me/preferences/dashboard-layout', async (req, reply) => {
    if (!req.user) return reply.code(401).send({ error: 'Not authenticated' });
    await pool.query(
      `UPDATE users SET preferences = preferences - 'dashboard' WHERE id = $1`,
      [req.user.id],
    );
    return { ok: true };
  });
}
