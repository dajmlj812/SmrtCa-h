import { pool } from '../../db/pool.js';
import { localProvider } from './local.js';
import {
  PRESET_OIDC,
  makeOidcProvider,
  type PresetSpec,
} from './oidc.js';
import { makeSamlProvider, type SamlConfig } from './saml.js';
import type { AuthProvider, ProviderDescriptor } from './types.js';

/**
 * Resolves the set of currently-configured AuthProvider instances by
 * joining the static Local provider with whatever rows exist in
 * `auth_provider_configs`. The result is cached for a few seconds so
 * the login-page render and the begin-callback path don't both pay the
 * full DB hit; settings mutations should call `clearProviderCache()`.
 */

interface OidcConfigRow {
  client_id?: string;
  client_secret?: string;
  redirect_uri?: string;
  // Generic OIDC (non-preset) configs supply their own discovery URL.
  discovery_url?: string;
  display_name?: string;
  scopes?: string;
}

interface SamlConfigRow {
  display_name?: string;
  idp_metadata_url?: string;
  sp_entity_id?: string;
  assertion_consumer_service_url?: string;
}

const CACHE_MS = 5_000;
let cachedAt = 0;
let cachedById = new Map<string, AuthProvider>();

export function clearProviderCache(): void {
  cachedAt = 0;
}

async function rebuildCache(): Promise<void> {
  const map = new Map<string, AuthProvider>();
  // Local is always present.
  map.set(localProvider.descriptor().id, localProvider);

  const rows = await pool.query<{
    id: string;
    kind: 'oidc' | 'saml';
    slug: string;
    display_name: string;
    enabled: boolean;
    config_json: unknown;
  }>(
    `SELECT id, kind, slug, display_name, enabled, config_json
       FROM auth_provider_configs
      WHERE enabled = true`,
  );
  for (const row of rows.rows) {
    const cfg = (row.config_json ?? {}) as OidcConfigRow & SamlConfigRow;
    if (row.kind === 'oidc') {
      const clientId = cfg.client_id ?? '';
      const clientSecret = cfg.client_secret ?? '';
      const redirectUri = cfg.redirect_uri ?? '';
      if (clientId === '' || clientSecret === '' || redirectUri === '') {
        // Skip half-configured providers — they'd 500 in begin().
        continue;
      }
      // Either a preset (slug matches a PRESET_OIDC key) or generic
      // (slug is custom, discovery_url required).
      const preset: PresetSpec | undefined = PRESET_OIDC[row.slug];
      const discoveryUrl = preset?.discoveryUrl ?? cfg.discovery_url;
      if (!discoveryUrl) continue;
      const provider = makeOidcProvider({
        slug: row.slug,
        displayName: row.display_name || preset?.displayName || row.slug,
        discoveryUrl,
        clientId,
        clientSecret,
        redirectUri,
        scopes: cfg.scopes ?? preset?.scopes,
        fetchUserInfo: preset?.fetchUserInfo,
      });
      map.set(provider.descriptor().id, provider);
    } else if (row.kind === 'saml') {
      const provider = makeSamlProvider({
        slug: row.slug,
        displayName: row.display_name,
        idpMetadataUrl: cfg.idp_metadata_url,
        spEntityId: cfg.sp_entity_id,
        assertionConsumerServiceUrl: cfg.assertion_consumer_service_url,
      } as SamlConfig);
      map.set(provider.descriptor().id, provider);
    }
  }

  cachedById = map;
  cachedAt = Date.now();
}

async function ensureFresh(): Promise<void> {
  if (Date.now() - cachedAt > CACHE_MS) await rebuildCache();
}

export async function listProviders(): Promise<ProviderDescriptor[]> {
  await ensureFresh();
  return Array.from(cachedById.values()).map((p) => p.descriptor());
}

export async function getProvider(id: string): Promise<AuthProvider | null> {
  await ensureFresh();
  return cachedById.get(id) ?? null;
}
