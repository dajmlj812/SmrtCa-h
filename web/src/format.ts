/** Format integer cents as a localized USD currency string. */
export function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—';
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
  });
}

/** Format an ISO 'YYYY-MM-DD' date as 'MM/DD/YYYY' without timezone drift. */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  if (!y || !m || !d) return iso;
  return `${m}/${d}/${y}`;
}

/**
 * 0.18.3 — module-level "current user timezone" set by App.tsx
 * on auth (from the /api/auth/me response). All datetime formatters
 * below read it via getUserTimezone(). NULL falls back to the
 * browser-detected zone, which is the prior behavior.
 */
let userTimezone: string | null = null;

export function setUserTimezone(tz: string | null): void {
  userTimezone = tz && tz.trim() !== '' ? tz : null;
}

export function getUserTimezone(): string {
  if (userTimezone !== null) return userTimezone;
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/**
 * Format a full ISO timestamp ('2026-05-24T15:30:00Z' or similar)
 * in the user's preferred timezone, e.g. "May 24, 2026, 11:30 AM".
 * Use this for created_at / last_login_at / audit-log times — any
 * datetime where the time-of-day matters.
 */
export function formatDateTime(
  iso: string | null | undefined,
  opts: Intl.DateTimeFormatOptions = {},
): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString('en-US', {
    timeZone: getUserTimezone(),
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...opts,
  });
}

/** Short relative form: "3m ago", "2h ago", "5d ago", or absolute date if older. */
export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const diffMs = Date.now() - d.getTime();
  const diffMin = Math.round(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffH = Math.round(diffMin / 60);
  if (diffH < 24) return `${diffH}h ago`;
  const diffD = Math.round(diffH / 24);
  if (diffD < 7) return `${diffD}d ago`;
  return formatDateTime(iso, { hour: undefined, minute: undefined });
}

/** Human label for an account type code. */
export function accountTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    checking: 'Checking',
    savings: 'Savings',
    credit_card: 'Credit Card',
    cash: 'Cash',
    investment: 'Investment',
    loan: 'Loan',
    other: 'Other',
    manual_asset: 'Asset',
    manual_liability: 'Liability',
  };
  return labels[type] ?? type;
}
