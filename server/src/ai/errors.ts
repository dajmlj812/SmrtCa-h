/**
 * 0.19.1.x — typed errors for AI-provider misconfiguration.
 *
 * These represent operator-fixable conditions (missing API key, bad
 * base URL, wrong model name). Routes that catch these should return
 * 503 with a clear "AI is temporarily unavailable, contact your
 * administrator" message rather than a raw 500. The end user can't
 * fix this — only a super-admin via /settings can.
 */

export class AIProviderNotConfiguredError extends Error {
  readonly code = 'AI_PROVIDER_NOT_CONFIGURED';
  /** Provider id that failed (e.g. "claude", "ollama"). */
  readonly provider: string;
  /** Which setting key the operator needs to fix. */
  readonly missingSetting: string;

  constructor(provider: string, missingSetting: string) {
    super(
      `${missingSetting} is required when AI_PROVIDER=${provider}. ` +
        `Set it via /settings (super-admin only) and retry.`,
    );
    this.name = 'AIProviderNotConfiguredError';
    this.provider = provider;
    this.missingSetting = missingSetting;
  }
}
