#!/usr/bin/env node
// Promote a new user to super_admin from the command line. Used on
// upgrades from 0.8.x where the existing owner became a tenant_admin
// and no super_admin exists yet.
//
// Usage:
//   node scripts/create-super-admin.mjs --email <email> --password <pw> [--name <name>]
//
// Reads DATABASE_URL from .env. Refuses if a user with this email
// already exists OR if the email is already a tenant member (super-
// admins cannot also be tenant users — that's enforced by trigger).

import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

// We pull dependencies from the server/ package, which is where pg +
// argon2 are already installed. createRequire lets us reach into a
// sibling node_modules without re-installing.
const requireFromServer = createRequire(join(repoRoot, 'server', 'package.json'));
const { Pool } = requireFromServer('pg');
const argon2 = requireFromServer('argon2');

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i++) {
    const flag = argv[i];
    const next = argv[i + 1];
    if (flag === '--email' && next) { args.email = next; i++; }
    else if (flag === '--password' && next) { args.password = next; i++; }
    else if (flag === '--name' && next) { args.name = next; i++; }
    else if (flag === '--help' || flag === '-h') {
      console.log(
        'Usage: node scripts/create-super-admin.mjs --email <email> --password <pw> [--name <name>]',
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.email || !args.password) {
  console.error('Both --email and --password are required.');
  process.exit(1);
}
if (args.password.length < 8) {
  console.error('Password must be at least 8 characters.');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set.');
  process.exit(1);
}

const pool = new Pool({ connectionString: databaseUrl });

try {
  const existing = await pool.query(
    `SELECT id FROM users WHERE lower(email) = lower($1) LIMIT 1`,
    [args.email],
  );
  if (existing.rowCount > 0) {
    console.error(`A user with email ${args.email} already exists.`);
    process.exit(1);
  }

  const hash = await argon2.hash(args.password, { type: argon2.argon2id });
  const insert = await pool.query(
    `INSERT INTO users (email, name, password_hash, is_super_admin)
     VALUES ($1, $2, $3, true) RETURNING id`,
    [args.email, args.name ?? 'Operator', hash],
  );
  const userId = insert.rows[0].id;
  await pool.query(
    `INSERT INTO user_identities (user_id, provider, provider_user_id, email)
     VALUES ($1, 'local', $2, $3)`,
    [userId, userId, args.email],
  );
  await pool.query(
    `INSERT INTO audit_log (actor_user_id, actor_kind, action, target_kind, target_id, details)
     VALUES ($1, 'system', 'super_admin.create', 'user', $2::text, $3::jsonb)`,
    [userId, userId, JSON.stringify({ email: args.email, via: 'cli' })],
  );
  console.log(`Created super-admin ${args.email} (id ${userId}).`);
  console.log(`They can now sign in at /login and land on /system.`);
} catch (err) {
  console.error('Failed:', err.message);
  process.exitCode = 1;
} finally {
  await pool.end();
}
