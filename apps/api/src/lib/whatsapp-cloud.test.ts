import test from 'node:test';
import assert from 'node:assert/strict';
import { WhatsappCloudProvider, whatsappProviderFromEnv } from './whatsapp-cloud';

const templates = { order_ready: { name: 'pedido_pronto', language: 'pt_BR', params: ['customerName', 'orderCode'] } };

test('sends an approved template with ordered body parameters and returns the provider message id', async () => {
  let call: { url: string; init: RequestInit } | undefined;
  const provider = new WhatsappCloudProvider({ token: 'tok', phoneNumberId: '123', templates, fetchImpl: (async (url: string, init: RequestInit) => { call = { url, init }; return new Response(JSON.stringify({ messages: [{ id: 'wamid.X' }] }), { status: 200 }); }) as typeof fetch });
  const result = await provider.send({ id: '1', tenantId: 't', toPhone: '5511999990001', template: 'order_ready', payload: { orderCode: 'P-9', customerName: 'Maria' } });
  assert.equal(result.providerRef, 'wamid.X');
  assert.match(call!.url, /graph\.facebook\.com\/v[\d.]+\/123\/messages$/);
  assert.equal((call!.init.headers as Record<string, string>).authorization, 'Bearer tok');
  const body = JSON.parse(call!.init.body as string);
  assert.equal(body.to, '5511999990001');
  assert.deepEqual(body.template.components[0].parameters.map((p: any) => p.text), ['Maria', 'P-9']);
});

test('unknown templates and API errors are surfaced instead of being treated as sent', async () => {
  const failing = new WhatsappCloudProvider({ token: 't', phoneNumberId: '1', templates, fetchImpl: (async () => new Response(JSON.stringify({ error: { message: 'Invalid token' } }), { status: 401 })) as typeof fetch });
  await assert.rejects(failing.send({ id: '1', tenantId: 't', toPhone: '1', template: 'order_ready', payload: {} }), /401.*Invalid token/);
  await assert.rejects(failing.send({ id: '1', tenantId: 't', toPhone: '1', template: 'missing', payload: {} }), /No WhatsApp template/);
});

test('provider is only created when fully configured', () => {
  assert.equal(whatsappProviderFromEnv({}), null);
  assert.ok(whatsappProviderFromEnv({ WHATSAPP_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: 'b', WHATSAPP_TEMPLATES: JSON.stringify(templates) }));
  assert.throws(() => whatsappProviderFromEnv({ WHATSAPP_TOKEN: 'a', WHATSAPP_PHONE_NUMBER_ID: 'b', WHATSAPP_TEMPLATES: '{bad' }), /valid JSON/);
});
