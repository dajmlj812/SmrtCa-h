/**
 * Auth-provider abstraction.
 *
 * Every login method (local password, OIDC, SAML) implements this same
 * interface. The login flow is two-step:
 *
 *   1. `begin(reqInfo)` — for redirect-based providers (OIDC, SAML) the
 *      result is { kind: 'redirect', url, state }; the route layer
 *      stashes `state` (PKCE verifier + nonce + return-to) and 302s.
 *      For password-style providers the result is { kind: 'verify' }
 *      and the user posts credentials directly.
 *
 *   2. `complete(reqInfo, state)` — the callback handler (or the
 *      password POST handler) runs the provider's verification and
 *      returns either a resolved Identity { provider, providerUserId,
 *      email, displayName } or an error.
 *
 * The route layer then either finds an existing `user_identities` row
 * (returning user) or creates a new user + identity (first-time login
 * via this provider for this email).
 */

export type ProviderKind = 'local' | 'oidc' | 'saml';

export interface ProviderDescriptor {
  /** Unique key, e.g. 'local', 'oidc:google', 'oidc:<slug>'. */
  id: string;
  /** Storage kind. */
  kind: ProviderKind;
  /** Label shown on the login page button. */
  displayName: string;
  /** When false, hidden from the login page. */
  enabled: boolean;
}

export interface ProviderIdentity {
  provider: string;
  providerUserId: string;
  email?: string;
  displayName?: string;
}

export interface BeginRedirect {
  kind: 'redirect';
  /** Absolute URL the user agent should be sent to. */
  url: string;
  /**
   * Per-attempt state the route layer must persist (e.g. in a short-
   * lived signed cookie) so it can be replayed into `complete`.
   * Typically contains PKCE verifier + nonce + state token.
   */
  state: Record<string, string>;
}

export interface BeginCredential {
  kind: 'credential';
}

export type BeginResult = BeginRedirect | BeginCredential;

export interface AuthProvider {
  descriptor(): ProviderDescriptor;
  /**
   * Start a login attempt. For redirect-based providers this builds
   * the authorize URL with state + PKCE. For credential providers this
   * is a no-op (the route layer handles the POST directly).
   */
  begin(opts: { returnTo?: string }): Promise<BeginResult>;
  /**
   * For credential providers (local), verify the submitted credentials
   * and return the identity. The `payload` shape is provider-specific.
   * For redirect providers this is unused (use completeRedirect).
   */
  verify?(payload: Record<string, unknown>): Promise<ProviderIdentity>;
  /**
   * For redirect providers, handle the callback. `query` is the query
   * string from the callback URL; `state` is what `begin` returned.
   */
  completeRedirect?(
    query: Record<string, string>,
    state: Record<string, string>,
  ): Promise<ProviderIdentity>;
}
