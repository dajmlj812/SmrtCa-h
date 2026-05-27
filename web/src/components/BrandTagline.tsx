/**
 * 0.18.2 — single source of truth for the version + vendor
 * line shown in the sidebar footer + on every auth page.
 *
 * `__APP_VERSION__` is injected by Vite from web/package.json
 * at build time, so the displayed version can't go stale the
 * way the hard-coded "v0.17.25" string did.
 *
 * Compact variant: one line. Default: two lines (version on
 * top, vendor below).
 */
export function BrandTagline({
  variant = 'stacked',
}: {
  variant?: 'stacked' | 'inline';
}) {
  if (variant === 'inline') {
    return (
      <span className="brand-tagline muted">
        SmrtCash · v{__APP_VERSION__} · © BuildITSmrt, LLC.
      </span>
    );
  }
  return (
    <div className="brand-tagline">
      <div>SmrtCash · v{__APP_VERSION__}</div>
      <div>
        by{' '}
        <a
          href="https://builditsmrt.com"
          target="_blank"
          rel="noopener noreferrer"
        >
          BuildITSmrt, LLC.
        </a>
      </div>
    </div>
  );
}
