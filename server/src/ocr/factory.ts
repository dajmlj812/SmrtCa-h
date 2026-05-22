import { config } from '../config.js';
import { ClaudeOcrProvider } from './claude-ocr.js';
import type { OcrProvider } from './types.js';

/**
 * Returns the configured OCR provider, or null when none is available.
 * Currently only the Claude provider supports vision; the rules and Ollama
 * paths return null until a vision-capable Ollama integration ships.
 */
export function getOcrProvider(): OcrProvider | null {
  if (config.ai.provider === 'claude' && config.ai.anthropicApiKey) {
    return new ClaudeOcrProvider({
      apiKey: config.ai.anthropicApiKey,
      model: config.ai.anthropicModel,
    });
  }
  return null;
}
