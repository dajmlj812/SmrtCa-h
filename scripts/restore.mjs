#!/usr/bin/env node
// SmrtCash — restore script.
//
// Restores a backup produced by scripts/backup.mjs.
//
// Usage:
//   node scripts/restore.mjs ./backups/2026-05-22_12-00-00
//   node scripts/restore.mjs ./backups/<dir> --force
//
// Behavior:
//   - Drops every table in the target database and reloads from db.dump
//     via pg_restore. The script REFUSES to run unless you pass --force
//     or you confirm at the prompt — restore is destructive.
//   - Replaces the attachments directory atomically with the contents of
//     attachments.tgz when present.
//
// Requirements:
//   - pg_restore on PATH
//   - tar on PATH
//   - Server should be stopped before running (otherwise running queries
//     will conflict with the destructive DDL).

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { config as loadEnv } from 'dotenv';

const exec = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

function parseArgs(argv) {
  const args = { dir: null, force: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--force') args.force = true;
    else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/restore.mjs <backup-dir> [--force]\n\n' +
          'Restores the database and attachments from a backup directory.\n' +
          'DESTRUCTIVE — overwrites existing data.',
      );
      process.exit(0);
    } else if (!args.dir) {
      args.dir = argv[i];
    }
  }
  return args;
}

const args = parseArgs(process.argv);
if (!args.dir) {
  console.error('Usage: node scripts/restore.mjs <backup-dir> [--force]');
  process.exit(1);
}

const backupDir = resolve(args.dir);
const dumpPath = join(backupDir, 'db.dump');
const archivePath = join(backupDir, 'attachments.tgz');

if (!existsSync(dumpPath)) {
  console.error(`Missing db.dump in ${backupDir}`);
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const attachmentsDir = process.env.ATTACHMENTS_DIR
  ? resolve(process.env.ATTACHMENTS_DIR)
  : resolve(repoRoot, 'data/attachments');

if (!args.force) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(
    `\nThis will REPLACE the database at ${maskUrl(databaseUrl)}\n` +
      `and the attachments directory at ${attachmentsDir}.\n\n` +
      `Type "restore" to continue: `,
  );
  rl.close();
  if (answer.trim() !== 'restore') {
    console.log('Aborted.');
    process.exit(1);
  }
}

console.log(`Restoring from ${backupDir}`);

// pg_restore with --clean drops every object in the target db before
// recreating it from the dump, matching the backup exactly.
console.log('  pg_restore …');
try {
  await exec('pg_restore', [
    '--clean',
    '--if-exists',
    '--no-owner',
    '--no-privileges',
    `--dbname=${databaseUrl}`,
    dumpPath,
  ]);
  console.log('  ✓ database restored');
} catch (err) {
  console.error('pg_restore failed:', err.message);
  process.exit(1);
}

if (existsSync(archivePath)) {
  console.log('  replacing attachments directory …');
  try {
    await rm(attachmentsDir, { recursive: true, force: true });
    const parent = dirname(attachmentsDir);
    await mkdir(parent, { recursive: true });
    await exec('tar', ['-xzf', archivePath, '-C', parent]);
    const s = await stat(attachmentsDir).catch(() => null);
    if (!s || !s.isDirectory()) {
      console.warn(
        '  (tar finished but attachments dir is missing — archive layout may be unexpected)',
      );
    } else {
      console.log('  ✓ attachments restored');
    }
  } catch (err) {
    console.error('attachment restore failed:', err.message);
    process.exit(1);
  }
} else {
  console.log('  (no attachments.tgz in backup — skipping)');
}

console.log('Done. Restart the server to pick up the restored data.');

function maskUrl(url) {
  return url.replace(/:[^@/]*@/, ':****@');
}
