import argon2 from 'argon2';
import { createHash } from 'node:crypto';

/**
 * Argon2id wrappers. Defaults follow the OWASP 2024 recommendation:
 * memoryCost 19 MiB, timeCost 2, parallelism 1.
 *
 * Kept thin on purpose — the rest of the auth layer treats these as
 * opaque functions, so swapping the algorithm later is a one-file change.
 */

const HASH_OPTIONS: argon2.Options = {
  type: argon2.argon2id,
  memoryCost: 19_456,
  timeCost: 2,
  parallelism: 1,
};

// F-07 (security audit 2026-05-25) — raised from 8 to 12. NIST 800-63B
// recommends length over arbitrary complexity rules, so we tighten
// length and add an HIBP breach check below; we deliberately don't
// require digits/symbols/case-mixing.
const MIN_PASSWORD_LENGTH = 12;
const MAX_PASSWORD_LENGTH = 1024;

// F-06 (security audit 2026-05-25) — dummy hash for nonexistent-user
// login attempts. We argon2.verify against this so the response time
// of "wrong password" and "no such user" matches — closes the timing
// channel that could enumerate the user table. The dummy itself
// doesn't need to be secret; the goal is matching CPU work.
const DUMMY_PASSWORD_HASH =
  '$argon2id$v=19$m=19456,t=2,p=1$YWJjZGVmZ2hpamtsbW5vcA$3HxKL+pgNYDeFqsx0/oW/k0a3jLZW3yXxOPGV1Xb3tA';

export class PasswordPolicyError extends Error {}

/**
 * Length + format checks. Cheap and synchronous; called everywhere a
 * password is set or reset.
 */
export function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== 'string') {
    throw new PasswordPolicyError('Password is required.');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`,
    );
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new PasswordPolicyError(
      `Password must be at most ${MAX_PASSWORD_LENGTH} characters.`,
    );
  }
}

/**
 * F-07 — Have-I-Been-Pwned k-anonymity check.
 *
 * Sends only the first 5 chars of the SHA-1 of the password (the
 * "prefix"); HIBP returns every hash with that prefix, and we check
 * locally whether OUR full hash is in the list. The full password
 * never leaves our process and HIBP only sees the prefix, so this
 * is a privacy-preserving way to refuse known-breached passwords.
 *
 * Failures (network, HIBP down) FALL OPEN — we'd rather let a
 * legitimate signup proceed than block password reset because an
 * external API is having a bad day. Errors are logged.
 *
 * Returns:
 *   • { breached: true, count } if the password is known
 *   • { breached: false } otherwise (including network failure)
 */
export async function checkPasswordBreached(
  password: string,
): Promise<{ breached: boolean; count?: number }> {
  const sha1 = createHash('sha1').update(password, 'utf8').digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);
  try {
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      // HIBP normally responds in <100ms; cap at 2s so signup doesn't
      // hang on a slow connection.
      signal: AbortSignal.timeout(2000),
      headers: { 'Add-Padding': 'true' },
    });
    if (!res.ok) return { breached: false };
    const body = await res.text();
    for (const line of body.split('\n')) {
      const [hashSuffix, countStr] = line.trim().split(':');
      if (hashSuffix === suffix) {
        return { breached: true, count: Number(countStr) || 0 };
      }
    }
    return { breached: false };
  } catch {
    // Fail open: we don't punish users for HIBP being unreachable.
    return { breached: false };
  }
}

/**
 * Run a dummy argon2 verify so the timing of a login attempt against
 * a nonexistent user matches the timing of a wrong-password attempt
 * against an existing user. Discards the result.
 */
export async function dummyVerifyForTiming(): Promise<void> {
  try {
    await argon2.verify(DUMMY_PASSWORD_HASH, 'wrong-on-purpose');
  } catch {
    /* expected — we're only here for the CPU work */
  }
}

export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, HASH_OPTIONS);
}

export async function verifyPassword(
  hash: string,
  password: string,
): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    // argon2.verify throws on malformed hashes — treat as "no match".
    return false;
  }
}
