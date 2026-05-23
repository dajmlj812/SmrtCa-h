import argon2 from 'argon2';

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

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 1024;

export class PasswordPolicyError extends Error {}

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
