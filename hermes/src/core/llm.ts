import { env } from './env.js';
import { log } from './logger.js';
import {
  RefusalError,
  anthropicStructured,
  anthropicPing,
  openaiStructured,
  openaiPing,
  geminiStructured,
  geminiPing,
  type Provider,
  type ResolvedLlm,
  type RawUsage,
  type StructuredRequest,
} from './providers.js';

/**
 * The provider-agnostic LLM façade.
 *
 * Call sites use `askJson` / `tryAskJson` and never touch a provider. Which
 * provider runs — Anthropic, any OpenAI-compatible gateway (9Router, OpenRouter,
 * Groq, Together, Ollama, OpenAI), or Gemini — is resolved once from the
 * environment. This is the seam that lets Hermes (and future agents copying this
 * module) run on ANY kind of API key.
 */

export { RefusalError };

/* ─── Provider resolution ─────────────────────────────────────────────────
 * Precedence, so a single agent can be pointed anywhere with minimal config:
 *   1. LLM_PROVIDER if set explicitly.
 *   2. A configured LLM_BASE_URL implies an OpenAI-compatible gateway.
 *   3. Otherwise inferred from the model name (claude* → anthropic, gemini* →
 *      gemini, else openai), defaulting to anthropic.
 */
let cached: ResolvedLlm | null = null;

export function resolveLlm(): ResolvedLlm {
  if (cached) return cached;

  const provider = detectProvider();
  const apiKey = resolveKey(provider);
  if (!apiKey) {
    throw new Error(
      `No API key for provider "${provider}". Set LLM_API_KEY (generic), or a provider-specific key ` +
        '(ANTHROPIC_API_KEY / OPENROUTER_API_KEY / GEMINI_API_KEY). See hermes/.env.example.',
    );
  }

  const bulkModel = env.LLM_BULK_MODEL || env.ANTHROPIC_BULK_MODEL || defaultModel(provider, 'bulk');
  const pitchModel = env.LLM_PITCH_MODEL || env.ANTHROPIC_PITCH_MODEL || defaultModel(provider, 'quality');
  if (!bulkModel || !pitchModel) {
    throw new Error(
      `Provider "${provider}" needs explicit models. Set LLM_BULK_MODEL and LLM_PITCH_MODEL ` +
        '(e.g. for 9Router: LLM_BULK_MODEL=kr/claude-haiku LLM_PITCH_MODEL=kr/claude-sonnet-4.5).',
    );
  }

  cached = {
    provider,
    apiKey,
    baseUrl: env.LLM_BASE_URL || null,
    bulkModel,
    pitchModel,
  };
  log.info(`LLM: provider=${provider} bulk=${short(bulkModel)} quality=${short(pitchModel)}${cached.baseUrl ? ` via ${cached.baseUrl}` : ''}`);
  return cached;
}

function detectProvider(): Provider {
  if (env.LLM_PROVIDER) return env.LLM_PROVIDER;
  if (env.LLM_BASE_URL) return 'openai'; // a base URL means an OpenAI-compatible gateway
  const model = env.LLM_BULK_MODEL || env.ANTHROPIC_BULK_MODEL || '';
  if (/^gemini/i.test(model)) return 'gemini';
  if (/^claude/i.test(model) || model === '') return 'anthropic';
  return 'openai';
}

function resolveKey(provider: Provider): string | undefined {
  if (env.LLM_API_KEY) return env.LLM_API_KEY;
  if (provider === 'anthropic') return env.ANTHROPIC_API_KEY;
  if (provider === 'gemini') return env.GEMINI_API_KEY;
  // openai-compatible: OpenRouter key is the common one; fall back to Anthropic's slot.
  return env.OPENROUTER_API_KEY || env.OPENAI_API_KEY || env.ANTHROPIC_API_KEY;
}

function defaultModel(provider: Provider, tier: 'bulk' | 'quality'): string {
  // Only Anthropic has safe defaults; gateways need explicit model IDs.
  if (provider === 'anthropic') return tier === 'bulk' ? 'claude-haiku-4-5' : 'claude-sonnet-5';
  return '';
}

/* ─── Usage + cost accounting ─────────────────────────────────────────────── */

/** Per-MTok list prices for known Anthropic models; others estimate at 0. */
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

const usage: Usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0, calls: 0 };

export function usageSnapshot(): Usage {
  return { ...usage };
}
export function resetUsage(): void {
  usage.inputTokens = usage.outputTokens = usage.cacheReadTokens = usage.estimatedCostUsd = usage.calls = 0;
}

function record(model: string, u: RawUsage): void {
  const price = PRICING[baseModelId(model)];
  usage.calls += 1;
  usage.inputTokens += u.inputTokens;
  usage.outputTokens += u.outputTokens;
  usage.cacheReadTokens += u.cacheReadTokens;
  if (price) {
    usage.estimatedCostUsd +=
      (u.inputTokens / 1e6) * price.input +
      (u.cacheReadTokens / 1e6) * price.input * 0.1 +
      (u.outputTokens / 1e6) * price.output;
  }
}

/** Strip a gateway prefix like "kr/" so "kr/claude-sonnet-5" still prices. */
function baseModelId(model: string): string {
  const bare = model.includes('/') ? model.slice(model.lastIndexOf('/') + 1) : model;
  return bare.replace(/-\d{8}$/, '');
}

/* ─── The public call surface ─────────────────────────────────────────────── */

export type JsonCallOptions = {
  tier: 'bulk' | 'quality';
  system: string;
  user: string;
  schema: Record<string, unknown>;
  maxTokens?: number;
  label: string;
};

/** Ask the active provider for a JSON object matching `schema`. */
export async function askJson<T>(opts: JsonCallOptions): Promise<T> {
  const cfg = resolveLlm();
  const model = opts.tier === 'bulk' ? cfg.bulkModel : cfg.pitchModel;
  const maxTokens = opts.maxTokens ?? (opts.tier === 'bulk' ? 4000 : 8000);

  const req: StructuredRequest = {
    system: opts.system,
    user: opts.user,
    schema: opts.schema,
    maxTokens,
    model,
    label: opts.label,
  };

  const outcome = await dispatch(cfg, req);
  record(outcome.model || model, outcome.usage);
  return outcome.value as T;
}

/** Never-throws variant: one failed lead must not sink a batch of fifty. */
export async function tryAskJson<T>(opts: JsonCallOptions): Promise<T | null> {
  try {
    return await askJson<T>(opts);
  } catch (err) {
    log.warn(`[${opts.label}] ${(err as Error).message}`);
    return null;
  }
}

/** Liveness probe for the Phase 0 health check. */
export async function pingLlm(): Promise<boolean> {
  try {
    const cfg = resolveLlm();
    switch (cfg.provider) {
      case 'anthropic':
        return await anthropicPing(cfg, cfg.bulkModel);
      case 'openai':
        return await openaiPing(cfg, cfg.bulkModel);
      case 'gemini':
        return await geminiPing(cfg, cfg.bulkModel);
    }
  } catch (err) {
    log.error(`LLM canary failed: ${(err as Error).message}`);
    return false;
  }
}

function dispatch(cfg: ResolvedLlm, req: StructuredRequest) {
  switch (cfg.provider) {
    case 'anthropic':
      return anthropicStructured(cfg, req);
    case 'openai':
      return openaiStructured(cfg, req);
    case 'gemini':
      return geminiStructured(cfg, req);
  }
}

function short(model: string): string {
  return model.split(',')[0]!.trim();
}
