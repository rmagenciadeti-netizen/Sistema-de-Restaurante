import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { UserRole } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { signAccessToken } from '../middleware/auth';
import { loadSettings, saveSettingsSection } from '../lib/settings';
import { processInbound } from '../lib/whatsapp-inbound';
import { WhatsappSessionManager } from '../lib/whatsapp-sessions';
import { enqueueAutoMessage } from '../lib/whatsapp-auto';
import { setAiProvider } from '../lib/ai-provider';
import type { TransportHandlers, WaTransport } from '../lib/whatsapp-transport';

// Needs a migrated PostgreSQL database; CI sets RUN_DB_TESTS=1 after `prisma migrate deploy`.
const enabled = process.env.RUN_DB_TESTS === '1';
const suffix = () => randomBytes(4).toString('hex');

class FakeTransport implements WaTransport {
  handlers!: TransportHandlers; sent: { jid: string; text: string }[] = []; stopped: { logout?: boolean } | null = null;
  async start(handlers: TransportHandlers) { this.handlers = handlers; }
  async sendText(jid: string, text: string) { this.sent.push({ jid, text }); return `fake-${this.sent.length}`; }
  async resolveJid(digits: string) { return digits.startsWith('5599') ? null : `${digits}@s.whatsapp.net`; }
  async stop(options?: { logout?: boolean }) { this.stopped = options ?? {}; }
}
async function waitFor<T>(check: () => Promise<T | null | false | undefined>, ms = 4000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('waitFor timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('WhatsApp bot, QR session manager and panel API', { skip: !enabled }, async t => {
  process.env.JWT_SECRET = 'b'.repeat(32);
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.RM_ADMIN_URL = 'https://admin.example';
  process.env.WHATSAPP_SESSION_DIR = path.join(os.tmpdir(), `rm-wa-${suffix()}`);
  const { app } = await import('../index');
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  const call = async (method: string, route: string, token?: string, body?: unknown) => {
    const response = await fetch(base + route, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { status: response.status, body: (response.status === 204 ? null : await response.json().catch(() => null)) as any };
  };

  const id = suffix();
  const tenant = await prisma.tenant.create({ data: { name: `Cantina ${id}`, slug: `cantina-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `Outra ${id}`, slug: `outra-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz', address: 'Rua das Flores, 10' } });
  const mkToken = async (tenantId: string, role: UserRole) => {
    const user = await prisma.user.create({ data: { tenantId, name: `${role} ${suffix()}`, email: `${role}-${suffix()}@test.local`, passwordHash: 'x', role } });
    return signAccessToken({ userId: user.id, tenantId, unitId: null, role });
  };
  const admin = await mkToken(tenant.id, UserRole.ADMIN);
  const waiter = await mkToken(tenant.id, UserRole.WAITER);
  const cashier = await mkToken(tenant.id, UserRole.CASHIER);
  const otherAdmin = await mkToken(other.id, UserRole.ADMIN);
  t.after(async () => {
    setAiProvider(undefined);
    await new Promise<void>(resolve => server.close(() => resolve()));
    await prisma.order.deleteMany({ where: { tenantId: { in: [tenant.id, other.id] } } });
    await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } });
    await prisma.$disconnect();
  });

  const category = await prisma.productCategory.create({ data: { tenantId: tenant.id, name: 'Lanches' } });
  const burger = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Hambúrguer Artesanal', description: 'Pão brioche e blend 180g', price: 32.9, categoryId: category.id } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Suco de laranja', price: 9.5 } });
  await prisma.deliveryZone.create({ data: { tenantId: tenant.id, name: 'Centro', fee: 5, minOrder: 20 } });
  await prisma.paymentMethodConfig.create({ data: { tenantId: tenant.id, name: 'PIX', equivalent: 'PIX' } });
  await prisma.promotion.create({ data: { tenantId: tenant.id, name: 'Promo', type: 'FIXED', value: 2.9, startsAt: new Date(Date.now() - 3600_000), products: { create: [{ productId: burger.id }] } } });
  await saveSettingsSection(prisma, tenant.id, 'company', { tradeName: 'Cantina Teste', address: 'Rua das Flores', number: '10', city: 'Sorriso', state: 'MT', phone: '66999990000' });
  await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true });
  const customer = await prisma.customer.create({ data: { tenantId: tenant.id, name: 'Maria Silva', phone: '5566999991111' } });
  await prisma.order.create({ data: { tenantId: tenant.id, unitId: unit.id, code: `P-${suffix()}`, number: 42, status: 'PREPARING', customerId: customer.id, subtotal: 32.9, total: 32.9 } });
  await prisma.whatsappKnowledge.create({ data: { tenantId: tenant.id, title: 'Estacionamento', keywords: ['estacionamento', 'estacionar'], answer: 'Temos estacionamento gratuito ao lado. 🚗' } });

  const jidMaria = '5566999991111@s.whatsapp.net';
  const say = (text: string, jid = jidMaria, phone: string | null = '5566999991111', name = 'Maria Silva') => processInbound(prisma, { tenantId: tenant.id, jid, phone, name, text, externalId: `m-${suffix()}` });
  const joined = (outcome: { replies: string[] }) => outcome.replies.join('\n');

  await t.test('answers about the restaurant with real data', async () => {
    const hello = await say('oi');
    assert.equal(hello.intent, 'welcome');
    assert.match(joined(hello), /Cantina Teste/);
    assert.match(joined(hello), /Cardápio/);
    const menu = await say('cardápio');
    assert.match(joined(menu), /Hambúrguer Artesanal — ~R\$ 32,90~ \*R\$ 30,00\*/); // promotion applied
    assert.match(joined(menu), /Suco de laranja — R\$ 9,50/);
    assert.match(joined(await say('quanto custa o hamburguer?')), /Pão brioche/);
    assert.match(joined(await say('qual o horário de vocês')), /abertos agora/);
    assert.match(joined(await say('onde fica?')), /Rua das Flores, 10 - Sorriso\/MT/);
    assert.match(joined(await say('qual a taxa de entrega?')), /Centro: R\$ 5,00 \(pedido mínimo R\$ 20,00\)/);
    assert.match(joined(await say('aceitam pix?')), /• PIX/);
    assert.match(joined(await say('quero fazer um pedido')), /https:\/\/restaurant\.example\/loja\/cantina-/);
    assert.match(joined(await say('tem estacionamento?')), /estacionamento gratuito/);
    assert.equal((await prisma.whatsappKnowledge.findFirstOrThrow({ where: { tenantId: tenant.id } })).hits, 1);
  });

  await t.test('order status is only disclosed to the phone that placed the order', async () => {
    assert.match(joined(await say('qual o status do meu pedido?')), /Pedido \*#42\*\nStatus: \*Em preparo\*/);
    assert.match(joined(await say('pedido 42', '5566888887777@s.whatsapp.net', '5566888887777', 'Outra')), /Não encontrei esse pedido neste número/);
    assert.match(joined(await say('status do pedido', '123456789@lid', null, 'Sem número')), /não consegui identificar o seu número/i);
  });

  await t.test('unknown questions are recorded and can use the AI fallback only when enabled', async () => {
    assert.equal((await say('vocês fazem festa de aniversário infantil?')).intent, 'fallback');
    const unanswered = await prisma.whatsappUnanswered.findMany({ where: { tenantId: tenant.id } });
    assert.equal(unanswered.length, 1);
    await say('vocês fazem festa de aniversário infantil?');
    assert.equal((await prisma.whatsappUnanswered.findFirstOrThrow({ where: { tenantId: tenant.id } })).count, 2);

    let received = '';
    setAiProvider({ name: 'fake', answer: async ({ system, question }) => { received = `${system}\n${question}`; return question.includes('casamento') ? 'Isso eu não sei. [ATENDENTE]' : 'Fazemos sim, consulte a gerência para valores!'; } });
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true, aiFallback: true });
    // The shared AI gate applies here too: without the company's consent the customer's text is not sent to the model.
    assert.equal((await say('vocês fazem festa de aniversário infantil?', '5566777776666@s.whatsapp.net', '5566777776666', 'Ana')).intent, 'fallback'); assert.equal(received, '');
    await saveSettingsSection(prisma, tenant.id, 'ai', { ...(await loadSettings(prisma, tenant.id)).ai, externalConsent: true });
    const ai = await say('vocês fazem festa de aniversário infantil?', '5566777776666@s.whatsapp.net', '5566777776666', 'Ana');
    assert.equal(ai.intent, 'ai');
    assert.match(joined(ai), /Fazemos sim/);
    assert.match(received, /Hambúrguer Artesanal/); // grounded with the menu
    const escalated = await say('vocês fazem casamento?', '5566777776666@s.whatsapp.net', '5566777776666', 'Ana');
    assert.ok(!joined(escalated).includes('[ATENDENTE]'));
    assert.equal((await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: '5566777776666@s.whatsapp.net' } })).handoff, true);
    setAiProvider(undefined);
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true });
  });

  await t.test('handoff silences the bot, opt-out stops messages, disabled bot stays quiet', async () => {
    const jid = '5566555554444@s.whatsapp.net';
    assert.equal((await say('quero falar com um atendente', jid, '5566555554444', 'Joao')).intent, 'handoff');
    assert.equal((await say('alguém aí?', jid, '5566555554444', 'Joao')).replies.length, 0);
    const conversation = await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid } });
    await prisma.whatsappConversation.update({ where: { id: conversation.id }, data: { handoffUntil: new Date(Date.now() - 1000) } });
    assert.ok((await say('cardápio', jid, '5566555554444', 'Joao')).replies.length > 0); // handoff expired

    const optJid = '5566444443333@s.whatsapp.net';
    assert.equal((await say('parar', optJid, '5566444443333', 'Leo')).intent, 'opt_out');
    assert.equal((await say('cardápio', optJid, '5566444443333', 'Leo')).replies.length, 0);
    assert.equal(await enqueueAutoMessage(prisma, { tenantId: tenant.id, key: 'order_ready', phone: '5566444443333', vars: {} }), false);
    assert.equal((await say('voltar', optJid, '5566444443333', 'Leo')).intent, 'opt_in');

    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: false });
    const silent = await say('oi', '5566333332222@s.whatsapp.net', '5566333332222', 'Zé');
    assert.equal(silent.replies.length, 0);
    assert.equal(await prisma.whatsappChatMessage.count({ where: { tenantId: tenant.id, direction: 'IN', body: 'oi', conversation: { jid: '5566333332222@s.whatsapp.net' } } }), 1);
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true });
  });

  await t.test('guided reservation creates a pending reservation only after confirmation', async () => {
    const jid = '5566222221111@s.whatsapp.net'; const phone = '5566222221111';
    const step = async (text: string) => { const row = await prisma.whatsappConversation.findFirst({ where: { tenantId: tenant.id, jid } }); return { out: await say(text, jid, phone, 'Carla'), row }; };
    assert.match(joined((await step('quero reservar uma mesa')).out), /Para quantas pessoas/);
    assert.match(joined((await step('4')).out), /dia e horário/);
    assert.match(joined((await step('ontem às 20h')).out), /Não entendi o dia|passou/);
    const confirm = joined((await step('amanhã 20:00')).out);
    assert.match(confirm, /Confirma a reserva para \*4 pessoa\(s\)\*/);
    assert.equal(await prisma.reservation.count({ where: { tenantId: tenant.id } }), 0);
    assert.match(joined((await step('sim')).out), /Pedido de reserva recebido/);
    const reservation = await prisma.reservation.findFirstOrThrow({ where: { tenantId: tenant.id } });
    assert.equal(reservation.partySize, 4); assert.equal(reservation.status, 'PENDING'); assert.equal(reservation.phone, phone);
  });

  await t.test('QR session manager connects, answers customers and sends queued automatic messages', async () => {
    const transports: FakeTransport[] = [];
    const manager = new WhatsappSessionManager(prisma, { factory: () => { const fake = new FakeTransport(); transports.push(fake); return fake; }, sleep: async () => undefined, log: () => undefined });
    t.after(() => manager.stop());
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true, replyDelaySeconds: 0, humanizeTyping: false });

    await prisma.whatsappManager.deleteMany();
    assert.equal((await call('GET', '/whatsapp/session', admin)).body.managerOnline, false);
    assert.equal((await call('GET', '/whatsapp/session', waiter)).status, 403); // waiters have no access to the panel
    assert.equal((await call('POST', '/whatsapp/session/connect', cashier)).status, 403);
    assert.equal((await call('POST', '/whatsapp/session/connect', admin)).status, 202);
    await manager.tick();
    assert.equal(transports.length, 1);
    transports[0].handlers.onQr('2@fake-qr-string');
    const waiting = await waitFor(async () => { const view = (await call('GET', '/whatsapp/session', admin)).body; return view.status === 'QR_READY' ? view : null; });
    assert.equal(waiting.qr, '2@fake-qr-string'); assert.equal(waiting.managerOnline, true);
    assert.equal((await call('GET', '/whatsapp/session', otherAdmin)).body.qr, null); // other tenant never sees the QR

    transports[0].handlers.onOpen({ phone: '5566900001111', name: 'Cantina' });
    const connected = await waitFor(async () => { const view = (await call('GET', '/whatsapp/session', admin)).body; return view.status === 'CONNECTED' ? view : null; });
    assert.equal(connected.qr, null); assert.equal(connected.phone, '5566900001111');

    const jid = '5566111110000@s.whatsapp.net';
    transports[0].handlers.onMessage({ jid, phone: '5566111110000', name: 'Pedro', text: 'olá, qual o cardápio?', id: `wa-${suffix()}`, timestamp: Math.floor(Date.now() / 1000) });
    await waitFor(async () => transports[0].sent.length > 0);
    assert.match(transports[0].sent[0].text, /Hambúrguer Artesanal/);
    assert.equal(await prisma.whatsappChatMessage.count({ where: { tenantId: tenant.id, source: 'BOT', conversation: { jid } } }) > 0, true);
    transports[0].handlers.onMessage({ jid, phone: '5566111110000', name: 'Pedro', text: 'antiga', id: 'old', timestamp: Math.floor(Date.now() / 1000) - 3600 });

    // Automatic notices go through the same session; order_received is on by default.
    assert.equal(await enqueueAutoMessage(prisma, { tenantId: tenant.id, key: 'order_ready', phone: '66999991111', vars: { nome: 'Maria', pedido: '#42', orderCode: 'P-1', customerName: 'Maria Silva' } }), true);
    await prisma.whatsappMessage.create({ data: { tenantId: tenant.id, toPhone: '5566999992222', template: 'free_text', payload: { text: 'Olá do atendente!' } } });
    await prisma.whatsappMessage.create({ data: { tenantId: tenant.id, toPhone: '5599000000000', template: 'free_text', payload: { text: 'sem whatsapp' } } });
    await manager.tick();
    const texts = transports[0].sent.map(entry => entry.text);
    assert.ok(texts.includes('Maria, seu pedido *#42* está pronto! ✅'));
    assert.ok(texts.includes('Olá do atendente!'));
    assert.equal((await prisma.whatsappMessage.findFirstOrThrow({ where: { tenantId: tenant.id, toPhone: '5599000000000' } })).error, 'NOT_ON_WHATSAPP');
    assert.equal(transports[0].sent.find(entry => entry.text === 'Maria, seu pedido *#42* está pronto! ✅')?.jid, '5566999991111@s.whatsapp.net'); // 11-digit number got the country code

    // Master switch off: no new automatic messages, queued ones are not sent.
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true, autoMessagesEnabled: false });
    assert.equal(await enqueueAutoMessage(prisma, { tenantId: tenant.id, key: 'order_ready', phone: '66999991111', vars: {} }), false);

    assert.equal((await call('POST', '/whatsapp/session/disconnect', admin, { logout: true })).status, 202);
    await manager.tick();
    assert.deepEqual(transports[0].stopped, { logout: true });
    assert.equal((await call('GET', '/whatsapp/session', admin)).body.status, 'LOGGED_OUT');
  });

  await t.test('stale queued messages expire instead of being sent days later', async () => {
    const fake = new FakeTransport();
    const manager = new WhatsappSessionManager(prisma, { factory: () => fake, sleep: async () => undefined, log: () => undefined });
    t.after(() => manager.stop());
    await prisma.whatsappSession.update({ where: { tenantId: tenant.id }, data: { desired: 'CONNECTED' } });
    await manager.tick(); fake.handlers.onOpen({ phone: '5566900001111', name: 'Cantina' }); await new Promise(resolve => setTimeout(resolve, 50));
    const old = await prisma.whatsappMessage.create({ data: { tenantId: tenant.id, toPhone: '5566999992222', template: 'free_text', payload: { text: 'velha' }, createdAt: new Date(Date.now() - 3 * 3600_000) } });
    await manager.processOutbox();
    assert.equal((await prisma.whatsappMessage.findUniqueOrThrow({ where: { id: old.id } })).error, 'EXPIRED');
    assert.equal(fake.sent.length, 0);
  });

  await t.test('panel API: auto messages, knowledge base, simulator, conversations, tenant isolation', async () => {
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true });
    const list = await call('GET', '/whatsapp/auto-messages', cashier);
    assert.equal(list.status, 200); assert.ok(list.body.items.some((item: any) => item.key === 'order_ready' && item.enabled));
    assert.equal((await call('PUT', '/whatsapp/auto-messages/order_ready', cashier, { enabled: false, body: 'x' })).status, 403);
    assert.equal((await call('PUT', '/whatsapp/auto-messages/order_ready', admin, { enabled: true, body: 'Oi {{segredo}}' })).status, 400);
    assert.equal((await call('PUT', '/whatsapp/auto-messages/nope', admin, { enabled: true, body: 'x' })).status, 404);
    const saved = await call('PUT', '/whatsapp/auto-messages/order_ready', admin, { enabled: true, body: '{{nome}}, pedido {{pedido}} pronto!' });
    assert.equal(saved.body.body, '{{nome}}, pedido {{pedido}} pronto!');
    assert.equal((await call('POST', '/whatsapp/auto-messages/order_ready/reset', admin)).body.body, saved.body.defaultBody);

    const created = await call('POST', '/whatsapp/knowledge', admin, { title: 'Wi-Fi', keywords: ['wifi', 'wi-fi', 'internet'], answer: 'Senha do Wi-Fi: cantina123' });
    assert.equal(created.status, 201);
    assert.equal((await call('GET', '/whatsapp/knowledge', otherAdmin)).body.total, 0);
    assert.equal((await call('DELETE', `/whatsapp/knowledge/${created.body.id}`, otherAdmin)).status, 404);
    assert.equal((await call('POST', '/whatsapp/knowledge', cashier, { title: 'x', keywords: ['x'], answer: 'x' })).status, 403);
    const sim = await call('POST', '/whatsapp/bot/simulate', admin, { text: 'tem wifi aí?' });
    assert.equal(sim.body.intent, 'knowledge'); assert.match(sim.body.replies[0], /cantina123/);
    const reserve = await call('POST', '/whatsapp/bot/simulate', admin, { text: 'quero reservar' });
    assert.equal(reserve.body.state.step, 'RESERVE_PEOPLE');
    const before = await prisma.reservation.count({ where: { tenantId: tenant.id } });
    const done = await call('POST', '/whatsapp/bot/simulate', admin, { text: 'sim', state: { step: 'RESERVE_CONFIRM', people: 2, at: new Date(Date.now() + 86_400_000).toISOString() } });
    assert.match(done.body.replies[0], /simulação/);
    assert.equal(await prisma.reservation.count({ where: { tenantId: tenant.id } }), before); // simulation writes nothing

    const conversations = await call('GET', '/whatsapp/conversations?filter=all', cashier);
    assert.ok(conversations.body.total > 3);
    assert.equal((await call('GET', '/whatsapp/conversations', otherAdmin)).body.total, 0);
    const maria = conversations.body.items.find((item: any) => item.phone === '5566999991111');
    assert.ok(maria.unread > 0);
    const messages = await call('GET', `/whatsapp/conversations/${maria.id}/messages`, cashier);
    assert.ok(messages.body.items.some((item: any) => item.direction === 'IN') && messages.body.items.some((item: any) => item.source === 'AUTO'));
    assert.equal((await call('GET', `/whatsapp/conversations/${maria.id}/messages`, otherAdmin)).status, 404);
    const sent = await call('POST', `/whatsapp/conversations/${maria.id}/messages`, cashier, { text: 'Oi Maria, tudo bem?' });
    assert.equal(sent.status, 202);
    const queued = await prisma.whatsappMessage.findFirstOrThrow({ where: { tenantId: tenant.id, template: 'free_text', toPhone: '5566999991111' } });
    assert.deepEqual(queued.payload, { text: 'Oi Maria, tudo bem?' });
    assert.equal((await call('PATCH', `/whatsapp/conversations/${maria.id}`, cashier, { handoff: false })).body.handoff, false);
    const stats = await call('GET', '/whatsapp/stats', cashier);
    assert.ok(stats.body.conversations > 3 && stats.body.inboundToday > 5);
  });

  await t.test('order events queue automatic messages with the editable texts', async () => {
    await prisma.whatsappMessage.deleteMany({ where: { tenantId: tenant.id } });
    await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true, autoMessagesEnabled: true });
    await saveSettingsSection(prisma, tenant.id, 'pdv', { whatsappNotify: false });
    const silentOrder = await call('POST', '/orders', admin, { unitId: unit.id, channel: 'TAKEAWAY', customerName: 'Rita Souza', customerPhone: '66988887777', items: [{ productId: burger.id, quantity: 1 }] });
    assert.equal(silentOrder.status, 201);
    assert.equal(await prisma.whatsappMessage.count({ where: { tenantId: tenant.id, template: 'order_received' } }), 0, 'PDV notification setting suppresses the automatic message');
    await saveSettingsSection(prisma, tenant.id, 'pdv', { whatsappNotify: true });
    const order = await call('POST', '/orders', admin, { unitId: unit.id, channel: 'TAKEAWAY', customerName: 'Rita Souza', customerPhone: '66988887777', items: [{ productId: burger.id, quantity: 1 }] });
    assert.equal(order.status, 201);
    const received = await prisma.whatsappMessage.findFirstOrThrow({ where: { tenantId: tenant.id, template: 'order_received' } });
    assert.equal((received.payload as any).nome, 'Rita');
    for (const status of ['PREPARING', 'READY']) assert.equal((await call('PATCH', `/orders/${order.body.id}/status`, admin, { status })).status, 200);
    assert.equal(await prisma.whatsappMessage.count({ where: { tenantId: tenant.id, template: 'order_ready' } }), 1);
    assert.equal(await prisma.whatsappMessage.count({ where: { tenantId: tenant.id, template: 'order_preparing' } }), 0); // off by default
  });
});
