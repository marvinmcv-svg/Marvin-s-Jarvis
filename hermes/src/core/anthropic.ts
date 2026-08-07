import Anthropic from '@anthropic-ai/sdk';
import { env } from './env.js';
import { log } from './logger.js';

/**
 * Thin wrapper over the Anthropic SDK.
 *
 * Everything Hermes asks Claude for is structured JSON, so this module owns
 * three things: schema-constrained calls, usage/cost accounting, and refusal
 * handling. Call sites never touch the SDK directly.
 */

const client = new Anthropic({
  apiKey: env.ANTHROPIC_API_KEY,
  maxRetries: 3,
  // The SDK's timeout is in milliseconds.
  timeout: 4 * 60 * 1000,
});

/** Per-MTok list prices, used only for the cost estimate in the run log. */
const PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5': { input: 1.0, output: 5.0 },
  'claude-sonnet-5': { input: 3.0, output: 15.0 },
  'claude-opus-5': { input: 5.0, output: 25.0 },
};

export type Usage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  estimatedCostUsd: number;
  calls: number;
};

/** Process-wide accumulator; snapshotted into `agent_runs.metrics`. */
const usage: Usage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  estimatedCostUsd: 0,
  calls: 0,
};

export function usageSnapshot(): Usage {
  return { ...usage };
}

export function resetUsage(): void {
  usage.inputTokens = 0;
  usage.outputTokens = 0;
  usage.cacheReadTokens = 0;
  usage.estimatedCostUsd = 0;
  usage.calls = 0;
}

function recordUsage(model: string, u: Anthropic.Usage | undefined): void {
  if (!u) return;
  const price = PRICING[model] ?? { input: 3.0, output: 15.0 };
  const inTok = u.input_tokens ?? 0;
  const outTok = u.output_tokens ?? 0;
  const cacheRead = u.cache_read_input_tokens ?? 0;

  usage.calls += 1;
  usage.inputTokens += inTok;
  usage.outputTokens += outTok;
  usage.cacheReadTokens += cacheRead;
  usage.estimatedCostUsd +=
    (inTok / 1_000_000) * price.input +
    (cacheRead / 1_000_000) * price.input * 0.1 +
    (outTok / 1_000_000) * price.output;
}

/** Raised when Claude's safety classifiers decline a request. */
export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`Claude declined the request${category ? ` (${category})` : ''}`);
    this.name = 'RefusalError';
  }
}

export type JsonCallOptions = {
  /** Which model tier. 'bulk' = Haiku (audits, classification), 'quality' = Sonnet (copy). */
  tier: 'bulk' | 'quality';
  system: string;
  user: string;
  /** JSON Schema the response is constrained to. Must set additionalProperties:false. */
  schema: Record<string, unknown>;
  maxTokens?: number;
  /** Label used in logs and error messages. */
  label: string;
};

/** The single tool every structured call is forced to invoke. */
const EMIT_TOOL = 'emit';

/**
 * Ask Claude for a JSON object matching `schema`.
 *
 * Implemented with forced strict tool use: Claude is required to call a single
 * `emit` tool whose `input_schema` IS the caller's schema, and `strict: true`
 * guarantees the arguments validate. This gives the same "guaranteed valid JSON"
 * property as structured outputs but is stable across SDK versions — the SDK
 * hands back `tool_use.input` already parsed, so there's no fenced-code-block
 * scraping and no "sometimes it prefixes with 'Here is'".
 */
export async function askJson<T>(opts: JsonCallOptions): Promise<T> {
  const model = opts.tier === 'bulk' ? env.ANTHROPIC_BULK_MODEL : env.ANTHROPIC_PITCH_MODEL;
  const maxTokens = opts.maxTokens ?? (opts.tier === 'bulk' ? 4000 : 8000);

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model,
      max_tokens: maxTokens,
      // The persona + memory preamble is stable across a run, so caching it is
      // near-free money on a 50-lead batch.
      system: [{ type: 'text', text: opts.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: opts.user }],
      tools: [
        {
          name: EMIT_TOOL,
          description: 'Emit the structured result. You must call this exactly once with the full result.',
          input_schema: opts.schema as Anthropic.Tool.InputSchema,
        },
      ],
      tool_choice: { type: 'tool', name: EMIT_TOOL },
    });
  } catch (err) {
    if (err instanceof Anthropic.RateLimitError) {
      log.warn(`[${opts.label}] rate limited after SDK retries`);
    }
    throw err;
  }

  recordUsage(model, response.usage);

  if (response.stop_reason === 'refusal') {
    throw new RefusalError(null);
  }
  if (response.stop_reason === 'max_tokens') {
    throw new Error(`[${opts.label}] response hit max_tokens (${maxTokens}) — result is truncated`);
  }

  const toolUse = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === EMIT_TOOL,
  );
  if (!toolUse) throw new Error(`[${opts.label}] model did not call the emit tool`);

  return toolUse.input as T;
}

/**
 * Same as `askJson`, but never throws — returns `null` on failure.
 *
 * Used in the per-lead loops: one lead whose audit fails must not sink a batch
 * of fifty. The failure is logged and the lead falls through with a null audit.
 */
export async function tryAskJson<T>(opts: JsonCallOptions): Promise<T | null> {
  try {
    return await askJson<T>(opts);
  } catch (err) {
    log.warn(`[${opts.label}] ${(err as Error).message}`);
    return null;
  }
}

/** Liveness probe for the Phase 0 health check — one cheap call. */
export async function pingLlm(): Promise<boolean> {
  try {
    const res = await client.messages.create({
      model: env.ANTHROPIC_BULK_MODEL,
      max_tokens: 16,
      messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
    });
    recordUsage(env.ANTHROPIC_BULK_MODEL, res.usage);
    return res.content.some((b) => b.type === 'text' && b.text.toLowerCase().includes('ok'));
  } catch (err) {
    log.error(`LLM canary failed: ${(err as Error).message}`);
    return false;
  }
}
