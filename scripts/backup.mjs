#!/usr/bin/env node
// SmrtCash — backup script.
//
// Snapshots the Postgres database and the attachments directory into
// ./backups/<ISO timestamp>/ as two files:
//
//   db.dump          — pg_dump custom-format archive (use pg_restore)
//   attachments.tgz  — gzipped tar of the attachments tree
//
// Usage:
//   node scripts/backup.mjs                          # uses .env
//   node scripts/backup.mjs --out ./elsewhere        # custom output dir
//
// Requirements:
//   - pg_dump on PATH (matching the server's Postgres major version)
//   - tar on PATH (built-in on macOS/Linux and modern Windows)
//
// The script reads DATABASE_URL and ATTACHMENTS_DIR from .env; override
// either via env var if you need to point at a non-default location.

import { execFile } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { config as loadEnv } from 'dotenv';

const exec = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
loadEnv({ path: join(repoRoot, '.env') });

function parseArgs(argv) {
  const args = { out: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--out' && argv[i + 1]) {
      args.out = argv[++i];
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      console.log(
        'Usage: node scripts/backup.mjs [--out <dir>]\n\n' +
          'Backs up the Postgres database (pg_dump) and the attachments\n' +
          'directory (tar.gz) into ./backups/<timestamp>/ by default.',
      );
      process.exit(0);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set. Aborting.');
  process.exit(1);
}

const attachmentsDir = process.env.ATTACHMENTS_DIR
  ? resolve(process.env.ATTACHMENTS_DIR)
  : resolve(repoRoot, 'data/attachments');

const timestamp = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace(/T/, '_')
  .slice(0, 19);
const baseDir = args.out ?? join(repoRoot, 'backups', timestamp);
await mkdir(baseDir, { recursive: true });

console.log(`Writing backup to ${baseDir}`);

// Postgres dump — custom format (compressed, restorable with pg_restore).
const dumpPath = join(baseDir, 'db.dump');
console.log('  pg_dump …');
try {
  await exec('pg_dump', [
    '--format=custom',
    '--compress=9',
    `--file=${dumpPath}`,
    databaseUrl,
  ]);
  const size = (await stat(dumpPath)).size;
  console.log(`  ✓ db.dump (${formatBytes(size)})`);
} catch (err) {
  console.error('pg_dump failed:', err.message);
  process.exit(1);
}

// Attachments archive — only if the directory exists and has content.
const attachmentsArchive = join(baseDir, 'attachments.tgz');
try {
  const s = await stat(attachmentsDir).catch(() => null);
  if (!s || !s.isDirectory()) {
    console.log('  (no attachments directory — skipping attachments archive)');
  } else {
    console.log('  tar attachments …');
    // -C parent then archive the basename so the archive entries are
    // relative paths (`attachments/YYYY/MM/...`).
    const parent = dirname(attachmentsDir);
    const base = attachmentsDir.slice(parent.length + 1);
    await exec('tar', ['-czf', attachmentsArchive, '-C', parent, base]);
    const size = (await stat(attachmentsArchive)).size;
    console.log(`  ✓ attachments.tgz (${formatBytes(size)})`);
  }
} catch (err) {
  console.error('tar failed:', err.message);
  process.exit(1);
}

console.log('Done.');

function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}
