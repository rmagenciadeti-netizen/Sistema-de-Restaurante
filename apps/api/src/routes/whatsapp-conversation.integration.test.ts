import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { prisma } from '../lib/prisma';
import { saveSettingsSection } from '../lib/settings';
import { processInbound, recordOutbound } from '../lib/whatsapp-inbound';
import { WhatsappSessionManager } from '../lib/whatsapp-sessions';
import { setAiProvider } from '../lib/ai-provider';
import type { TransportHandlers, WaTransport } from '../lib/whatsapp-transport';

// Needs a migrated PostgreSQL database (RUN_DB_TESTS=1). No AI is configured here: this is the conversation the customer gets when the AI attendant is off or fails,
// and it must be just as free — any subject at any time, several questions at once, bookings that wait instead of trapping the customer.
const enabled = process.env.RUN_DB_TESTS === '1';
const sfx = () => randomBytes(4).toString('hex');

class FakeTransport implements WaTransport {
  handlers!: TransportHandlers; sent: { jid: string; text: string }[] = [];
  async start(handlers: TransportHandlers) { this.handlers = handlers; }
  async sendText(jid: string, text: string) { this.sent.push({ jid, text }); return `fake-${this.sent.length}`; }
  async resolveJid(digits: string) { return `${digits}@s.whatsapp.net`; }
  async stop() { /* nothing to close */ }
}
async function waitFor<T>(check: () => Promise<T | null | false | undefined> | T | null | false | undefined, ms = 5000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const value = await check(); if (value) return value; if (Date.now() > end) throw new Error('waitFor timeout'); await new Promise(resolve => setTimeout(resolve, 25)); }
}

