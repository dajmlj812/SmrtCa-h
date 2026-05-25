import { createHash, randomBytes } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type {
  AuthProvider,
  BeginResult,
  ProviderDescriptor,
  ProviderIdentity,
} from './types.js';

/**
 * F-20 (security audit 2026-05-25) — JWKS cache for ID-token
 * signature verification. createRemoteJWKSet returns a function that
 * fetches + caches the key set, including handling kid rotation and
 * retrying on misses.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  let jwks = jwksCache.get(jwksUri);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(jwksUri));
    jwksCache.set(jwksUri, jwks);
  }
  return jwks;
}

/**
 * Generic OIDC provider (Authorization Code + PKCE).
 *
 * Works with any spec-compliant IdP that exposes a discovery document
 * at `<issuer>/.well-known/openid-configuration`. The same code path
 * backs the Google / Microsoft / GitHub-flavored presets by passing
 * their discovery URLs at construction time.
 *
 * Flow:
 *   begin()           — fetches discovery (cached), generates PKCE
 *                       verifier + state nonce, returns the authorize
 *                       URL + the state the route layer must store in
 *                       a short-lived signed cookie.
 *   completeRedirect()— exchanges the code at the token endpoint,
 *                       verifies the ID token's `iss` + `aud` claims,
 *                       and (for issuers that don't put email in the
 *                       ID token like older GitHub OIDC) fetches
 *                       userinfo for the email.
 *
 * Security notes:
 *   - PKCE prevents authorization-code interception.
 *   - `state` is the random anti-CSRF token plus the PKCE verifier
 *     plus the optional returnTo URL — packed into JSON, signed by
 *     the cookie layer at the route boundary. We don't sign here.
 *   - We do NOT verify the ID-token signature in this implementation.
 *     The token comes back over a direct TLS POST to the IdP, which
 *     authenticates the issuer transport-wise. A defense-in-depth pass
 *     that verifies the signature against JWKS is queued.
 */

interface OidcConfig {
  /** Slug under which this provider is exposed at /api/auth/oidc/:slug. */
  slug: string;
  displayName: string;
  /** Discovery URL — usually `<issuer>/.well-known/openid-configuration`. */
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  /** Absolute callback URL registered with the IdP. */
  redirectUri: string;
  /** Whitespace-separated scopes; defaults to 'openid email profile'. */
  scopes?: string;
  /**
   * GitHub's OIDC endpoint omits email from the ID token; setting this
   * makes us fetch userinfo after the code exchange to pick it up.
   */
  fetchUserInfo?: boolean;
}

interface DiscoveryDoc {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}

interface DecodedIdToken {
  iss: string;
  aud: string | string[];
  sub: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
}

const DISCOVERY_CACHE_MS = 60 * 60 * 1000;
const discoveryCache = new Map<string, { doc: DiscoveryDoc; at: number }>();

export class OidcAuthProvider implements AuthProvider {
  constructor(private readonly cfg: OidcConfig) {}

  descriptor(): ProviderDescriptor {
    return {
      id: `oidc:${this.cfg.slug}`,
      kind: 'oidc',
      displayName: this.cfg.displayName,
      enabled: true,
    };
  }

