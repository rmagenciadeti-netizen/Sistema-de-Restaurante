// Provider-neutral chat with tool calling. The agent talks only in these types; the adapters below translate them to the wire format of each provider
// (OpenAI-compatible chat-completions and Anthropic Messages), so switching provider or model never changes how the attendant works.
export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type ToolCall = { id: string; name: string; arguments: Record<string, unknown>; parseError?: string };
export type ChatMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: ToolCall[] }
  | { role: 'tool'; toolCallId: string; name: string; content: string };
export type ChatRequest = { system: string; messages: ChatMessage[]; tools?: ToolSpec[]; model?: string; maxTokens?: number; temperature?: number; timeoutMs?: number };
export type ChatFinish = 'stop' | 'tool_calls' | 'length' | 'other';
export type ChatResponse = { text: string | null; toolCalls: ToolCall[]; finish: ChatFinish; model: string; inputTokens: number | null; outputTokens: number | null };

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export function parseToolArguments(raw: unknown): { arguments: Record<string, unknown>; parseError?: string } {
  if (raw && typeof raw === 'object') return { arguments: asObject(raw) };
  if (typeof raw !== 'string' || raw.trim() === '') return { arguments: {} };
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? { arguments: parsed as Record<string, unknown> } : { arguments: {}, parseError: 'arguments must be a JSON object' };
  } catch { return { arguments: {}, parseError: 'arguments are not valid JSON' }; }
}

// ---- OpenAI-compatible (OpenAI, Gemini, Groq, OpenRouter, GitHub Models, Ollama, vLLM, ...) ----
export function toOpenAiMessages(system: string, messages: ChatMessage[]) {
  const out: Record<string, unknown>[] = [{ role: 'system', content: system }];
  for (const message of messages) {
    if (message.role === 'user') out.push({ role: 'user', content: message.content });
    else if (message.role === 'assistant') {
      out.push({
        role: 'assistant', content: message.content ?? null,
        ...(message.toolCalls?.length ? { tool_calls: message.toolCalls.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) } : {}),
      });
    } else out.push({ role: 'tool', tool_call_id: message.toolCallId, content: message.content });
  }
  return out;
}
export const toOpenAiTools = (tools: ToolSpec[]) => tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));

type OpenAiBody = { choices?: Array<{ finish_reason?: string | null; message?: { content?: string | null; tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }> } }>; usage?: { prompt_tokens?: number; completion_tokens?: number }; model?: string };
export function parseOpenAiResponse(body: unknown, fallbackModel: string): ChatResponse {
  const data = asObject(body) as OpenAiBody;
  const choice = data.choices?.[0];
  const calls = (choice?.message?.tool_calls ?? []).filter(call => call.function?.name).map((call, index) => {
    const args = parseToolArguments(call.function?.arguments);
    return { id: call.id || `call_${index}`, name: String(call.function!.name), arguments: args.arguments, ...(args.parseError ? { parseError: args.parseError } : {}) };
  });
  const text = typeof choice?.message?.content === 'string' ? choice.message.content.trim() : '';
  const finish: ChatFinish = calls.length ? 'tool_calls' : choice?.finish_reason === 'length' ? 'length' : choice?.finish_reason === 'stop' || choice?.finish_reason == null ? 'stop' : 'other';
  return { text: text || null, toolCalls: calls, finish, model: data.model || fallbackModel, inputTokens: data.usage?.prompt_tokens ?? null, outputTokens: data.usage?.completion_tokens ?? null };
}

// ---- Anthropic Messages ----
type AnthropicBlock = Record<string, unknown>;
export function toAnthropicMessages(messages: ChatMessage[]) {
  const out: { role: 'user' | 'assistant'; content: AnthropicBlock[] }[] = [];
  // The API requires alternating roles: consecutive user turns and consecutive tool results share one message.
  const push = (role: 'user' | 'assistant', blocks: AnthropicBlock[]) => {
    if (blocks.length === 0) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks); else out.push({ role, content: [...blocks] });
  };
  for (const message of messages) {
    if (message.role === 'user') push('user', message.content.trim() ? [{ type: 'text', text: message.content }] : []);
    else if (message.role === 'assistant') {
      const blocks: AnthropicBlock[] = [];
      if (message.content?.trim()) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments });
      push('assistant', blocks);
    } else push('user', [{ type: 'tool_result', tool_use_id: message.toolCallId, content: message.content }]);
  }
  // Tool results must come before any text of the same user turn.
  for (const message of out) if (message.role === 'user') message.content.sort((a, b) => Number(b.type === 'tool_result') - Number(a.type === 'tool_result'));
  return out;
}
export const toAnthropicTools = (tools: ToolSpec[]) => tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }));

type AnthropicBody = { content?: Array<{ type?: string; text?: string; id?: string; name?: string; input?: unknown }>; stop_reason?: string | null; usage?: { input_tokens?: number; output_tokens?: number }; model?: string };
export function parseAnthropicResponse(body: unknown, fallbackModel: string): ChatResponse {
  const data = asObject(body) as AnthropicBody;
  const blocks = data.content ?? [];
  const calls = blocks.filter(block => block.type === 'tool_use' && block.name).map((block, index) => {
    const args = parseToolArguments(block.input);
    return { id: block.id || `toolu_${index}`, name: String(block.name), arguments: args.arguments, ...(args.parseError ? { parseError: args.parseError } : {}) };
  });
  const text = blocks.filter(block => block.type === 'text').map(block => block.text ?? '').join('').trim();
  const finish: ChatFinish = calls.length ? 'tool_calls' : data.stop_reason === 'max_tokens' ? 'length' : data.stop_reason === 'end_turn' || data.stop_reason === 'stop_sequence' || data.stop_reason == null ? 'stop' : 'other';
  return { text: text || null, toolCalls: calls, finish, model: data.model || fallbackModel, inputTokens: data.usage?.input_tokens ?? null, outputTokens: data.usage?.output_tokens ?? null };
}

// Some OpenAI-compatible models reject `max_tokens` (newer OpenAI families want `max_completion_tokens`) or a custom temperature. The first rejection teaches
// the adapter, once per endpoint and model, so every later call goes through. Only the rejection reason is read; nothing else of the body is kept.
export type OpenAiQuirks = { tokenParam: 'max_tokens' | 'max_completion_tokens'; temperature: boolean };
const quirks = new Map<string, OpenAiQuirks>();
export const quirksFor = (baseUrl: string, model: string): OpenAiQuirks => quirks.get(`${baseUrl}|${model}`) ?? { tokenParam: 'max_tokens', temperature: true };
export function learnQuirks(baseUrl: string, model: string, rejection: string): boolean {
  const current = quirksFor(baseUrl, model);
  const next = { ...current };
  if (/max_completion_tokens/i.test(rejection) && current.tokenParam !== 'max_completion_tokens') next.tokenParam = 'max_completion_tokens';
  else if (/temperature/i.test(rejection) && current.temperature) next.temperature = false;
  if (next.tokenParam === current.tokenParam && next.temperature === current.temperature) return false;
  quirks.set(`${baseUrl}|${model}`, next);
  return true;
}
export const resetQuirks = () => quirks.clear();
