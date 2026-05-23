import Anthropic from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { getEffectiveValue } from '../settings.js';
import {
  ASSISTANT_TOOLS,
  describeToolsForAnthropic,
  findTool,
  type AssistantToolContext,
} from './tools.js';

/**
 * Phase 9.1 — Assistant runtime.
 *
 * Tool-use loop against Anthropic's Messages API. The model decides
 * which tools to call; we execute them server-side (scoped to the
 * authenticated tenant) and feed the results back until the model
 * returns text instead of more tool calls.
 *
 * Hard cap MAX_ITERATIONS so a confused model can't burn the day
 * looping on a bad chain of tool calls.
 *
 * Audit: write-kind tools call recordAudit() themselves (see tools.ts).
 * The runtime also captures every tool call it executed and returns
 * that list to the client so the UI can show "the assistant called
 * <tool> with <args>".
 */

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_ITERATIONS = 8;

const SYSTEM_PROMPT = `You are SmrtCash's in-app financial assistant. You help the user understand and manage their personal finance data using the tools provided.

Rules:
- All data you see is scoped to the user's tenant. You cannot see or affect other users' data.
- Prefer querying for current data over guessing. When in doubt, call a read tool first.
- For write tools, be conservative: confirm the user's intent in your response and explain what you did.
- When a question has a date range and the user didn't specify, default to the last 30 days for "recent", the current month for "this month", or the prior calendar month for "last month".
- All monetary values you receive from tools are in INTEGER CENTS. -2500 means a $25.00 outflow.
- When reporting amounts to the user, format as $ values with two decimals.
- Never invent transaction IDs, category names, or budget numbers — call list_* tools to discover them first.
- When the user asks you to make a bulk change, run the corresponding read tool first and tell the user what you found, then execute the write tool.
- Be terse. Answer in one or two short paragraphs unless the user asks for detail.`;

export interface AssistantMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AssistantToolCallLog {
  name: string;
  kind: 'read' | 'write';
  input: unknown;
  result?: unknown;
  error?: string;
}

export interface AssistantChatResult {
  reply: string;
  toolCalls: AssistantToolCallLog[];
  iterations: number;
  stopReason: 'end_turn' | 'tool_use_loop_cap' | 'error';
}

export interface AssistantChatOptions {
  messages: AssistantMessage[];
  ctx: AssistantToolContext;
  /** Injected by tests; production uses the global SDK client. */
  client?: Anthropic;
  model?: string;
}

/**
 * Single tool-use loop. Caller passes the conversation history; this
 * function appends the model's response (and any tool calls + their
 * results) until the model returns end_turn or we hit MAX_ITERATIONS.
 */
export async function runAssistantChat(
  opts: AssistantChatOptions,
): Promise<AssistantChatResult> {
  const apiKey = (await getEffectiveValue('ANTHROPIC_API_KEY')) || config.ai.anthropicApiKey;
  const client = opts.client ?? new Anthropic({ apiKey });
  const model =
    opts.model ||
    (await getEffectiveValue('ANTHROPIC_MODEL')) ||
    config.ai.anthropicModel ||
    DEFAULT_MODEL;

  // Convert the simple {role, content} pairs into Anthropic's
  // message-block shape. We carry tool_use + tool_result blocks
  // INTERNALLY across iterations; the client only ever sees the
  // text-only summary.
  const messages: Anthropic.MessageParam[] = opts.messages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  const toolCalls: AssistantToolCallLog[] = [];
  let iterations = 0;
  let stopReason: AssistantChatResult['stopReason'] = 'end_turn';
  let finalText = '';

  while (iterations < MAX_ITERATIONS) {
    iterations += 1;
    const response: Anthropic.Message = await client.messages.create({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      tools: describeToolsForAnthropic() as unknown as Anthropic.Tool[],
      messages,
    } as Anthropic.MessageCreateParamsNonStreaming);

    // Pull text content out as the response-so-far.
    finalText = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (response.stop_reason !== 'tool_use') {
      stopReason = 'end_turn';
      break;
    }

    // Execute every tool_use block in this response, then send the
    // tool_result blocks back as the next user message. The assistant
    // message must include both its text blocks AND its tool_use
    // blocks per the Anthropic protocol.
    messages.push({ role: 'assistant', content: response.content });
    const toolResultBlocks: Anthropic.ToolResultBlockParam[] = [];

    for (const block of response.content) {
      if (block.type !== 'tool_use') continue;
      const tool = findTool(block.name);
      const log: AssistantToolCallLog = {
        name: block.name,
        kind: tool?.kind ?? 'read',
        input: block.input,
      };
      if (!tool) {
        log.error = `Unknown tool ${block.name}`;
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: log.error }),
          is_error: true,
        });
        toolCalls.push(log);
        continue;
      }
      try {
        const result = await tool.execute(opts.ctx, block.input);
        log.result = result;
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      } catch (err) {
        log.error = err instanceof Error ? err.message : String(err);
        toolResultBlocks.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: JSON.stringify({ error: log.error }),
          is_error: true,
        });
      }
      toolCalls.push(log);
    }

    messages.push({ role: 'user', content: toolResultBlocks });
  }

  if (iterations >= MAX_ITERATIONS && stopReason === 'end_turn') {
    stopReason = 'tool_use_loop_cap';
  }

  return { reply: finalText, toolCalls, iterations, stopReason };
}

/**
 * Returns whether the assistant can run given the current effective
 * settings (DB-resident values win over env, per the settings hot-
 * mutation contract). Used by the status endpoint and the
 * frontend nav gate.
 */
export async function assistantAvailable(): Promise<{ available: boolean; reason?: string }> {
  const provider =
    ((await getEffectiveValue('AI_PROVIDER')) || config.ai.provider).toLowerCase();
  if (provider !== 'claude') {
    return {
      available: false,
      reason: `AI_PROVIDER is "${provider}" — the assistant requires AI_PROVIDER=claude (Ollama tool-use coming later)`,
    };
  }
  const key = (await getEffectiveValue('ANTHROPIC_API_KEY')) || config.ai.anthropicApiKey;
  if (!key) {
    return { available: false, reason: 'ANTHROPIC_API_KEY is not set' };
  }
  return { available: true };
}

export const __testing = { MAX_ITERATIONS, ASSISTANT_TOOLS };
