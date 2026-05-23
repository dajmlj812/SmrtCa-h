import { query } from '../../db/pool.js';
import { verifyPassword } from '../passwords.js';
import type {
  AuthProvider,
  BeginResult,
  ProviderDescriptor,
  ProviderIdentity,
} from './types.js';

/**
 * Local password provider. Wraps the existing argon2id flow so the
 * rest of the auth pipeline (identity creation, session minting) can
 * treat it identically to OIDC/SAML.
 *
 * `verify({ email, password })` looks up the user by email
 * (case-insensitive) and returns the identity on success. The
 * `provider_user_id` for local identities is the user's UUID — there's
 * no external id to bind against.
 */

export class LocalAuthProvider implements AuthProvider {
  descriptor(): ProviderDescriptor {
    return {
      id: 'local',
      kind: 'local',
      displayName: 'Email + password',
      // Local is always available — it's the bootstrap path.
      enabled: true,
    };
  }

  async begin(): Promise<BeginResult> {
    return { kind: 'credential' };
  }

  async verify(payload: Record<string, unknown>): Promise<ProviderIdentity> {
    const email = typeof payload.email === 'string' ? payload.email.trim() : '';
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (email === '' || password === '') {
      throw new Error('Email and password are required');
    }
    const r = await query<{
      id: string;
      password_hash: string;
      email: string | null;
      name: string | null;
    }>(
      `SELECT id, password_hash, email, name
         FROM users
        WHERE lower(email) = lower($1)
        LIMIT 1`,
      [email],
    );
    if (r.rowCount === 0) {
      throw new Error('Invalid email or password');
    }
    const user = r.rows[0]!;
    if (!(await verifyPassword(user.password_hash, password))) {
      throw new Error('Invalid email or password');
    }
    return {
      provider: 'local',
      providerUserId: user.id,
      email: user.email ?? email,
      displayName: user.name ?? undefined,
    };
  }
}

export const localProvider = new LocalAuthProvider();
