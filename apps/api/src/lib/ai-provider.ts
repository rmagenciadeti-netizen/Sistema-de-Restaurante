import type { PrismaClient } from '@prisma/client';
import { openWith, sealWith } from './secret-box';

export type AiRequest = { system: string; question: string; model?: string; maxTokens?: number };
export type AiAnswer = { text: string; model: string; inputTokens: number | null; outputTokens: number | null };
// Implemented by a concrete LLM adapter. answerDetailed also reports the provider's own token counts (null when the provider does not return them)
// so consumption is measured, not guessed.
export interface AiProvider { readonly name: string; answer(request: AiRequest): Promise<string | null>; answerDetailed?(request: AiRequest): Promise<AiAnswer | null> }

type Config = { apiKey: string; model: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number };

// Universal provider catalog. `openai` kind covers every OpenAI-compatible chat-completions endpoint (OpenAI, Gemini, Groq, OpenRouter, Ollama, vLLM…);
// `anthropic` uses the Anthropic Messages API. The model is always chosen by the administrator; defaults are only suggestions.
export const AI_PRESETS = {
  openai: { label: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', suggestedModel: 'gpt-4o-mini' },
  anthropic: { label: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com', suggestedModel: 'claude-3-5-haiku-latest' },
  gemini: { label: 'Google Gemini', kind: 'openai', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', suggestedModel: 'gemini-2.0-flash' },
  groq: { label: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', suggestedModel: 'llama-3.3-70b-versatile' },
  openrouter: { label: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', suggestedModel: 'openai/gpt-4o-mini' },
  custom: { label: 'Outro (compatível com OpenAI)', kind: 'openai', baseUrl: '', suggestedModel: '' },
} as const;
export type AiProviderKey = keyof typeof AI_PRESETS;
export const isProviderKey = (value: string): value is AiProviderKey => value in AI_PRESETS;

// Adapter for any OpenAI-compatible chat-completions endpoint. The caller must send only data the restaurant already publishes (menu, hours...).
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name: string;
  constructor(private readonly config: Config, name = 'openai-compatible') { this.name = name; }

  async answer(request: AiRequest): Promise<string | null> { return (await this.answerDetailed(request))?.text ?? null; }

  async answerDetailed({ system, question, model, maxTokens }: AiRequest): Promise<AiAnswer | null> {
    const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.config.model, temperature: 0.2, max_tokens: maxTokens ?? 400, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`AI provider error ${response.status}`);
    const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }>; usage?: { prompt_tokens?: number; completion_tokens?: number } };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text ? { text: text.slice(0, 1600), model: model ?? this.config.model, inputTokens: body.usage?.prompt_tokens ?? null, outputTokens: body.usage?.completion_tokens ?? null } : null;
  }
}

export class AnthropicProvider implements AiProvider {
  readonly name = 'anthropic';
  constructor(private readonly config: Config) {}

  async answer(request: AiRequest): Promise<string | null> { return (await this.answerDetailed(request))?.text ?? null; }

  async answerDetailed({ system, question, model, maxTokens }: AiRequest): Promise<AiAnswer | null> {
    const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': this.config.apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: model ?? this.config.model, max_tokens: maxTokens ?? 400, temperature: 0.2, system, messages: [{ role: 'user', content: question }] }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`AI provider error ${response.status}`);
    const body = await response.json().catch(() => ({})) as { content?: Array<{ type?: string; text?: string }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const text = body.content?.filter(part => part.type === 'text').map(part => part.text ?? '').join('').trim();
    return text ? { text: text.slice(0, 1600), model: model ?? this.config.model, inputTokens: body.usage?.input_tokens ?? null, outputTokens: body.usage?.output_tokens ?? null } : null;
  }
}

export type ProviderSettings = { provider: AiProviderKey; apiKey: string; model: string; baseUrl?: string | null; fetchImpl?: typeof fetch; timeoutMs?: number };
export function buildProvider({ provider, apiKey, model, baseUrl, fetchImpl, timeoutMs }: ProviderSettings): AiProvider {
  const preset = AI_PRESETS[provider];
  const config: Config = { apiKey, model, baseUrl: baseUrl || preset.baseUrl, fetchImpl, timeoutMs };
  return preset.kind === 'anthropic' ? new AnthropicProvider(config) : new OpenAiCompatibleProvider(config, provider === 'openai' || provider === 'custom' ? 'openai-compatible' : provider);
}

// Environment configuration: AI_API_KEY and AI_MODEL are required; AI_PROVIDER (openai|anthropic|gemini|groq|openrouter|custom) picks the preset and
// AI_BASE_URL overrides the endpoint (any OpenAI-compatible server). Without AI_PROVIDER, AI_BASE_URL decides (default OpenAI).
export function aiProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider | null {
  const { AI_API_KEY: apiKey, AI_MODEL: model, AI_BASE_URL: baseUrl, AI_PROVIDER: kind } = env;
  if (!apiKey || !model) return null;
  const provider: AiProviderKey = kind && isProviderKey(kind) ? kind : 'openai';
  return buildProvider({ provider, apiKey, model, baseUrl });
}

// ---- Platform configuration chosen by the master admin (stored encrypted in the database; the key never leaves the server) ----
const AI_SECRET_ENV = ['AI_CONFIG_ENCRYPTION_KEY', 'MFA_ENCRYPTION_KEY'];
export const sealAiKey = (apiKey: string) => sealWith('rm-ai-provider-key', AI_SECRET_ENV, apiKey);
export const openAiKey = (sealed: string) => openWith('rm-ai-provider-key', AI_SECRET_ENV, sealed);

type StoredConfig = { provider: AiProviderKey; model: string; baseUrl: string | null; instance: AiProvider; validatedAt: Date | null; lastError: string | null };
let stored: StoredConfig | null = null;
let override: AiProvider | null | undefined;

// Reads the platform configuration into memory (called at startup, after every change and periodically so API and worker agree).
export async function refreshAiConfig(prisma: PrismaClient): Promise<StoredConfig | null> {
  const row = await prisma.platformAiConfig.findUnique({ where: { id: 'default' } });
  if (!row || !isProviderKey(row.provider)) { stored = null; return null; }
  try {
    stored = { provider: row.provider, model: row.model, baseUrl: row.baseUrl, validatedAt: row.validatedAt, lastError: row.lastError, instance: buildProvider({ provider: row.provider, apiKey: openAiKey(row.apiKeyEnc), model: row.model, baseUrl: row.baseUrl }) };
  } catch (error) {
    stored = null; console.error('AI platform config could not be opened:', error instanceof Error ? error.message : error);
  }
  return stored;
}
export function startAiConfigRefresh(prisma: PrismaClient, everyMs = 60_000) {
  const run = () => refreshAiConfig(prisma).catch(error => console.error('AI config refresh failed:', error instanceof Error ? error.message : error));
  void run();
  const timer = setInterval(run, everyMs); timer.unref();
  return () => clearInterval(timer);
}

// Tests (and custom deployments) can inject a provider.
export function setAiProvider(provider: AiProvider | null | undefined) { override = provider; }
// Precedence: injected provider, then what the administrator saved in the platform panel, then the environment.
export function currentAiProvider(): AiProvider | null { return override !== undefined ? override : stored?.instance ?? aiProviderFromEnv(); }

export type AiSource = 'injected' | 'platform' | 'environment' | 'none';
export function aiSource(env: NodeJS.ProcessEnv = process.env): { source: AiSource; provider: string | null; model: string | null; baseUrl: string | null; validatedAt: Date | null; lastError: string | null } {
  if (override !== undefined) return { source: override ? 'injected' : 'none', provider: override?.name ?? null, model: null, baseUrl: null, validatedAt: null, lastError: null };
  if (stored) return { source: 'platform', provider: stored.provider, model: stored.model, baseUrl: stored.baseUrl, validatedAt: stored.validatedAt, lastError: stored.lastError };
  if (aiProviderFromEnv(env)) return { source: 'environment', provider: env.AI_PROVIDER && isProviderKey(env.AI_PROVIDER) ? env.AI_PROVIDER : 'openai', model: env.AI_MODEL ?? null, baseUrl: env.AI_BASE_URL ?? null, validatedAt: null, lastError: null };
  return { source: 'none', provider: null, model: null, baseUrl: null, validatedAt: null, lastError: null };
}
