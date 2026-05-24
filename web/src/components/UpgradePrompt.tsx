import { Link } from 'react-router-dom';

/**
 * 0.15.3 — reusable "this is a premium feature" card.
 *
 * Used on pages whose primary feature is gated, replacing the page
 * body when the server returns 402 for the underlying call. Example
 * (in a hypothetical AnomaliesPage):
 *
 *   if (status === 402) return <UpgradePrompt feature="Anomaly alerts" requiredPlan="plus" />;
 *
 * The card doesn't try to be the upgrade flow itself — it points at
 * /billing where the full plan-comparison + Checkout UX lives.
 */
export function UpgradePrompt({
  feature,
  requiredPlan,
  message,
}: {
  /** Display name of the gated feature, e.g. "Anomaly alerts". */
  feature: string;
  /** Plan tier the user needs to be on. */
  requiredPlan: 'plus' | 'family';
  /** Optional override of the default body copy. */
  message?: string;
}) {
  const planLabel = requiredPlan === 'family' ? 'Family' : 'Plus';
  return (
    <div className="card upgrade-prompt">
      <div className="upgrade-prompt-body">
        <h2>{feature} is part of {planLabel}</h2>
        <p>
          {message ??
            `Upgrade to ${planLabel} to unlock ${feature.toLowerCase()} and the rest of the ${planLabel} feature set. 14-day free trial, no card required upfront.`}
        </p>
        <div className="actions">
          <Link to="/billing" className="btn">
            See plans
          </Link>
        </div>
      </div>
    </div>
  );
}
