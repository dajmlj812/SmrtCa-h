/**
 * Swaps the favicon to a green/red tint when the app is running on
 * local or test, so we can tell at a glance which environment a tab
 * is pointing at. Prod (and anything we don't recognise) keeps the
 * default purple icon.
 *
 * Detection is hostname-based — no env var or build flag — so the
 * same compiled bundle deploys to all three environments and each
 * tints itself correctly at runtime.
 */

type Env = 'local' | 'test' | 'prod';

const ENV_COLOR: Record<Exclude<Env, 'prod'>, string> = {
  local: '#16a34a',
  test: '#dc2626',
};

function detectEnv(hostname: string): Env {
  const h = hostname.toLowerCase();
  if (
    h === 'localhost' ||
    h === '127.0.0.1' ||
    h === '0.0.0.0' ||
    h.endsWith('.local') ||
    h.endsWith('.localhost')
  ) {
    return 'local';
  }
  if (h === 'smrtcash-test.builditsmrt.com') return 'test';
  return 'prod';
}

function buildIcon(color: string): string {
  // Mirrors web/public/icons/icon-192.svg, with only the rect fill swapped.
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192">' +
    `<rect width="192" height="192" rx="32" fill="${color}"/>` +
    '<text x="96" y="118" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="96" font-weight="700" fill="#ffffff" text-anchor="middle">$</text>' +
    '<text x="96" y="156" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" font-weight="600" fill="#ffffff" text-anchor="middle" letter-spacing="2">SMRT</text>' +
    '</svg>';
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function applyEnvFavicon(): void {
  const env = detectEnv(window.location.hostname);
  if (env === 'prod') return;
  const url = buildIcon(ENV_COLOR[env]);
  document
    .querySelectorAll<HTMLLinkElement>(
      'link[rel="icon"], link[rel="apple-touch-icon"]',
    )
    .forEach((link) => {
      link.href = url;
    });
}
