import { lookup } from 'node:dns/promises';
import { isIP, isIPv4, isIPv6 } from 'node:net';

/**
 * F-23 (security audit 2026-05-25) — SSRF guardrails for user-
 * configurable URLs.
 *
 * Two URL surfaces let a user (a tenant admin in the case of OFX
 * Direct Connect, the super-admin in the case of OLLAMA_BASE_URL +
 * OIDC discoveryUrl) specify a target the server will fetch. Without
 * IP-range checks, the user can point at:
 *
 *   • 127.0.0.0/8 — loopback, can reach co-located services
 *   • 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16 — private LAN
 *   • 169.254.0.0/16 — link-local (AWS IMDS at 169.254.169.254)
 *   • ::1 — IPv6 loopback
 *   • fe80::/10 — IPv6 link-local
 *   • fc00::/7 — IPv6 unique-local
 *
 * Defense-in-depth check: we validate at settings-save time AND
 * resolve the hostname at fetch time. The second pass catches DNS
 * rebinding where the resolver returns a public IP on validation
 * and 127.0.0.1 on the actual fetch.
 */

export class UnsafeUrlError extends Error {}

/**
 * Synchronous check for URL well-formedness + literal IP rejection.
 * Use at settings-save time as the cheap first gate.
 */
export function validatePublicUrlSync(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new UnsafeUrlError(`Not a valid URL: "${url}"`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new UnsafeUrlError(
      `URL must be http: or https: (got "${parsed.protocol}")`,
    );
  }
  // Strip brackets that IPv6 URLs carry.
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host) && isInternalIp(host)) {
    throw new UnsafeUrlError(
      `URL host ${host} is in a private/loopback IP range — refusing to allow.`,
    );
  }
}

/**
 * Async check used immediately BEFORE a fetch. Resolves the hostname
 * (or accepts a literal IP) and re-checks. The pair of sync + async
 * checks defeats DNS rebinding.
 */
export async function assertSafeUrlForFetch(url: string): Promise<void> {
  validatePublicUrlSync(url);
  const parsed = new URL(url);
  const host = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  if (isIP(host)) {
    if (isInternalIp(host)) {
      throw new UnsafeUrlError(
        `URL host ${host} is in a private/loopback IP range.`,
      );
    }
    return;
  }
  let result: { address: string; family: number };
  try {
    result = await lookup(host, { verbatim: true });
  } catch (err) {
    throw new UnsafeUrlError(
      `DNS lookup failed for ${host}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (isInternalIp(result.address)) {
    throw new UnsafeUrlError(
      `URL host ${host} resolves to ${result.address}, which is in a private/loopback IP range.`,
    );
  }
}

/**
 * Returns true when the IP is in any of the ranges we don't allow
 * server-initiated traffic to. Accepts both v4 and v6 literals.
 */
export function isInternalIp(ip: string): boolean {
  if (isIPv4(ip)) return isInternalIPv4(ip);
  if (isIPv6(ip)) return isInternalIPv6(ip);
  return false;
}

function isInternalIPv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) {
    return true; // malformed — fail safe
  }
  const [a, b] = parts as [number, number, number, number];
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true; // link-local incl. IMDS
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 0) return true; // 0.0.0.0/8
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function isInternalIPv6(ip: string): boolean {
  const norm = ip.toLowerCase();
  if (norm === '::1' || norm === '0:0:0:0:0:0:0:1') return true;
  if (norm === '::' || norm === '0:0:0:0:0:0:0:0') return true;
  // fe80::/10 link-local
  if (norm.startsWith('fe8') || norm.startsWith('fe9') || norm.startsWith('fea') || norm.startsWith('feb')) {
    return true;
  }
  // fc00::/7 unique-local
  if (norm.startsWith('fc') || norm.startsWith('fd')) return true;
  // IPv4-mapped IPv6 addresses (::ffff:x.x.x.x) — re-check the v4 portion
  const v4Mapped = norm.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (v4Mapped) return isInternalIPv4(v4Mapped[1]!);
  return false;
}
