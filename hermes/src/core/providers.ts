import Anthropic from '@anthropic-ai/sdk';
import { log } from './logger.js';

/**
 * LLM providers — the part that makes Hermes (and any agent built on this
 * pattern) work with ANY kind of API key.
 *
 * Three provider shapes cover essentially every model host:
 *   anthropic — Claude's native Messages API (forced tool use for JSON).
 *   openai    — the OpenAI Chat Completions shape, which is ALSO spoken by
 *               9Router, OpenRouter, Groq, Together, Ollama, LM Studio, and
 *               dozens of others. Just point LLM_BASE_URL at the gateway.
 *   gemini    — Google's generateContent API (JSON mode).
 *
 * Every provider returns the same StructuredOutcome, so the rest of the agent
 * never knows or cares which one is active.
 */

export type Provider = 'anthropic' | 'openai' | 'gemini';

export type RawUsage = { inputTokens: number; outputTokens: number; cacheReadTokens: number };

export type StructuredRequest = {
  system: string;
  user: string;
  /** JSON Schema the result must match. additionalProperties:false expected. */
  schema: Record<string, unknown>;
  maxTokens: number;
  /** May be a comma-separated list — providers rotate through it on failure. */
  model: string;
  label: string;
};

export type StructuredOutcome = { value: unknown; usage: RawUsage; model: string };

export type ResolvedLlm = {
  provider: Provider;
  apiKey: string;
  /** OpenAI-compatible endpoint, or Gemini base; null = provider default. */
  baseUrl: string | null;
  bulkModel: string;
  pitchModel: string;
};

/** Thrown when a provider's safety layer declines the request. */
export class RefusalError extends Error {
  constructor(readonly category: string | null) {
    super(`The model declined the request${category ? ` (${category})` : ''}`);
    this.name = 'RefusalError';
  }
}

const EMIT_TOOL = 'emit';
const EMIT_DESC = 'Emit the structured result. You must call this exactly once with the full result.';

const zeroUsage = (): RawUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });

/* ─────────────────────────────────────────────────────────────────────────
 * ANTHROPIC
 * ───────────────────────────────────────────────────────────────────────── */

let anthropicClient: { key: string; base: string | null; client: Anthropic } | null = null;

function anthropic(cfg: ResolvedLlm): Anthropic {
  if (!anthropicClient || anthropicClient.key !== cfg.apiKey || anthropicClient.base !== cfg.baseUrl) {
    anthropicClient = {
      key: cfg.apiKey,
      base: cfg.baseUrl,
      client: new Anthropic({
        apiKey: cfg.apiKey,
        ...(cfg.baseUrl ? { baseURL: cfg.baseUrl } : {}),
        maxRetries: 3,
        timeout: 4 * 60 * 1000,
      }),
    };
  }
  return anthropicClient.client;
}

export async function anthropicStructured(cfg: ResolvedLlm, req: StructuredRequest): Promise<StructuredOutcome> {
  const client = anthropic(cfg);
  const res = await client.messages.create({
    model: firstModel(req.model),
    max_tokens: req.maxTokens,
    // Stable preamble caches well across a 50-lead batch.
    system: [{ type: 'text', text: req.system, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: req.user }],
    tools: [{ name: EMIT_TOOL, description: EMIT_DESC, input_schema: req.schema as Anthropic.Tool.InputSchema }],
    tool_choice: { type: 'tool', name: EMIT_TOOL },
  });

  const usage: RawUsage = {
    inputTokens: res.usage?.input_tokens ?? 0,
    outputTokens: res.usage?.output_tokens ?? 0,
    cacheReadTokens: res.usage?.cache_read_input_tokens ?? 0,
  };

  if (res.stop_reason === 'refusal') throw new RefusalError(null);
  if (res.stop_reason === 'max_tokens') {
    throw new Error(`[${req.label}] hit max_tokens (${req.maxTokens}) — result truncated`);
  }

  const toolUse = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === EMIT_TOOL,
  );
  if (!toolUse) throw new Error(`[${req.label}] model did not call the emit tool`);
  return { value: toolUse.input, usage, model: res.model };
}

