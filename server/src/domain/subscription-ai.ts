import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config.js';

/**
 * AI subscription classifier.
 *
 * Given a set of candidate recurring outflows (the rules-based detector's
 * bill-kind output), Claude decides which of them are *subscriptions* —
 * cancelable/alterable services like Netflix, Spotify, AWS, gym
 * memberships, SaaS — and which are not (rent, mortgage, utilities,
 * loan payments, insurance). The non-subscription ones get auto-rejected
 * so the Subscriptions page only surfaces things the user can actually
 * act on.
 *
 * The model also returns a cleaned display name ("AMAZON WEB SVCS
 * 071201" -> "Amazon Web Services").
 *
 * Provider: Claude only. Ollama support can be added by mirroring this
 * with the OpenAI-compatible chat endpoint, but isn't wired today.
 */

export interface SubscriptionCandidate {
  id: string;
  /** Detector-default name (raw merchant or first words of description). */
  name: string;
  /** Up to ~5 raw_descriptions of the sample transactions. */
  sampleDescriptions: string[];
  /** Median absolute amount in cents (the user-visible per-cycle cost). */
  amountCents: number;
  /** Detected cadence (weekly/biweekly/monthly/...). */
  frequency: string;
}

export interface SubscriptionVerdict {
  id: string;
  isSubscription: boolean;
  /** Cleaned display name. Falls back to the input name when AI returns junk. */
  displayName: string;
  /** Why this verdict — used as the review_note when auto-rejecting. */
  reason: string;
}

const MODEL_FALLBACK = 'claude-haiku-4-5';
const MAX_OUTPUT_TOKENS = 2000;

const SYSTEM_PROMPT = `You are classifying recurring outflows from a personal finance app.

A SUBSCRIPTION is a recurring charge for an optional service the user can
cancel, downgrade, or change at any time. Examples: Netflix, Spotify,
Hulu, Disney+, gym membership, magazine, AWS/cloud services,
software-as-a-service, news subscriptions, app stores, security
monitoring, meal kits, dating apps, premium app tiers.

A NON-SUBSCRIPTION is everything else — necessities, contractual
obligations, or one-time recurring patterns. Examples: rent/mortgage,
electricity/gas/water/internet/phone bills, loan payments, credit-card
payments, insurance premiums, property tax, child support, alimony,
taxes, transfers between accounts, paychecks (those are income but
might leak through), donations, ATM fees.

For each candidate, decide is_subscription (true/false) and produce a
cleaned display_name suitable for showing in a UI list (proper case,
strip transaction IDs/store numbers/dates/cities). Provide a one-line
reason in 12 words or less explaining the classification — used as a
review note when we auto-reject non-subscriptions.

Respond with JSON of shape:
{ "verdicts": [
    { "id": "...", "is_subscription": true|false,
      "display_name": "...", "reason": "..." },
    ...
  ] }

Return exactly one verdict per candidate, in the same order.`;

interface ClaudeResponse {
  verdicts?: Array<{
    id?: unknown;
    is_subscription?: unknown;
    display_name?: unknown;
    reason?: unknown;
  }>;
}

/**
 * Ask Claude to classify each candidate. Returns the verdicts. The caller
 * decides what to do with them (update recurring_suggestions name, set
 * ai_refined=true, auto-reject non-subscriptions).
 *
 * Throws when AI_PROVIDER isn't 'claude' or the API call fails — the
 * route layer catches and reports it back to the UI.
 */
export async function classifySubscriptions(
  candidates: SubscriptionCandidate[],
  client?: Anthropic,
): Promise<SubscriptionVerdict[]> {
  if (candidates.length === 0) return [];
  if (config.ai.provider !== 'claude') {
    throw new Error(
      `AI subscription scan requires AI_PROVIDER=claude (current: ${config.ai.provider})`,
    );
  }
  const sdk =
    client ?? new Anthropic({ apiKey: config.ai.anthropicApiKey });

  const userText = candidates
    .map((c, i) => {
      const samples = c.sampleDescriptions
        .slice(0, 5)
        .map((s) => `      - "${s.replace(/\n+/g, ' ').slice(0, 120)}"`)
        .join('\n');
      const dollars = (c.amountCents / 100).toFixed(2);
      return [
        `${i + 1}. id: ${c.id}`,
        `   detector_name: "${c.name}"`,
        `   amount: $${dollars} every ${c.frequency}`,
        `   sample_descriptions:`,
        samples,
      ].join('\n');
    })
    .join('\n\n');

  const response = await sdk.messages.create({
    model: config.ai.anthropicModel || MODEL_FALLBACK,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [
      {
        type: 'text',
        text: SYSTEM_PROMPT,
        cache_control: { type: 'ephemeral' },
      },
    ],
    messages: [
      {
        role: 'user',
        content:
          `Classify the following ${candidates.length} recurring-outflow ` +
          `candidate(s). Return one verdict per candidate in the same order.\n\n` +
          userText,
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming);

  const textBlock = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === 'text',
  );
  if (!textBlock) {
    throw new Error('Claude response contained no text block');
  }

  // The model returns JSON inside a fenced block sometimes — strip fences.
  const cleaned = textBlock.text
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();

  let parsed: ClaudeResponse;
  try {
    parsed = JSON.parse(cleaned) as ClaudeResponse;
  } catch (err) {
    throw new Error(
      `Claude subscription response was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const verdicts = Array.isArray(parsed.verdicts) ? parsed.verdicts : [];
  // Build a map keyed by id; fall back to input order for misshapen rows.
  const byId = new Map<string, SubscriptionVerdict>();
  for (const v of verdicts) {
    if (typeof v.id !== 'string') continue;
    byId.set(v.id, {
      id: v.id,
      isSubscription: v.is_subscription === true,
      displayName:
        typeof v.display_name === 'string' && v.display_name.trim() !== ''
          ? v.display_name.trim()
          : '',
      reason:
        typeof v.reason === 'string' ? v.reason.trim().slice(0, 200) : '',
    });
  }

  // Synthesize fallbacks for any candidate the model didn't return.
  return candidates.map((c) => {
    const found = byId.get(c.id);
    if (found && found.displayName !== '') return found;
    return {
      id: c.id,
      isSubscription: found?.isSubscription ?? false,
      displayName: found?.displayName || c.name,
      reason: found?.reason || 'AI returned no verdict — left as-is',
    };
  });
}
