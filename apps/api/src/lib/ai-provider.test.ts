import test from 'node:test';
import assert from 'node:assert/strict';
import { aiProviderFromEnv, OpenAiCompatibleProvider } from './ai-provider';

test('AI provider is only created when key and model are configured', () => {
  assert.equal(aiProviderFromEnv({}), null);
  assert.equal(aiProviderFromEnv({ AI_API_KEY: 'k' }), null);
  assert.ok(aiProviderFromEnv({ AI_API_KEY: 'k', AI_MODEL: 'm' }));
});

test('OpenAI-compatible adapter sends system+question and returns trimmed text; errors propagate', async () => {
  let captured: { url: string; body: any; auth: string | null } | null = null;
  const ok = new OpenAiCompatibleProvider({ apiKey: 'secret', model: 'm1', baseUrl: 'https://llm.example/v1/', fetchImpl: (async (url: string, init: RequestInit) => {
    captured = { url, body: JSON.parse(String(init.body)), auth: new Headers(init.headers).get('authorization') };
    return new Response(JSON.stringify({ choices: [{ message: { content: '  Olá!  ' } }] }), { status: 200 });
  }) as unknown as typeof fetch });
  assert.equal(await ok.answer({ system: 'S', question: 'Q' }), 'Olá!');
  assert.equal(captured!.url, 'https://llm.example/v1/chat/completions');
  assert.equal(captured!.auth, 'Bearer secret');
  assert.deepEqual(captured!.body.messages, [{ role: 'system', content: 'S' }, { role: 'user', content: 'Q' }]);
  const bad = new OpenAiCompatibleProvider({ apiKey: 'k', model: 'm', baseUrl: 'https://x', fetchImpl: (async () => new Response('{}', { status: 500 })) as unknown as typeof fetch });
  await assert.rejects(bad.answer({ system: 'S', question: 'Q' }));
});
