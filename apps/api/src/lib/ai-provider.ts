export type AiRequest = { system: string; question: string };
// Implemented by a concrete LLM adapter. Nothing is registered unless AI_API_KEY/AI_MODEL are set (see aiProviderFromEnv).
export interface AiProvider { readonly name: string; answer(request: AiRequest): Promise<string | null> }

type Config = { apiKey: string; model: string; baseUrl: string; fetchImpl?: typeof fetch; timeoutMs?: number };

// Adapter for any OpenAI-compatible chat-completions endpoint. The caller must send only data the restaurant already publishes (menu, hours...).
export class OpenAiCompatibleProvider implements AiProvider {
  readonly name = 'openai-compatible';
  constructor(private readonly config: Config) {}

  async answer({ system, question }: AiRequest): Promise<string | null> {
    const response = await (this.config.fetchImpl ?? fetch)(`${this.config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.config.apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: this.config.model, temperature: 0.2, max_tokens: 400, messages: [{ role: 'system', content: system }, { role: 'user', content: question }] }),
      signal: AbortSignal.timeout(this.config.timeoutMs ?? 15_000),
    });
    if (!response.ok) throw new Error(`AI provider error ${response.status}`);
    const body = await response.json().catch(() => ({})) as { choices?: Array<{ message?: { content?: string } }> };
    const text = body.choices?.[0]?.message?.content?.trim();
    return text ? text.slice(0, 1200) : null;
  }
}

export function aiProviderFromEnv(env: NodeJS.ProcessEnv = process.env): AiProvider | null {
  const { AI_API_KEY: apiKey, AI_MODEL: model, AI_BASE_URL: baseUrl } = env;
  if (!apiKey || !model) return null;
  return new OpenAiCompatibleProvider({ apiKey, model, baseUrl: baseUrl || 'https://api.openai.com/v1' });
}

let override: AiProvider | null | undefined;
// Tests (and custom deployments) can inject a provider.
export function setAiProvider(provider: AiProvider | null | undefined) { override = provider; }
export function currentAiProvider(): AiProvider | null { return override !== undefined ? override : aiProviderFromEnv(); }
