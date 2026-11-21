// Live check of the WhatsApp AI attendant against a REAL model (any OpenAI-compatible endpoint). It seeds a throw-away restaurant in the database named by
// DATABASE_URL (a LOCAL, migrated database — never production), runs conversations through the same code path as a real WhatsApp message, prints every
// message and every tool the model used, and verifies what really happened in the database. Nothing is sent to WhatsApp.
//
//   AGENT_LIVE_API_KEY=... [AGENT_LIVE_BASE_URL=https://models.github.ai/inference] [AGENT_LIVE_MODEL=openai/gpt-4.1-mini] \
//   DATABASE_URL=postgresql://.../local_db node --import tsx apps/api/scripts/agent-live-check.ts [scenario ...]
import { randomBytes } from 'node:crypto';
import { prisma } from '../src/lib/prisma';
import { buildProvider, setAiProvider } from '../src/lib/ai-provider';
import { saveSettingsSection, loadSettings } from '../src/lib/settings';
import { processInbound, recordOutbound } from '../src/lib/whatsapp-inbound';
import { loadMemory } from '../src/lib/whatsapp-agent';

const key = process.env.AGENT_LIVE_API_KEY;
if (!key) { console.error('Set AGENT_LIVE_API_KEY (and optionally AGENT_LIVE_BASE_URL / AGENT_LIVE_MODEL).'); process.exit(2); }
if (/neon\.tech|render\.com|amazonaws\.com/i.test(process.env.DATABASE_URL ?? '')) { console.error('Refusing to run against a remote database.'); process.exit(2); }
const baseUrl = process.env.AGENT_LIVE_BASE_URL ?? 'https://models.github.ai/inference';
const model = process.env.AGENT_LIVE_MODEL ?? 'openai/gpt-4.1-mini';
const wanted = process.argv.slice(2);
const sfx = randomBytes(3).toString('hex');
const pause = Number(process.env.AGENT_LIVE_PAUSE_MS ?? 0);
const checks: { name: string; ok: boolean }[] = [];
const check = (name: string, ok: boolean) => { checks.push({ name, ok }); console.log(`   ${ok ? '✅' : '❌'} ${name}`); };
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const live = buildProvider({ provider: 'custom', apiKey: key!, model, baseUrl });
  const probe = await live.chat!({ system: 'Responda em uma palavra.', messages: [{ role: 'user', content: 'Diga: ok' }], maxTokens: 16 }).catch(error => ({ text: null, toolCalls: [], inputTokens: null, error: String(error) }));
  if (!probe.text && probe.inputTokens === null) { console.error(`${baseUrl} did not return a chat completion (${'error' in probe ? probe.error : 'empty or unexpected body'}). Check AGENT_LIVE_BASE_URL, the key and the model.`); process.exit(2); }
  setAiProvider(live);
  const tenant = await prisma.tenant.create({ data: { name: `Cantina Live ${sfx}`, slug: `cantina-live-${sfx}`, status: 'ACTIVE' } });
  const unit = await prisma.unit.create({ data: { tenantId: tenant.id, name: 'Matriz' } });
  const cat = await prisma.productCategory.create({ data: { tenantId: tenant.id, name: 'Lanches' } });
  const burger = await prisma.product.create({ data: { tenantId: tenant.id, name: 'Hambúrguer Artesanal', description: 'Pão brioche, blend 180g, queijo e salada', price: 32.9, categoryId: cat.id } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Suco de laranja', description: 'Natural, 400ml', price: 9.5 } });
  await prisma.product.create({ data: { tenantId: tenant.id, name: 'Batata frita', description: 'Porção média', price: 18, categoryId: cat.id } });
  const point = await prisma.modifierGroup.create({ data: { tenantId: tenant.id, name: 'Ponto da carne', minSelect: 1, maxSelect: 1, options: { create: [{ name: 'Mal passado' }, { name: 'Ao ponto' }, { name: 'Bem passado' }] } } });
  await prisma.productModifierGroup.create({ data: { productId: burger.id, groupId: point.id } });
  await prisma.promotion.create({ data: { tenantId: tenant.id, name: 'Promo da batata', type: 'FIXED', value: 3, startsAt: new Date(Date.now() - 3_600_000), products: { create: [{ productId: (await prisma.product.findFirstOrThrow({ where: { tenantId: tenant.id, name: 'Batata frita' } })).id }] } } });
  await prisma.deliveryZone.createMany({ data: [{ tenantId: tenant.id, name: 'Centro', fee: 5, minOrder: 20, neighborhoods: ['Centro'] }, { tenantId: tenant.id, name: 'Zona Norte', fee: 8, neighborhoods: ['Norte', 'Jardim Norte'] }] });
  await prisma.paymentMethodConfig.createMany({ data: [{ tenantId: tenant.id, name: 'PIX', equivalent: 'PIX', sortOrder: 1 }, { tenantId: tenant.id, name: 'Dinheiro', equivalent: 'CASH', sortOrder: 2 }, { tenantId: tenant.id, name: 'Cartão de crédito', equivalent: 'CREDIT_CARD', sortOrder: 3 }, { tenantId: tenant.id, name: 'Cartão de débito', equivalent: 'DEBIT_CARD', sortOrder: 4 }] });
  await prisma.restaurantTable.createMany({ data: [{ tenantId: tenant.id, unitId: unit.id, label: 'M1', seats: 4, qrToken: `q1-${sfx}` }, { tenantId: tenant.id, unitId: unit.id, label: 'M2', seats: 6, qrToken: `q2-${sfx}` }] });
  await prisma.whatsappKnowledge.create({ data: { tenantId: tenant.id, title: 'Estacionamento', keywords: ['estacionamento'], answer: 'Temos estacionamento gratuito ao lado do restaurante.' } });
  await saveSettingsSection(prisma, tenant.id, 'company', { tradeName: 'Cantina Live', address: 'Rua das Flores', number: '10', district: 'Centro', city: 'Sorriso', state: 'MT', phone: '66999990000' });
  const current = await loadSettings(prisma, tenant.id);
  await saveSettingsSection(prisma, tenant.id, 'whatsapp', { ...current.whatsapp, botEnabled: true, agent: { ...current.whatsapp.agent, instructions: 'Seja simpático e ofereça uma batata frita quando o cliente pedir um hambúrguer.' } });
  await saveSettingsSection(prisma, tenant.id, 'fulfillment', { ...current.fulfillment, estimatedTime: true, deliveryMinutes: 45, pickupMinutes: 20 });
  await saveSettingsSection(prisma, tenant.id, 'ai', { ...current.ai, externalConsent: true, externalEnabled: true });

  const customer = (n: string, name: string) => ({ jid: `55669999${n}@s.whatsapp.net`, phone: `55669999${n}`, name });
  async function say(who: ReturnType<typeof customer>, text: string) {
    const started = new Date();
    console.log(`\n👤 ${who.name}: ${text}`);
    const outcome = await processInbound(prisma, { tenantId: tenant.id, jid: who.jid, phone: who.phone, name: who.name, text, externalId: `live-${randomBytes(4).toString('hex')}` });
    const actions = outcome.conversationId ? await prisma.whatsappAgentAction.findMany({ where: { conversationId: outcome.conversationId, createdAt: { gte: started } }, orderBy: { createdAt: 'asc' } }) : [];
    for (const action of actions) console.log(`   🔧 ${action.tool}${action.kind === 'READ' || action.kind === 'MEMORY' ? '' : ` [${action.kind}]`} → ${action.ok ? '✔' : '✖'} ${action.summary ?? ''}`);
    for (const reply of outcome.replies) { console.log(`🤖 ${reply.split('\n').join('\n   ')}`); if (outcome.conversationId) await recordOutbound(prisma, tenant.id, outcome.conversationId, reply, 'BOT'); }
    if (outcome.replies.length === 0) console.log(`🤖 (sem resposta — ${outcome.intent})`);
    if (!outcome.intent.startsWith('agent') && outcome.replies.length) console.log(`   ⚠ respondido pelo robô clássico (${outcome.intent})`);
    if (pause) await new Promise(resolve => setTimeout(resolve, pause));
    return { outcome, text: outcome.replies.join('\n') };
  }
  const memory = async (who: ReturnType<typeof customer>) => loadMemory((await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: who.jid } })).agentMemory);
  const run = (name: string) => wanted.length === 0 || wanted.includes(name);

  try {
    if (run('reserva')) {
      console.log('\n═══ 1. Reserva interrompida por outros assuntos e retomada ═══');
      const c = customer('0001', 'Maria Silva');
      await say(c, 'Quero fazer uma reserva.');
      const pay = await say(c, 'Antes, quais formas de pagamento vocês aceitam?'); check('responde as formas de pagamento reais', /pix/i.test(pay.text) && /dinheiro/i.test(pay.text));
      const fee = await say(c, 'E qual é a taxa de entrega?'); check('informa taxas reais (5 e 8)', /5,00/.test(fee.text) && /8,00/.test(fee.text));
      const where = await say(c, 'Vocês ficam onde?'); check('informa o endereço cadastrado', /Rua das Flores/.test(where.text));
      await say(c, 'Certo, quero reservar para sábado às 20h.');
      await say(c, 'somos 4 pessoas, em nome de Maria');
      const reservation = await prisma.reservation.findFirst({ where: { tenantId: tenant.id, phone: { endsWith: '99990001' } } });
      check('reserva criada de verdade no banco (4 pessoas, às 20h)', Boolean(reservation && reservation.partySize === 4 && reservation.reservedAt.toISOString().slice(11, 16) === '23:00'));
      check('reserva aguarda confirmação da equipe (PENDING)', reservation?.status === 'PENDING');
    }
    if (run('pedido')) {
      console.log('\n═══ 2. Pedido, dúvida de entrega no meio, alteração e confirmação ═══');
      const c = customer('0002', 'João Pereira');
      await say(c, 'oi, quero um hamburguer');
      await say(c, 'ao ponto. quanto fica a entrega no centro?');
      await say(c, 'na verdade manda 2 hamburgueres, e uma batata');
      const ask = await say(c, 'Rua A, 10, Centro. vou pagar no pix');
      check('mostra o resumo com total antes de criar o pedido', /total/i.test(ask.text) && (await prisma.order.count({ where: { tenantId: tenant.id } })) === 0);
      await say(c, 'sim, pode confirmar');
      const order = await prisma.order.findFirst({ where: { tenantId: tenant.id, customer: { phone: { endsWith: '99990002' } } }, include: { items: true } });
      check('pedido criado após a confirmação (2 hambúrgueres + batata, entrega R$ 5)', Boolean(order && order.items.length === 2 && Number(order.deliveryFee) === 5));
      const status = await say(c, 'e aí, como está meu pedido?'); check('informa o status real do pedido', Boolean(order && status.text.includes(String(order.number))));
      console.log('   memória:', JSON.stringify({ lastOrder: (await memory(c)).order.lastOrderNumber, enderecos: (await memory(c)).profile.addresses }));
    }
    if (run('misto')) {
      console.log('\n═══ 3. Várias perguntas numa mensagem, texto informal e assunto sem resposta ═══');
      const c = customer('0003', 'Ana');
      const multi = await say(c, 'vcs ficam onde? aceitam pix? e qq a taxa pro jardim norte??');
      check('responde as três perguntas', /Rua das Flores/.test(multi.text) && /pix/i.test(multi.text) && /8,00/.test(multi.text));
      const none = await say(c, 'tem brinquedoteca pra crianças aí?'); check('admite que não sabe (não inventa)', !/sim, temos brinquedoteca/i.test(none.text));
      check('registra a pergunta sem resposta', (await prisma.whatsappUnanswered.count({ where: { tenantId: tenant.id } })) > 0);
      const park = await say(c, 'e estacionamento?'); check('usa a base de conhecimento', /gratuito/i.test(park.text));
      const typos = await say(c, 'qro saber se tem promossão hj'); check('entende erros de digitação (promoção real)', /batata/i.test(typos.text));
    }
    if (run('humano')) {
      console.log('\n═══ 4. Atendente humano e volta ao robô ═══');
      const c = customer('0004', 'Dani');
      await say(c, 'quero falar com uma pessoa, meu último pedido veio errado');
      const conversation = await prisma.whatsappConversation.findFirstOrThrow({ where: { tenantId: tenant.id, jid: c.jid } });
      check('conversa passou para atendente humano', conversation.handoff);
      const silent = await say(c, 'alô?'); check('robô fica em silêncio durante o atendimento humano', silent.outcome.replies.length === 0);
      await recordOutbound(prisma, tenant.id, conversation.id, 'Oi Dani, aqui é o Marcos! Vou resolver isso agora.', 'STAFF');
      await prisma.whatsappConversation.update({ where: { id: conversation.id }, data: { handoff: false, handoffUntil: null } });
      const back = await say(c, 'valeu! posso reservar mesa pra 2 amanhã às 19h?'); check('volta ao robô e segue com a nova solicitação', back.outcome.replies.length > 0);
    }
  } finally {
    await prisma.order.deleteMany({ where: { tenantId: tenant.id } });
    await prisma.tenant.delete({ where: { id: tenant.id } });
    setAiProvider(undefined);
  }
  const failed = checks.filter(item => !item.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} verificações passaram (modelo: ${model})`);
  void day;
  await prisma.$disconnect();
  process.exit(failed.length ? 1 : 0);
}
main().catch(async error => { console.error(error); await prisma.$disconnect(); process.exit(1); });