test('classic conversation: free subject changes, several questions at once, resumable bookings, no repeats, no duplicates', { skip: !enabled, timeout: 120_000 }, async t => {
  process.env.MFA_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  process.env.RM_RESTAURANT_URL = 'https://restaurant.example';
  process.env.WHATSAPP_SESSION_DIR = path.join(os.tmpdir(), `rm-wa-${sfx()}`);
  setAiProvider(undefined);
  const id = sfx();
  const tenant = await prisma.tenant.create({ data: { name: `Cantina Livre ${id}`, slug: `livre-${id}`, status: 'ACTIVE' } });
  const other = await prisma.tenant.create({ data: { name: `Outra Livre ${id}`, slug: `outra-livre-${id}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz', address: 'Rua das Flores, 10' } });
  await prisma.unit.create({ data: { tenantId: other.id, name: 'Matriz' } });
  t.after(async () => { setAiProvider(undefined); await prisma.tenant.deleteMany({ where: { id: { in: [tenant.id, other.id] } } }); await prisma.$disconnect(); });

  const category = await prisma.productCategory.create({ data: { tenantId: tenant.id, name: 'Lanches' } });
  const burger = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Hambúrguer Artesanal', description: 'Pão brioche e blend 180g', price: 32.9, categoryId: category.id } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Suco de laranja', price: 9.5 } });
  await prisma.promotion.create({ data: { tenantId: tenant.id, name: 'Promo do hambúrguer', type: 'FIXED', value: 2.9, startsAt: new Date(Date.now() - 3_600_000), products: { create: [{ productId: burger.id }] } } });
  await prisma.deliveryZone.createMany({ data: [{ tenantId: tenant.id, name: 'Centro', fee: 5, minOrder: 20, neighborhoods: ['Centro'] }, { tenantId: tenant.id, name: 'Zona Norte', fee: 8, neighborhoods: ['Norte', 'Jardim Norte'] }] });
  await prisma.paymentMethodConfig.createMany({ data: [{ tenantId: tenant.id, name: 'PIX', equivalent: 'PIX', sortOrder: 1 }, { tenantId: tenant.id, name: 'Dinheiro', equivalent: 'CASH', sortOrder: 2 }, { tenantId: tenant.id, name: 'Cartão de crédito', equivalent: 'CREDIT_CARD', sortOrder: 3 }] });
  await prisma.whatsappKnowledge.create({ data: { tenantId: tenant.id, title: 'Estacionamento', keywords: ['estacionamento', 'estacionar'], answer: 'Temos estacionamento gratuito ao lado. 🚗' } });
  await saveSettingsSection(prisma, tenant.id, 'company', { tradeName: 'Cantina Livre', address: 'Rua das Flores', number: '10', city: 'Sorriso', state: 'MT', phone: '66999990000' });
  await saveSettingsSection(prisma, tenant.id, 'whatsapp', { botEnabled: true, replyDelaySeconds: 0, humanizeTyping: false });
  // Open every day 10:00-23:00 except Sunday (closed), so reservations "tomorrow at 20h" are valid unless tomorrow is Sunday: that case is covered separately.
  const everyDay = [1, 2, 3, 4, 5, 6, 0].map(day => ({ day, start: '10:00', end: '23:00' }));
  await saveSettingsSection(prisma, tenant.id, 'hours', { timezone: 'America/Sao_Paulo', mode: 'SCHEDULE', weekly: everyDay });
  await saveSettingsSection(prisma, other.id, 'whatsapp', { botEnabled: true });

  type Who = { jid: string; phone: string | null; name: string };
  const person = (n: number, name: string): Who => ({ jid: `55669999${String(n).padStart(5, '0')}@s.whatsapp.net`, phone: `55669999${String(n).padStart(5, '0')}`, name });
  // Like the session manager: the customer's message is processed, then every reply that was "sent" is recorded.
  const say = async (who: Who, text: string, tenantId = tenant.id) => {
    const out = await processInbound(prisma, { tenantId, jid: who.jid, phone: who.phone, name: who.name, text, externalId: `m-${sfx()}` });
    if (out.conversationId) for (const line of out.replies) await recordOutbound(prisma, tenantId, out.conversationId, line, 'BOT');
    return out;
  };
  const joined = (out: { replies: string[] }) => out.replies.join('\n');
  const reservations = (who: Who) => prisma.reservation.findMany({ where: { tenantId: tenant.id, phone: who.phone }, orderBy: { createdAt: 'asc' } });

  await t.test('1. changing subject in the middle of a reservation never traps the customer; the booking waits, parks itself and resumes', async () => {
    const maria = person(1, 'Maria Silva');
    assert.match(joined(await say(maria, 'Quero fazer uma reserva.')), /Para quantas pessoas/);
    const payment = joined(await say(maria, 'Antes, quais formas de pagamento vocês aceitam?'));
    assert.match(payment, /• PIX/); assert.match(payment, /• Dinheiro/);
    assert.match(payment, /quantas pessoas/, 'one gentle reminder of the open booking');
    const fee = joined(await say(maria, 'E qual é a taxa de entrega?'));
    assert.match(fee, /Centro: R\$ 5,00/); assert.match(fee, /Zona Norte: R\$ 8,00/);
    assert.match(fee, /guardada/, 'after two reminders the booking is parked instead of nagging');
    const where = joined(await say(maria, 'Vocês ficam onde?'));
    assert.match(where, /Rua das Flores, 10 - Sorriso\/MT/); assert.doesNotMatch(where, /quantas pessoas|guardada/, 'a parked booking is not mentioned again');
    assert.match(joined(await say(maria, 'tem estacionamento?')), /estacionamento gratuito/);
    const back = joined(await say(maria, 'Certo, somos 4 pessoas, amanhã às 20h'));
    assert.match(back, /Confirma a reserva para \*4 pessoa\(s\)\*/, 'giving the missing data resumes the parked booking by itself');
    assert.equal((await reservations(maria)).length, 0, 'nothing is booked before the customer confirms');
    const done = joined(await say(maria, 'sim'));
    assert.match(done, /Pedido de reserva recebido para 4 pessoa\(s\)/);
    const [booking] = await reservations(maria);
    assert.equal(booking.partySize, 4); assert.equal(booking.status, 'PENDING'); assert.equal(booking.phone, maria.phone);
  });

  await t.test('2. several questions in one message are all answered, in the order asked, with real data', async () => {
    const ana = person(2, 'Ana Souza');
    const out = await say(ana, 'vcs ficam onde? aceitam pix? e qq a taxa pro jardim norte??');
    const text = joined(out);
    const at = (pattern: RegExp) => text.search(pattern);
    assert.ok(at(/Rua das Flores/) >= 0 && at(/Sim, aceitamos \*PIX\*/) > at(/Rua das Flores/) && at(/Zona Norte: R\$ 8,00/) > at(/Sim, aceitamos \*PIX\*/), `answered in the order asked:\n${text}`);
    assert.doesNotMatch(text, /Centro: R\$ 5,00/, 'only the zone that was asked about');
    assert.deepEqual(out.intent, 'address');
    const mixed = joined(await say(ana, 'qro ver o cardapo e saber se tem promossao hj'));
    assert.match(mixed, /Cardápio Cantina Livre/); assert.match(mixed, /Promoções de hoje[\s\S]*Hambúrguer Artesanal/);
    assert.match(joined(await say(ana, 'vocês aceitam vale refeição?')), /não aceitamos \*vale\*/i);
    assert.match(joined(await say(ana, 'oiii, tudo bem? qual o horário e tem estacionamento?')), /Olá, Ana! 😊[\s\S]*(Estamos|Horário)[\s\S]*estacionamento gratuito/);
  });

  await t.test('3. details given up front, corrections at the confirmation, and never a duplicate booking', async () => {
    const joao = person(3, 'João Pereira');
    const first = joined(await say(joao, 'quero reservar pra 4 pessoas amanhã às 20h'));
    assert.match(first, /Confirma a reserva para \*4 pessoa\(s\)\*/); assert.match(first, /20:00/);
    const changed = joined(await say(joao, 'melhor às 21h'));
    assert.match(changed, /Confirma a reserva para \*4 pessoa\(s\)\*/); assert.match(changed, /21:00/); assert.equal((await reservations(joao)).length, 0);
    const bigger = joined(await say(joao, 'não, pra 6 pessoas'));
    assert.match(bigger, /\*6 pessoa\(s\)\*/); assert.equal((await reservations(joao)).length, 0);
    assert.match(joined(await say(joao, 'e vocês entregam? sim pode confirmar')), /Centro: R\$ 5,00/);
    const [booking] = await reservations(joao);
    assert.equal(booking.partySize, 6, 'the corrected size is what was booked');
    // The same customer confirming again, or asking again, never creates a second booking.
    await say(joao, 'sim'); await say(joao, 'quero reservar pra 6 pessoas amanhã às 21h'); await say(joao, 'sim');
    assert.equal((await reservations(joao)).length, 1);
  });

  await t.test('3b. two confirmations at the very same instant (or from two chats of the same phone) book once', async () => {
    const lia = person(4, 'Lia Campos'); const liaLid: Who = { jid: '99887766@lid', phone: lia.phone, name: 'Lia Campos' };
    await say(lia, 'reserva para 2 pessoas depois de amanhã às 19h'); await say(liaLid, 'reserva para 2 pessoas depois de amanhã às 19h');
    const outcomes = await Promise.all([say(lia, 'sim'), say(liaLid, 'sim'), say(lia, 'sim')]);
    assert.equal((await reservations(lia)).length, 1, 'one reservation for one phone and one time');
    assert.ok(outcomes.some(o => /Pedido de reserva recebido/.test(joined(o))));
    assert.ok(outcomes.filter(o => /já tem uma reserva registrada/.test(joined(o))).length >= 1, 'the others are told it already exists');
  });

  await t.test('4. cancelling or giving up ends the booking, and bare numbers go back to meaning the numbered options', async () => {
    const eva = person(5, 'Eva Costa');
    await say(eva, 'quero reservar uma mesa');
    assert.match(joined(await say(eva, 'deixa pra lá')), /não vou registrar essa reserva/);
    const hours = joined(await say(eva, '4'));
    assert.match(hours, /Estamos|Horário/, 'a number is the "Horários" option again, not a party size'); assert.doesNotMatch(hours, /quantas pessoas/);
    await say(eva, 'reservar'); assert.match(joined(await say(eva, '2')), /^(?!.*Faça seu pedido)[\s\S]*(Anotei|dia e horário)/, 'while asked, a number is the party size');
    assert.match(joined(await say(eva, 'cancelar')), /não vou registrar essa reserva/);
    assert.equal((await reservations(eva)).length, 0);
    // Giving up and asking something else in the same message: the draft is dropped and the question is answered (nothing is lost).
    await say(eva, 'quero reservar uma mesa');
    const both = joined(await say(eva, 'não, quero ver o cardápio'));
    assert.match(both, /não vou registrar essa reserva/); assert.match(both, /Cardápio Cantina Livre/);
    assert.doesNotMatch(joined(await say(eva, '2')), /Para quantas pessoas|Anotei/, 'the draft really is gone');
  });

  await t.test('5. impossible, past or closed times are explained and the customer keeps going', async () => {
    const raul = person(6, 'Raul Dias');
    await say(raul, 'reservar para 3 pessoas');
    assert.match(joined(await say(raul, 'ontem às 20h')), /já passou/);
    assert.match(joined(await say(raul, 'amanhã às 25h')), /inválido/);
    assert.match(joined(await say(raul, 'amanhã às 5h da manhã')), /funciona das 10:00 às 23:00/);
    assert.match(joined(await say(raul, 'amanhã 19:30')), /Confirma a reserva para \*3 pessoa\(s\)\*/);
    assert.match(joined(await say(raul, 'sim')), /Pedido de reserva recebido/);
  });

  await t.test('6. what is not understood escalates (options, then help, then a person) instead of repeating itself', async () => {
    const vera = person(7, 'Vera Luz');
    const first = joined(await say(vera, 'xkcd qwerty zzz'));
    assert.match(first, /Escolha uma opção|Cardápio/);
    const second = joined(await say(vera, 'blablabla lorem ipsum'));
    assert.match(second, /ainda não consegui entender/); assert.notEqual(second, first);
    const third = await say(vera, 'asdf ghjk');
    assert.equal(third.intent, 'handoff', 'after repeated misunderstandings a person takes over');
    assert.equal((await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: vera.jid } })).handoff, true);
    // Understanding resets the count: a sensible question in between keeps the robot in charge.
    const nina = person(8, 'Nina Lopes');
    await say(nina, 'xkcd qwerty'); await say(nina, 'onde fica?'); await say(nina, 'asdf ghjk');
    assert.equal((await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: nina.jid } })).handoff, false);
  });

  await t.test('7. questions about an existing reservation or order are not new bookings; cancelling something already made calls a person', async () => {
    const bia = person(9, 'Bia Rocha');
    await prisma.reservation.create({ data: { tenantId: tenant.id, unitId: unit.id, customerName: 'Bia Rocha', phone: bia.phone, partySize: 3, reservedAt: new Date(Date.now() + 2 * 86_400_000), notes: 'Solicitada pelo WhatsApp' } });
    const status = joined(await say(bia, 'minha reserva foi confirmada?'));
    assert.match(status, /3 pessoa\(s\)[\s\S]*aguardando a confirmação da equipe/); assert.doesNotMatch(status, /quantas pessoas/);
    assert.match(joined(await say(person(10, 'Sem Reserva'), 'minha reserva foi confirmada?')), /Não encontrei reservas ativas/);
    const cancel = await say(bia, 'quero cancelar minha reserva');
    assert.equal(cancel.intent, 'handoff'); assert.match(joined(cancel), /preciso da equipe/);
    assert.equal((await prisma.reservation.findMany({ where: { tenantId: tenant.id, phone: bia.phone } })).length, 1, 'nothing was cancelled or created by the robot');
    assert.equal((await say(bia, 'alguém aí?')).replies.length, 0, 'the person is in charge now');
  });

  await t.test('8. "e sábado?" after a question about hours, and the same question twice is flagged as a repeat', async () => {
    const sundayClosed = await prisma.tenant.create({ data: { name: `Domingo Fechado ${id}`, slug: `domingo-${id}`, status: 'ACTIVE' } });
    t.after(() => prisma.tenant.delete({ where: { id: sundayClosed.id } }).then(() => undefined, () => undefined));
    await saveSettingsSection(prisma, sundayClosed.id, 'whatsapp', { botEnabled: true });
    await saveSettingsSection(prisma, sundayClosed.id, 'hours', { timezone: 'America/Sao_Paulo', mode: 'SCHEDULE', weekly: [1, 2, 3, 4, 5, 6].map(day => ({ day, start: day === 6 ? '11:00' : '10:00', end: day === 6 ? '15:00' : '22:00' })) });
    const lu = person(11, 'Lu Mota');
    assert.match(joined(await say(lu, 'abre domingo?', sundayClosed.id)), /Domingo: fechado/);
    assert.match(joined(await say(lu, 'e sábado?', sundayClosed.id)), /Sábado: 11:00 às 15:00/);
    const again = joined(await say(lu, 'e sábado?', sundayClosed.id));
    assert.match(again, /^Claro, segue novamente:/, 'asking the same thing again is answered, and marked as a repeat');
  });

  await t.test('9. customers and restaurants are isolated; a conversation continues after a restart because its state lives in the database', async () => {
    const dani = person(12, 'Dani Alves');
    await say(dani, 'quero reservar para 5 pessoas');
    // The same phone writing to ANOTHER restaurant starts from zero: "amanhã 20h" there is not a booking.
    assert.doesNotMatch(joined(await say(dani, 'amanhã 20h', other.id)), /Confirma a reserva/);
    // "Restart": nothing is kept in memory; the next message finds the booking in the database.
    const resumed = joined(await say(dani, 'amanhã às 20h'));
    assert.match(resumed, /Confirma a reserva para \*5 pessoa\(s\)\*/);
    const stored = (await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: dani.jid } })).stateData as { step?: string; people?: number };
    assert.equal(stored.step, 'RESERVE_CONFIRM'); assert.equal(stored.people, 5);
    const otherState = (await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: other.id, jid: dani.jid } })).stateData as { step?: string } | null;
    assert.notEqual(otherState?.step, 'RESERVE_CONFIRM');
  });

  await t.test('10. a burst of messages typed in pieces gets one answer, in order; a re-delivered message is answered once', async () => {
    const transports: FakeTransport[] = [];
    const manager = new WhatsappSessionManager(prisma, { tenantIds: [tenant.id], factory: () => { const fake = new FakeTransport(); transports.push(fake); return fake; }, sleep: async () => undefined, log: () => undefined });
    t.after(() => manager.stop());
    await prisma.whatsappManager.deleteMany({ where: { id: 'default' } });
    await prisma.whatsappSession.upsert({ where: { tenantId: tenant.id }, create: { tenantId: tenant.id, desired: 'CONNECTED' }, update: { desired: 'CONNECTED' } });
    await manager.tick();
    transports[0].handlers.onOpen({ phone: '5566900001111', name: 'Cantina' });
    await waitFor(() => manager.connectedTenantIds().includes(tenant.id));
    const jid = '5566988887777@s.whatsapp.net'; const now = () => Math.floor(Date.now() / 1000);
    const send = (text: string, messageId = `wa-${sfx()}`) => transports[0].handlers.onMessage({ jid, phone: '5566988887777', name: 'Teo', text, id: messageId, timestamp: now() });
    send('oi'); send('quero reservar uma mesa'); send('pra 4 pessoas amanhã às 20h');
    await waitFor(() => transports[0].sent.length > 0);
    await new Promise(resolve => setTimeout(resolve, 300));
    const replies = transports[0].sent.map(item => item.text);
    assert.equal(replies.length, 1, `three pieces, one answer:\n${replies.join('\n---\n')}`);
    assert.match(replies[0], /Confirma a reserva para \*4 pessoa\(s\)\*/);
    const redelivered = `wa-${sfx()}`;
    send('tem promoção?', redelivered); send('tem promoção?', redelivered);
    await waitFor(() => transports[0].sent.length > 1); await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(transports[0].sent.length, 2, 'the same message delivered twice is answered once');
    assert.equal(await prisma.whatsappChatMessage.count({ where: { tenantId: tenant.id, externalId: redelivered } }), 1);
    assert.match(transports[0].sent[1].text, /Promoções de hoje|promoções ativas/);
  });
});
