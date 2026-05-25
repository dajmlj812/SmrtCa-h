#!/usr/bin/env node
// SmrtCash — KEK (key-encryption-key) rotation.
//
// Rewraps every per-tenant DEK and re-encrypts every KEK-encrypted
// column (Plaid tokens, OFX-DC credentials) under a fresh KEK, then
// updates the .env file with the new key.
//
// The runtime container still has the OLD KEK loaded into process.env
// from boot; restart the container after this script reports success
// to pick up the new key.
//
// Usage:
//   node scripts/rotate-kek.mjs               # generate fresh KEK
//   node scripts/rotate-kek.mjs --new-kek <base64>   # use a specific KEK
//   node scripts/rotate-kek.mjs --dry-run     # rewrap but don't update .env
//   node scripts/rotate-kek.mjs --yes         # skip the confirmation prompt
//
// Pre-flight: take a backup (scripts/backup.mjs) before running. This
// script is transactional at the DB layer but a mid-process crash
// between the DB commit and the .env write leaves you with a
// recovered-state-needs-manual-intervention scenario. The backup gives
// you a return path.

import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { config as loadEnv } from 'dotenv';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const envPath = join(repoRoot, '.env');
loadEnv({ path: envPath });

// We import the compiled JS — the server must be built first (npm run
// build inside server/). This matches what scripts/backup.mjs does for
// its db imports.
const { rotateKek, decodeKekString, generateNewKek, KekRotationError } =
  await import(
    join(repoRoot, 'server', 'dist', 'attachments', 'kek-rotation.js')
  ).catch((err) => {
    console.error('Failed to import compiled rotation module:', err.message);
    console.error('Run `npm run build --prefix server` first.');
    process.exit(1);
  });

function parseArgs(argv) {
  const args = { newKekArg: null, dryRun: false, autoYes: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--new-kek') {
      args.newKekArg = argv[++i];
    } else if (a === '--dry-run') {
      args.dryRun = true;
    } else if (a === '--yes' || a === '-y') {
      args.autoYes = true;
    } else if (a === '--help' || a === '-h') {
      console.log(
        'Usage: node scripts/rotate-kek.mjs [--new-kek <base64>] [--dry-run] [--yes]\n\n' +
          'Rotates the ATTACHMENT_ENCRYPTION_KEY (KEK).\n' +
          '\n' +
          'Default: generates a fresh 32-byte KEK, rewraps every tenant DEK,\n' +
          'and re-encrypts Plaid + OFX-DC credentials in one DB transaction,\n' +
          'then updates .env with the new key.\n' +
          '\n' +
          '--new-kek <base64>   use this specific KEK instead of generating one\n' +
          '--dry-run            do the rewrap but skip the .env update\n' +
          '--yes                skip the interactive confirmation\n' +
          '\n' +
          'After the script reports success, restart the container.',
      );
      process.exit(0);
    } else {
      console.error(`Unknown argument: ${a}`);
      process.exit(2);
    }
  }
  return args;
}

const args = parseArgs(process.argv);

const oldKekString = process.env.ATTACHMENT_ENCRYPTION_KEY;
if (!oldKekString || oldKekString === '') {
  console.error(
    'ATTACHMENT_ENCRYPTION_KEY is not set in .env. Nothing to rotate from.',
  );
  process.exit(1);
}

let oldKek;
try {
  oldKek = decodeKekString(oldKekString);
} catch (err) {
  console.error(`The current KEK in .env is malformed: ${err.message}`);
  process.exit(1);
}

let newKek;
let newKekBase64;
if (args.newKekArg) {
  try {
    newKek = decodeKekString(args.newKekArg);
  } catch (err) {
    console.error(`--new-kek is malformed: ${err.message}`);
    process.exit(1);
  }
  newKekBase64 = newKek.toString('base64');
} else {
  const gen = generateNewKek();
  newKek = gen.key;
  newKekBase64 = gen.base64;
}

if (oldKek.equals(newKek)) {
  console.error('New KEK is identical to the current KEK. Refusing.');
  process.exit(1);
}

// Confirm.
console.log('KEK rotation — about to:');
console.log('  1. Rewrap every tenant_encryption_keys row under the new KEK');
console.log('  2. Re-encrypt every plaid_items.access_token_encrypted');
console.log('  3. Re-encrypt every ofx_dc_connections credential pair');
console.log('  4. Write the new KEK into .env (with .env.bak.<timestamp>)');
console.log('');
console.log('You will then need to restart the application container.');
console.log('');
console.log('Strongly recommended: run scripts/backup.mjs first.');
console.log('');

if (!args.autoYes && !args.dryRun) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('Type "ROTATE" to proceed: ');
  rl.close();
  if (answer.trim() !== 'ROTATE') {
    console.error('Aborted.');
    process.exit(1);
  }
}

console.log('');
console.log('Running rotation against the database…');
let result;
try {
  result = await rotateKek(oldKek, newKek);
} catch (err) {
  if (err instanceof KekRotationError) {
    console.error('Rotation failed:', err.message);
  } else {
    console.error('Rotation failed:', err);
  }
  console.error('The transaction was rolled back. The old KEK is still in effect.');
  process.exit(1);
}

console.log('');
console.log('  ✓ wrapped_dek rows rewrapped:    ', result.dekRowsRewrapped);
console.log('  ✓ Plaid access tokens rewrapped: ', result.plaidTokensReencrypted);
console.log('  ✓ OFX-DC credentials rewrapped:  ', result.ofxCredsReencrypted);
console.log('');

if (args.dryRun) {
  console.log('--dry-run: skipping .env update.');
  console.log('The DB transaction COMMITTED — your data is now under the new KEK:');
  console.log('');
  console.log(`  ATTACHMENT_ENCRYPTION_KEY=${newKekBase64}`);
  console.log('');
  console.log('Put that line in .env manually, then restart the container.');
  process.exit(0);
}

// Atomic .env update: write to .env.new, rename old to backup, rename
// new to .env. If anything throws between commit-to-disk and rename,
// the operator has the new key in the script output AND .env.new still
// on disk to recover from.
const envContent = await readFile(envPath, 'utf-8');
const updated = updateEnvLine(envContent, 'ATTACHMENT_ENCRYPTION_KEY', newKekBase64);
const ts = new Date()
  .toISOString()
  .replace(/[:.]/g, '-')
  .replace(/T/, '_')
  .slice(0, 19);
const backupPath = `${envPath}.bak.${ts}`;
const stagingPath = `${envPath}.new`;

await writeFile(stagingPath, updated, { encoding: 'utf-8', mode: 0o600 });
await rename(envPath, backupPath);
await rename(stagingPath, envPath);

console.log(`.env updated. Previous .env backed up to ${backupPath}`);
console.log('');
console.log('NEXT STEP — restart the container so the new KEK is loaded:');
console.log('  docker compose up -d --force-recreate app');
console.log('');
console.log('After the restart, verify with:');
console.log('  curl https://your-host/api/health');
console.log('');
console.log('Done.');

function updateEnvLine(content, key, value) {
  const re = new RegExp(`^${key}=.*$`, 'm');
  if (re.test(content)) {
    return content.replace(re, `${key}=${value}`);
  }
  // Key not present — append. Add a trailing newline if the file
  // doesn't end with one.
  const sep = content.length === 0 || content.endsWith('\n') ? '' : '\n';
  return `${content}${sep}${key}=${value}\n`;
}
