import type {
  AuthProvider,
  BeginResult,
  ProviderDescriptor,
} from './types.js';

/**
 * SAML 2.0 provider — stub.
 *
 * SAML is intentionally not implemented in this slice. A correct SP-
 * initiated flow requires:
 *
 *   - IdP metadata XML parsing + signing-cert extraction
 *   - AuthnRequest generation (with relay state, optionally signed)
 *   - SAMLResponse XML-signature verification — the dangerous bit, with
 *     a long history of signature-wrapping CVEs in hand-rolled
 *     implementations
 *   - Assertion + attribute extraction (NameID, email, displayName)
 *   - Clock-skew tolerant NotBefore / NotOnOrAfter validation
 *
 * The right way to ship this safely is on top of a vetted library
 * (e.g. `@node-saml/node-saml`) and a focused test suite that
 * exercises the signature-validation path against canned IdP fixtures.
 *
 * Until then, attempting to begin() this provider returns a clear
 * "not yet implemented" error. The provider registry surfaces it as
 * disabled on the login page so end users never hit this path.
 */

export interface SamlConfig {
  slug: string;
  displayName: string;
  /** URL of the IdP metadata document. */
  idpMetadataUrl?: string;
  /** SP entity id we'll send in AuthnRequest. */
  spEntityId?: string;
  /** Where the IdP should post the assertion. */
  assertionConsumerServiceUrl?: string;
}

export class SamlAuthProvider implements AuthProvider {
  constructor(private readonly cfg: SamlConfig) {}

  descriptor(): ProviderDescriptor {
    return {
      id: `saml:${this.cfg.slug}`,
      kind: 'saml',
      displayName: this.cfg.displayName,
      // Always disabled until the implementation lands.
      enabled: false,
    };
  }

  async begin(): Promise<BeginResult> {
    throw new Error(
      'SAML provider is not implemented yet — schema and abstraction are in place; full SP-initiated flow lands in a later slice.',
    );
  }
}

export function makeSamlProvider(cfg: SamlConfig): SamlAuthProvider {
  return new SamlAuthProvider(cfg);
}
