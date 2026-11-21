import assert from 'node:assert/strict';
import test from 'node:test';
import { AnthropicProvider, OpenAiCompatibleProvider } from '../ai-provider';
import { learnQuirks, parseAnthropicResponse, parseOpenAiResponse, resetQuirks, toAnthropicMessages, toOpenAiMessages, type ChatMessage } from './chat';

const tools = [{ name: 'search_menu', description: 'x', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];
const convo: ChatMessage[] = [
  { role: 'user', content: 'quero um hambúrguer' }, { role: 'user', content: 'e a taxa?' },
  { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'search_menu', arguments: { query: 'hambúrguer' } }, { id: 'c2', name: 'quote_delivery', arguments: {} }] },
  { role: 'tool', toolCallId: 'c1', name: 'search_menu', content: '{"ok":true}' }, { role: 'tool', toolCallId: 'c2', name: 'quote_delivery', content: '{"ok":true}' },
];

test('OpenAI wire format: tool calls, tool results and response parsing (invalid JSON arguments are reported, not thrown)', () => {
  const wire = toOpenAiMessages('SYS', convo) as any[];
  assert.deepEqual(wire.map(m => m.role), ['system', 'user', 'user', 'assistant', 'tool', 'tool']);
  assert.equal(wire[3].tool_calls[0].function.arguments, '{"query":"hambúrguer"}');
  assert.equal(wire[4].tool_call_id, 'c1');
  const parsed = parseOpenAiResponse({ model: 'm', choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'a', function: { name: 'search_menu', arguments: '{"query":"suco"}' } }, { id: 'b', function: { name: 'x', arguments: '{oops' } }] } }], usage: { prompt_tokens: 11, completion_tokens: 7 } }, 'fallback');
  assert.equal(parsed.finish, 'tool_calls'); assert.deepEqual(parsed.toolCalls[0].arguments, { query: 'suco' }); assert.ok(parsed.toolCalls[1].parseError);
  assert.deepEqual([parsed.inputTokens, parsed.outputTokens, parsed.model], [11, 7, 'm']);
  assert.equal(parseOpenAiResponse({ choices: [{ finish_reason: 'stop', message: { content: ' Olá! ' } }] }, 'f').text, 'Olá!');
});

test('Anthropic wire format: alternating roles, grouped tool results, tool_use parsing', () => {
  const wire = toAnthropicMessages(convo);
  assert.deepEqual(wire.map(m => m.role), ['user', 'assistant', 'user']);
  assert.equal(wire[0].content.length, 2, 'consecutive customer messages share one turn');
  assert.deepEqual(wire[1].content.map(b => b.type), ['tool_use', 'tool_use']);
  assert.deepEqual(wire[2].content.map(b => b.type), ['tool_result', 'tool_result']);
  const parsed = parseAnthropicResponse({ stop_reason: 'tool_use', content: [{ type: 'text', text: 'vou ver' }, { type: 'tool_use', id: 't1', name: 'search_menu', input: { query: 'x' } }], usage: { input_tokens: 5, output_tokens: 3 } }, 'claude');
  assert.equal(parsed.finish, 'tool_calls'); assert.equal(parsed.toolCalls[0].id, 't1'); assert.equal(parsed.text, 'vou ver');
});

test('providers send tools and survive models that reject max_tokens or temperature (learned once per model)', async () => {
  resetQuirks();
  const bodies: any[] = [];
  const fetchImpl = (async (_url: string, init: { body: string }) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if ('max_tokens' in body) return new Response(JSON.stringify({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }), { status: 400 });
    if ('temperature' in body) return new Response(JSON.stringify({ error: { message: "Unsupported value: 'temperature' does not support 0.3 with this model." } }), { status: 400 });
    return new Response(JSON.stringify({ model: 'gpt-x', choices: [{ finish_reason: 'stop', message: { content: 'ok' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
  const provider = new OpenAiCompatibleProvider({ apiKey: 'k', model: 'gpt-x', baseUrl: 'https://x.example/v1', fetchImpl });
  const answer = await provider.chat({ system: 's', messages: [{ role: 'user', content: 'oi' }], tools });
  assert.equal(answer.text, 'ok');
  assert.ok(bodies.at(-1).max_completion_tokens && !('max_tokens' in bodies.at(-1)) && !('temperature' in bodies.at(-1)));
  assert.equal(bodies.at(-1).tools[0].function.name, 'search_menu');
  const before = bodies.length; await provider.chat({ system: 's', messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(bodies.length, before + 1, 'learned: the next call is accepted at once');
  assert.equal(learnQuirks('u', 'm', 'something unrelated'), false);
  await assert.rejects(new OpenAiCompatibleProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x.example/v1', fetchImpl: (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch }).chat({ system: 's', messages: [{ role: 'user', content: 'oi' }] }), /AI provider error 401/);
  let sent: any;
  const anthropic = new AnthropicProvider({ apiKey: 'k', model: 'claude', baseUrl: 'https://a.example', fetchImpl: (async (_u: string, init: { body: string }) => { sent = JSON.parse(init.body); return new Response(JSON.stringify({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'oi' }] }), { status: 200 }); }) as unknown as typeof fetch });
  assert.equal((await anthropic.chat({ system: 'S', messages: [{ role: 'user', content: 'oi' }], tools })).text, 'oi');
  assert.equal(sent.system, 'S'); assert.equal(sent.tools[0].input_schema.type, 'object');
});