  async begin(opts: { returnTo?: string }): Promise<BeginResult> {
    const doc = await this.discovery();
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256')
      .update(verifier)
      .digest('base64url');
    const nonce = randomBytes(16).toString('base64url');
    const stateToken = randomBytes(16).toString('base64url');

    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set('client_id', this.cfg.clientId);
    url.searchParams.set('redirect_uri', this.cfg.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set(
      'scope',
      this.cfg.scopes ?? 'openid email profile',
    );
    url.searchParams.set('state', stateToken);
    url.searchParams.set('nonce', nonce);
    url.searchParams.set('code_challenge', challenge);
    url.searchParams.set('code_challenge_method', 'S256');

    return {
      kind: 'redirect',
      url: url.toString(),
      state: {
        slug: this.cfg.slug,
        verifier,
        nonce,
        stateToken,
        returnTo: opts.returnTo ?? '/',
      },
    };
  }

  async completeRedirect(
    query: Record<string, string>,
    state: Record<string, string>,
  ): Promise<ProviderIdentity> {
    const code = query.code;
    if (!code) {
      throw new Error('Missing authorization code in callback');
    }
    if (query.state !== state.stateToken) {
      throw new Error('OIDC state mismatch (possible CSRF)');
    }
    const doc = await this.discovery();

    // Exchange code for tokens at the token endpoint.
    const tokenRes = await fetch(doc.token_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: this.cfg.redirectUri,
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code_verifier: state.verifier!,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const text = await tokenRes.text().catch(() => '');
      throw new Error(
        `OIDC token exchange failed (${tokenRes.status}): ${text.slice(0, 200)}`,
      );
    }
    const tokens = (await tokenRes.json()) as {
      access_token?: string;
      id_token?: string;
      token_type?: string;
    };
    if (!tokens.id_token) {
      throw new Error('OIDC token response had no id_token');
    }

    // F-20 — verify the id_token's JWS signature against the
    // provider's JWKS before trusting any claim in it. Previously we
    // only decoded the payload and trusted the iss/aud/exp claims; a
    // forged token signed by anyone would have passed. jose handles
    // kid rotation, retries on miss, and rejects expired/not-before
    // tokens in one call.
    if (!doc.jwks_uri) {
      throw new Error(
        'OIDC provider discovery document has no jwks_uri — cannot verify id_token signature',
      );
    }
    let claims: DecodedIdToken;
    try {
      const result = await jwtVerify(tokens.id_token, getJwks(doc.jwks_uri), {
        issuer: doc.issuer,
        audience: this.cfg.clientId,
        clockTolerance: 30,
      });
      claims = result.payload as unknown as DecodedIdToken;
    } catch (err) {
      throw new Error(
        `OIDC id_token signature verification failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    if (claims.nonce && claims.nonce !== state.nonce) {
      throw new Error('OIDC nonce mismatch');
    }

    let email = claims.email;
    let name = claims.name ?? claims.preferred_username;
    // F-20 — record whether the provider asserts the email is
    // verified. resolveIdentity refuses to auto-LINK to an existing
    // local user when this is false, so an attacker who controls a
    // misconfigured IdP can't claim victim@example.com.
    let emailVerified = claims.email_verified === true;

    // Some providers (GitHub) don't include email in the ID token.
    if ((!email || this.cfg.fetchUserInfo) && doc.userinfo_endpoint && tokens.access_token) {
      try {
        const uiRes = await fetch(doc.userinfo_endpoint, {
          headers: { Authorization: `Bearer ${tokens.access_token}` },
        });
        if (uiRes.ok) {
          const info = (await uiRes.json()) as {
            email?: string;
            email_verified?: boolean;
            name?: string;
            preferred_username?: string;
          };
          if (!email && info.email) email = info.email;
          // If the ID token didn't carry email_verified but userinfo
          // does, trust userinfo. Otherwise keep whatever the ID
          // token said (defaults to false).
          if (!emailVerified && info.email_verified === true) {
            emailVerified = true;
          }
          name = name ?? info.name ?? info.preferred_username;
        }
      } catch {
        /* userinfo lookup is best-effort */
      }
    }

    return {
      provider: `oidc:${this.cfg.slug}`,
      providerUserId: claims.sub,
      email,
      displayName: name,
      emailVerified,
    };
  }

  private async discovery(): Promise<DiscoveryDoc> {
    const cached = discoveryCache.get(this.cfg.discoveryUrl);
    if (cached && Date.now() - cached.at < DISCOVERY_CACHE_MS) {
      return cached.doc;
    }
    const res = await fetch(this.cfg.discoveryUrl);
    if (!res.ok) {
      throw new Error(
        `OIDC discovery fetch failed (${res.status}): ${this.cfg.discoveryUrl}`,
      );
    }
    const doc = (await res.json()) as DiscoveryDoc;
    discoveryCache.set(this.cfg.discoveryUrl, { doc, at: Date.now() });
    return doc;
  }
}

function decodeIdTokenPayload(token: string): DecodedIdToken {
  const parts = token.split('.');
  if (parts.length < 2) {
    throw new Error('Malformed id_token');
  }
  // Base64url decode the second segment (the payload).
  const payload = Buffer.from(parts[1]!, 'base64url').toString('utf8');
  return JSON.parse(payload) as DecodedIdToken;
}

/**
 * Preset configurations for the well-known consumer/dev providers.
 * Anywhere we'd otherwise duplicate discovery URLs, we resolve them
 * once here. Each preset still needs `clientId`/`clientSecret`/
 * `redirectUri` from the user's `auth_provider_configs` row.
 */
export interface PresetSpec {
  slug: string;
  displayName: string;
  discoveryUrl: string;
  scopes?: string;
  fetchUserInfo?: boolean;
}

export const PRESET_OIDC: Record<string, PresetSpec> = {
  google: {
    slug: 'google',
    displayName: 'Google',
    discoveryUrl: 'https://accounts.google.com/.well-known/openid-configuration',
    scopes: 'openid email profile',
  },
  microsoft: {
    slug: 'microsoft',
    displayName: 'Microsoft',
    // 'common' lets both personal + work accounts authenticate; a
    // tenant-locked deployment can override the discovery URL via the
    // Generic OIDC form to point at a tenant-specific issuer.
    discoveryUrl:
      'https://login.microsoftonline.com/common/v2.0/.well-known/openid-configuration',
    scopes: 'openid email profile',
  },
  github: {
    slug: 'github',
    displayName: 'GitHub',
    // GitHub publishes OIDC for Actions only; for end-user login the
    // OAuth2 endpoints are at github.com and don't ship a discovery
    // doc. We synthesize one to keep the same code path.
    discoveryUrl: 'https://github.com/.well-known/openid-configuration',
    scopes: 'read:user user:email',
    fetchUserInfo: true,
  },
};

export function makeOidcProvider(cfg: OidcConfig): OidcAuthProvider {
  return new OidcAuthProvider(cfg);
}
