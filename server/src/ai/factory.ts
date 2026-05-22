import { config } from '../config.js';
import { ClaudeNormalizer } from './claude-normalizer.js';
import { OllamaNormalizer } from './ollama-normalizer.js';
import { RulesNormalizer } from './rules-normalizer.js';
import type { TransactionNormalizer } from './types.js';

/**
 * Construct the configured normalizer based on the current `AI_PROVIDER`.
 * Returns null when normalization is explicitly disabled (`none`).
 * Throws if the provider is enabled but its required configuration is missing.
 */
export function getNormalizer(): TransactionNormalizer | null {
  switch (config.ai.provider) {
    case 'rules':
      return new RulesNormalizer();
    case 'claude':
      return new ClaudeNormalizer({
        apiKey: config.ai.anthropicApiKey,
        model: config.ai.anthropicModel,
      });
    case 'ollama':
      return new OllamaNormalizer({
        baseUrl: config.ai.ollamaBaseUrl,
        model: config.ai.ollamaModel,
      });
    case 'none':
    default:
      return null;
  }
}

/**
 * The provider id reported by `GET /api/ai/status`, even when the provider
 * has no real instance (e.g. `none`).
 */
export function getProviderId(): string {
  return config.ai.provider;
}