export async function anthropicPing(cfg: ResolvedLlm, model: string): Promise<boolean> {
  const res = await anthropic(cfg).messages.create({
    model: firstModel(model),
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  return res.content.some((b) => b.type === 'text' && b.text.toLowerCase().includes('ok'));
}

/* ─────────────────────────────────────────────────────────────────────────
 * OPENAI-COMPATIBLE (OpenAI, 9Router, OpenRouter, Groq, Together, Ollama, …)
 * ───────────────────────────────────────────────────────────────────────── */

const DEFAULT_OPENAI_BASE = 'https://api.openai.com/v1';

function chatUrl(baseUrl: string | null): string {
  const b = (baseUrl ?? DEFAULT_OPENAI_BASE).replace(/\/+$/, '');
  return b.endsWith('/chat/completions') ? b : `${b}/chat/completions`;
}

/**
 * Structured JSON on any OpenAI-compatible endpoint.
 *
 * Primary path is forced function calling (the analogue of Anthropic's forced
 * tool use). Many free/gateway models don't implement tools well, so there's a
 * fallback that asks for raw JSON with `response_format` and extracts it — that
 * combination gets valid JSON out of almost anything, including the free
 * OpenRouter models.
 *
 * A comma-separated model string is rotated through: transient failures move to
 * the next model; an auth failure stops immediately.
 */
export async function openaiStructured(cfg: ResolvedLlm, req: StructuredRequest): Promise<StructuredOutcome> {
  const url = chatUrl(cfg.baseUrl);
  const models = modelList(req.model);
  let lastErr: Error | null = null;

  for (const model of models) {
    try {
      return await openaiOnce(url, cfg.apiKey, model, req);
    } catch (err) {
      const e = err as Error & { status?: number };
      if (e.status === 401 || e.status === 403) throw e; // bad key — no point rotating
      lastErr = e;
      if (models.length > 1) log.warn(`[${req.label}] model "${model}" failed (${e.message}) — trying next`);
    }
  }
  throw lastErr ?? new Error(`[${req.label}] all models failed`);
}

async function openaiOnce(url: string, key: string, model: string, req: StructuredRequest): Promise<StructuredOutcome> {
  // 1) Forced function calling.
  const toolBody = {
    model,
    max_tokens: req.maxTokens,
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
    tools: [{ type: 'function', function: { name: EMIT_TOOL, description: EMIT_DESC, parameters: req.schema } }],
    tool_choice: { type: 'function', function: { name: EMIT_TOOL } },
  };

  const toolRes = await postChat(url, key, toolBody);
  const toolCall = toolRes.json?.choices?.[0]?.message?.tool_calls?.[0]?.function?.arguments;
  if (typeof toolCall === 'string') {
    const value = tryParse(toolCall);
    if (value !== undefined) return { value, usage: openaiUsage(toolRes.json), model };
  }
  // Some models answer with content even under forced tools.
  const inlineContent = toolRes.json?.choices?.[0]?.message?.content;
  if (typeof inlineContent === 'string') {
    const value = extractJson(inlineContent);
    if (value !== undefined) return { value, usage: openaiUsage(toolRes.json), model };
  }

  // 2) Fallback: raw JSON via response_format + schema in the prompt.
  const jsonBody = {
    model,
    max_tokens: req.maxTokens,
    messages: [
      {
        role: 'system',
        content: `${req.system}\n\nRespond with ONLY a JSON object that conforms to this JSON schema. No prose, no markdown fences:\n${JSON.stringify(req.schema)}`,
      },
      { role: 'user', content: req.user },
    ],
    response_format: { type: 'json_object' },
  };

  let jsonRes = await postChat(url, key, jsonBody);
  // Gateways that reject response_format: retry without it.
  if (!jsonRes.ok && /response_format|json_object/i.test(jsonRes.text)) {
    const { response_format: _omit, ...noFmt } = jsonBody;
    jsonRes = await postChat(url, key, noFmt);
  }
  if (!jsonRes.ok) {
    const err = new Error(`[${req.label}] HTTP ${jsonRes.status}: ${jsonRes.text.slice(0, 160)}`) as Error & { status?: number };
    err.status = jsonRes.status;
    throw err;
  }

  const content = jsonRes.json?.choices?.[0]?.message?.content;
  const value = typeof content === 'string' ? extractJson(content) : undefined;
  if (value === undefined) throw new Error(`[${req.label}] could not extract JSON from the response`);
  return { value, usage: openaiUsage(jsonRes.json), model };
}

export async function openaiPing(cfg: ResolvedLlm, model: string): Promise<boolean> {
  const res = await postChat(chatUrl(cfg.baseUrl), cfg.apiKey, {
    model: firstModel(model),
    max_tokens: 16,
    messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
  });
  const text = res.json?.choices?.[0]?.message?.content;
  return typeof text === 'string' && text.toLowerCase().includes('ok');
}

type ChatResponse = { ok: boolean; status: number; text: string; json: any };

async function postChat(url: string, key: string, body: unknown): Promise<ChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${key}`,
        // OpenRouter asks for these; harmless everywhere else.
        'HTTP-Referer': 'https://github.com/marvinmcv-svg/Marvin-s-Jarvis',
        'X-Title': 'Hermes Lead Hunter',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* leave json null; caller inspects text */
    }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

function openaiUsage(json: any): RawUsage {
  const u = json?.usage ?? {};
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    cacheReadTokens: u.prompt_tokens_details?.cached_tokens ?? 0,
  };
}

/* ─────────────────────────────────────────────────────────────────────────
 * GEMINI
 * ───────────────────────────────────────────────────────────────────────── */

const DEFAULT_GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta';

export async function geminiStructured(cfg: ResolvedLlm, req: StructuredRequest): Promise<StructuredOutcome> {
  const model = firstModel(req.model);
  const base = (cfg.baseUrl ?? DEFAULT_GEMINI_BASE).replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;

  const body = {
    system_instruction: {
      parts: [
        {
          text: `${req.system}\n\nRespond with ONLY a JSON object conforming to this JSON schema:\n${JSON.stringify(req.schema)}`,
        },
      ],
    },
    contents: [{ role: 'user', parts: [{ text: req.user }] }],
    generationConfig: { responseMimeType: 'application/json', maxOutputTokens: req.maxTokens },
  };

  const res = await postJson(url, body);
  if (!res.ok) {
    const err = new Error(`[${req.label}] Gemini HTTP ${res.status}: ${res.text.slice(0, 160)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const text = res.json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  const value = extractJson(text);
  if (value === undefined) throw new Error(`[${req.label}] could not extract JSON from Gemini`);

  const u = res.json?.usageMetadata ?? {};
  return {
    value,
    usage: { inputTokens: u.promptTokenCount ?? 0, outputTokens: u.candidatesTokenCount ?? 0, cacheReadTokens: u.cachedContentTokenCount ?? 0 },
    model,
  };
}

export async function geminiPing(cfg: ResolvedLlm, model: string): Promise<boolean> {
  const base = (cfg.baseUrl ?? DEFAULT_GEMINI_BASE).replace(/\/+$/, '');
  const url = `${base}/models/${encodeURIComponent(firstModel(model))}:generateContent?key=${encodeURIComponent(cfg.apiKey)}`;
  const res = await postJson(url, { contents: [{ role: 'user', parts: [{ text: 'Reply with the single word: ok' }] }] });
  const text = res.json?.candidates?.[0]?.content?.parts?.map((p: any) => p.text).join('') ?? '';
  return text.toLowerCase().includes('ok');
}

async function postJson(url: string, body: unknown): Promise<ChatResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4 * 60 * 1000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* ignore */
    }
    return { ok: res.ok, status: res.status, text, json };
  } finally {
    clearTimeout(timer);
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * SHARED HELPERS
 * ───────────────────────────────────────────────────────────────────────── */

function modelList(model: string): string[] {
  return model.split(',').map((m) => m.trim()).filter(Boolean);
}
function firstModel(model: string): string {
  return modelList(model)[0] ?? model;
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Pull a JSON object out of free-form model text (fences, prose, etc.). */
function extractJson(text: string): unknown {
  const direct = tryParse(text.trim());
  if (direct !== undefined) return direct;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) {
    const v = tryParse(fenced[1].trim());
    if (v !== undefined) return v;
  }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const v = tryParse(text.slice(start, end + 1));
    if (v !== undefined) return v;
  }
  return undefined;
}

export const _internal = { zeroUsage };
