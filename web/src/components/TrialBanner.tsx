import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type BillingStatus } from '../api.js';

/**
 * 0.15.3 — sitewide trial-end countdown.
 *
 * Renders a single info bar above the main content when the tenant is
 * on a trial AND the trial ends within 5 days. Hidden otherwise. Auto-
 * refreshes once on mount; lower-frequency than a poll because the
 * count is per-day, not per-minute.
 *
 * Deliberately not dismissible — the impending end of the trial is
 * load-bearing information at this point.
 */
export function TrialBanner() {
  const [status, setStatus] = useState<BillingStatus | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await api.getBillingStatus();
        if (alive) setStatus(s);
      } catch {
        // Banner is a best-effort affordance — silent failure is fine.
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  if (!status || status.status !== 'trialing' || !status.trialEnd) return null;
  const days = Math.ceil((new Date(status.trialEnd).getTime() - Date.now()) / 86400_000);
  if (days > 5 || days < 0) return null;

  return (
    <div className="trial-banner" role="status" aria-live="polite">
      <span>
        <strong>Trial ends in {days} day{days === 1 ? '' : 's'}.</strong>{' '}
        Pick a plan to keep your features without interruption.
      </span>
      <Link to="/billing" className="btn small">
        Manage billing
      </Link>
    </div>
  );
}
