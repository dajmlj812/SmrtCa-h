/**
 * 0.18.1 — Built-in cancellation knowledge base.
 *
 * Maps a normalized merchant name to the public-facing cancel URL,
 * a canned email-cancellation body, and any caveats. The library is
 * intentionally a flat in-memory list (not a DB table) because:
 *
 *   - it's shared across every tenant — no per-tenant variation
 *   - it ships with the code so contributors can PR new entries
 *     without a migration
 *   - lookups are infrequent (only when the user opens the cancel
 *     modal) so a Map<string, entry> is plenty fast
 *
 * Matching strategy: normalize both sides to lowercase + strip
 * non-alphanumerics, then check whether either the input matches
 * an entry key OR the entry key is a substring of the input.
 * "Netflix.com" → "netflixcom" still matches `netflix`.
 *
 * Adding entries: prefer the official cancellation page, not the
 * marketing homepage. Email templates should be polite and explicit
 * ("please cancel my subscription effective immediately").
 */

export interface CancellationEntry {
  merchant: string;
  cancelUrl: string | null;
  emailTemplate: string | null;
  steps: string | null;
  notes: string | null;
}

const EMAIL_TEMPLATE_GENERIC = `Subject: Cancel my subscription

Hello,

Please cancel my subscription effective immediately. My account
details are:

  Account email: <YOUR EMAIL>
  Account name : <YOUR NAME>

Please confirm in writing once the cancellation is processed and
no further charges will be made.

Thank you.`;

const LIBRARY: CancellationEntry[] = [
  {
    merchant: 'netflix',
    cancelUrl: 'https://www.netflix.com/cancelplan',
    emailTemplate: null,
    steps:
      '1. Sign in at netflix.com\n2. Open Account → Membership & Billing\n3. Click "Cancel Membership"\n4. Confirm cancellation. Access continues until the end of the billing period.',
    notes:
      'Self-service web cancel. No retention call. Access stays active until period end.',
  },
  {
    merchant: 'spotify',
    cancelUrl: 'https://www.spotify.com/account/subscription/',
    emailTemplate: null,
    steps:
      '1. Sign in to spotify.com/account\n2. Subscription → "Available Plans"\n3. Scroll to Spotify Free → "Cancel Premium"\n4. Confirm. Access continues to the end of the billing period.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'hulu',
    cancelUrl: 'https://secure.hulu.com/account/cancel',
    emailTemplate: null,
    steps:
      '1. Sign in at hulu.com\n2. Account → "Cancel Your Subscription"\n3. Step through the retention offers\n4. Confirm cancellation.',
    notes: 'Self-service web cancel. Expect 2-3 retention upsells before the final confirm button.',
  },
  {
    merchant: 'disneyplus',
    cancelUrl: 'https://www.disneyplus.com/account/subscription',
    emailTemplate: null,
    steps:
      '1. Sign in at disneyplus.com\n2. Account → Subscription\n3. Click "Cancel Subscription"\n4. Confirm. Access continues until the next billing date.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'hbomax',
    cancelUrl: 'https://www.max.com/settings/subscription',
    emailTemplate: null,
    steps:
      '1. Sign in at max.com\n2. Settings → Subscription\n3. "Manage Subscription" → "Cancel Subscription"\n4. Confirm.',
    notes: 'HBO Max is now branded "Max". Self-service web cancel.',
  },
  {
    merchant: 'max',
    cancelUrl: 'https://www.max.com/settings/subscription',
    emailTemplate: null,
    steps:
      '1. Sign in at max.com\n2. Settings → Subscription\n3. "Manage Subscription" → "Cancel Subscription"\n4. Confirm.',
    notes: 'Formerly HBO Max. Self-service web cancel.',
  },
  {
    merchant: 'paramount',
    cancelUrl: 'https://www.paramountplus.com/account/signup/cancel/',
    emailTemplate: null,
    steps:
      '1. Sign in at paramountplus.com\n2. Account → "Cancel Subscription"\n3. Choose cancellation reason → Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'peacock',
    cancelUrl: 'https://www.peacocktv.com/account/plans',
    emailTemplate: null,
    steps:
      '1. Sign in at peacocktv.com\n2. Account → Plans & Payment\n3. "Change or Cancel Plan" → "Cancel Plan"\n4. Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'appletv',
    cancelUrl: 'https://tv.apple.com/account',
    emailTemplate: null,
    steps:
      '1. Open Settings → [your name] → Subscriptions on iPhone/iPad\n   or Apple TV+ → Account on Mac/Web\n2. Tap Apple TV+ → Cancel Subscription\n3. Confirm.',
    notes:
      'Easiest from an Apple device with your Apple ID signed in. Manage Apple subscriptions also lists every other App-Store-billed subscription you have.',
  },
  {
    merchant: 'youtubepremium',
    cancelUrl: 'https://www.youtube.com/paid_memberships',
    emailTemplate: null,
    steps:
      '1. Go to youtube.com/paid_memberships\n2. Click "Manage" next to your Premium plan\n3. "Deactivate" → "Continue to Cancel"\n4. Pick a reason → Confirm.',
    notes: 'Self-service web cancel. Works for YouTube Music subscriptions too.',
  },
  {
    merchant: 'amazonprime',
    cancelUrl: 'https://www.amazon.com/gp/primecentral',
    emailTemplate: null,
    steps:
      '1. Sign in at amazon.com\n2. Account & Lists → Prime Membership\n3. "Update, cancel and more"\n4. "End membership" → step through retention offers → Confirm.',
    notes: 'Self-service web cancel. Multiple retention prompts ("Remind me later", "Cancel my benefits", etc.) — keep clicking the cancel option.',
  },
  {
    merchant: 'audible',
    cancelUrl: 'https://www.audible.com/account/cancel-membership',
    emailTemplate: null,
    steps:
      '1. Sign in at audible.com\n2. Account Details → "Cancel Membership"\n3. Pick a reason → Decline pause/retention offers\n4. Confirm cancellation.',
    notes: 'Self-service web cancel. They will try to offer a pause (1-3 months) before letting you cancel.',
  },
  {
    merchant: 'kindleunlimited',
    cancelUrl: 'https://www.amazon.com/kindle-dbs/hz/subscription',
    emailTemplate: null,
    steps:
      '1. Sign in at amazon.com\n2. Manage Your Kindle Unlimited Membership\n3. "Cancel Kindle Unlimited Membership"\n4. Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'nytimes',
    cancelUrl: 'https://www.nytimes.com/subscription/manage',
    emailTemplate: null,
    steps:
      '1. Sign in at nytimes.com\n2. Account → Manage Subscription\n3. "Cancel Subscription"\n4. NYT will require you to schedule a chat or accept a retention offer to fully cancel.',
    notes:
      'Notoriously hard to cancel: NYT often funnels web cancels into a live chat. Use the chat — agents will process the cancel after one or two retention offers.',
  },
  {
    merchant: 'wsj',
    cancelUrl: 'https://customercenter.wsj.com/view/cancel',
    emailTemplate: null,
    steps:
      '1. Sign in at customercenter.wsj.com\n2. "Cancel Subscription"\n3. WSJ will route you to phone support (1-800-369-2834) for full cancellation.',
    notes:
      'Web cancel typically requires a follow-up phone call to 1-800-369-2834. Have your account number ready.',
  },
  {
    merchant: 'washingtonpost',
    cancelUrl: 'https://subscribe.washingtonpost.com/myaccount/',
    emailTemplate: null,
    steps:
      '1. Sign in at subscribe.washingtonpost.com\n2. My Account → Subscription Settings\n3. "Cancel My Subscription"\n4. Step through retention offers → Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'chatgpt',
    cancelUrl: 'https://chatgpt.com/#settings/Subscription',
    emailTemplate: null,
    steps:
      '1. Sign in at chatgpt.com\n2. Click your profile → Settings → Subscription\n3. "Cancel Plan" → Confirm.',
    notes: 'Self-service web cancel. Access continues until the end of the billing period.',
  },
  {
    merchant: 'githubcopilot',
    cancelUrl: 'https://github.com/settings/copilot',
    emailTemplate: null,
    steps:
      '1. Sign in at github.com\n2. Settings → Copilot\n3. "Cancel GitHub Copilot trial/subscription"\n4. Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'adobe',
    cancelUrl: 'https://account.adobe.com/plans',
    emailTemplate: null,
    steps:
      '1. Sign in at account.adobe.com\n2. Plans → "Manage Plan"\n3. "Cancel Your Plan"\n4. Confirm. Early-termination fees apply if you cancel an annual plan partway through.',
    notes:
      'Annual plans incur an early-termination fee (~50% of remaining months) if cancelled before the year is up. Month-to-month plans cancel cleanly.',
  },
  {
    merchant: 'microsoft365',
    cancelUrl: 'https://account.microsoft.com/services',
    emailTemplate: null,
    steps:
      '1. Sign in at account.microsoft.com/services\n2. Find Microsoft 365 → "Manage"\n3. "Cancel Subscription"\n4. Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'dropbox',
    cancelUrl: 'https://www.dropbox.com/account/plan',
    emailTemplate: null,
    steps:
      '1. Sign in at dropbox.com\n2. Settings → Plan\n3. "Cancel Plan" at the bottom\n4. Confirm.',
    notes: 'Self-service web cancel. Plan reverts to Basic (2 GB) at period end.',
  },
  {
    merchant: '1password',
    cancelUrl: 'https://my.1password.com',
    emailTemplate: null,
    steps:
      '1. Sign in at my.1password.com\n2. Settings → Billing\n3. "Cancel Subscription"\n4. Confirm.',
    notes: 'Self-service web cancel. Vault data exportable before cancellation.',
  },
  {
    merchant: 'linkedinpremium',
    cancelUrl: 'https://www.linkedin.com/premium/manage',
    emailTemplate: null,
    steps:
      '1. Sign in at linkedin.com\n2. Premium → "Manage Premium Account"\n3. "Cancel subscription"\n4. Step through retention offers → Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'nordvpn',
    cancelUrl: 'https://my.nordaccount.com/dashboard/nordvpn/',
    emailTemplate: null,
    steps:
      '1. Sign in at nordaccount.com\n2. NordVPN → "Manage subscription"\n3. "Cancel automatic payments"\n4. Confirm. (Service continues until period end.)',
    notes: 'Disabling auto-renew via the web is the cleanest path. Refund-eligible within 30 days via support email support@nordvpn.com.',
  },
  {
    merchant: 'expressvpn',
    cancelUrl: 'https://www.expressvpn.com/support/troubleshooting/cancel-subscription/',
    emailTemplate: `Subject: Cancel my ExpressVPN subscription

Hello,

Please cancel my ExpressVPN subscription effective immediately.
My account email is <YOUR EMAIL>.

Please confirm in writing once the cancellation is processed.

Thank you.`,
    steps:
      '1. Sign in at expressvpn.com → My Account\n2. Subscription → "Turn Off Automatic Renewal"\n3. Or contact 24/7 live chat for a full cancel + refund (30-day money-back window).',
    notes: 'Auto-renew toggle is in account settings; for a refund within 30 days, use live chat support.',
  },
  {
    merchant: 'peloton',
    cancelUrl: 'https://members.onepeloton.com/preferences/membership',
    emailTemplate: null,
    steps:
      '1. Sign in at onepeloton.com\n2. Preferences → Membership\n3. "Cancel Membership"\n4. Pick a reason → Confirm.',
    notes: 'App membership cancels via web. All-Access bike membership requires returning the bike or paying it off.',
  },
  {
    merchant: 'crunchyroll',
    cancelUrl: 'https://www.crunchyroll.com/account/membership',
    emailTemplate: null,
    steps:
      '1. Sign in at crunchyroll.com\n2. Account → Membership\n3. "Cancel Membership"\n4. Confirm.',
    notes: 'Self-service web cancel.',
  },
  {
    merchant: 'planetfitness',
    cancelUrl: null,
    emailTemplate: `Subject: Membership Cancellation Request

To Planet Fitness Membership Team,

Please cancel my Planet Fitness membership effective immediately.

Member name : <YOUR NAME>
Member email: <YOUR EMAIL>
Home club   : <YOUR HOME CLUB CITY>

I understand cancellation may require either an in-person visit
or a written letter; please confirm in writing what additional
steps are needed.

Thank you.`,
    steps:
      '1. Most Planet Fitness clubs require IN-PERSON cancellation at your home club, OR a certified letter mailed to that club.\n2. Phone and email cancellation are usually NOT accepted.\n3. Bring a photo ID and your member key tag.\n4. Get the cancellation receipt in writing.',
    notes:
      'Planet Fitness is famously hard to cancel — in-person or mailed letter to your home club only. Plan for it.',
  },
  {
    merchant: 'gym',
    cancelUrl: null,
    emailTemplate: `Subject: Membership Cancellation Request

Hello,

Please cancel my gym membership effective immediately. My
account details are:

  Member name : <YOUR NAME>
  Member email: <YOUR EMAIL>
  Home club   : <YOUR HOME CLUB>

Please confirm in writing once the cancellation is processed
and what notice period (if any) applies before charges stop.

Thank you.`,
    steps:
      '1. Check your contract for the required notice period (commonly 30-90 days).\n2. Many gyms require an in-person visit or a mailed letter; phone/email is often NOT accepted.\n3. Get the cancellation confirmation in writing and save it.',
    notes: 'Gyms typically require in-person or written cancellation with 30-90 days notice. Check your contract.',
  },
];

function normalize(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * Look up a cancellation entry by merchant/bill name. Matches when:
 *   - the normalized input equals an entry key, OR
 *   - the entry key is a substring of the normalized input
 *
 * Returns the LONGEST matching key — so "amazonprime" beats
 * a hypothetical "amazon" entry on "Amazon Prime Video".
 */
export function lookupCancellation(name: string): CancellationEntry | null {
  const norm = normalize(name);
  if (norm === '') return null;
  let best: CancellationEntry | null = null;
  let bestLen = 0;
  for (const entry of LIBRARY) {
    if (norm === entry.merchant || norm.includes(entry.merchant)) {
      if (entry.merchant.length > bestLen) {
        best = entry;
        bestLen = entry.merchant.length;
      }
    }
  }
  return best;
}

export const GENERIC_EMAIL_TEMPLATE = EMAIL_TEMPLATE_GENERIC;
