import { z } from 'zod';
import { hoursText } from '../../whatsapp-bot';
import { isStoreOpen } from '../../scheduling';
import { matchScore, normalizeText, parseWhen } from '../../whatsapp-text';
import { addAddress } from '../memory';
import { touch } from '../memory';
import { defineTool, type ToolDef } from '../types';
import { clip, describeInstant, fail, money, num, ok, tzOf, WEEKDAYS } from './common';

const none = z.object({});

export const getRestaurantInfo = defineTool({
  name: 'get_restaurant_info', kind: 'READ', schema: none,
  description: 'Dados reais do estabelecimento: nome, endereço, telefone, se está aberto agora, horários de funcionamento, formas de atendimento (entrega, retirada, consumo no local), tempos estimados, pedido mínimo, entrega grátis, agendamento e link do cardápio online.',
  async run(ctx) {
    const { env } = ctx; const s = env.settings; const f = s.fulfillment; const tz = tzOf(ctx);
    const byDay = new Map<number, string[]>();
    for (const slot of [...s.hours.weekly].sort((a, b) => a.day - b.day || a.start.localeCompare(b.start))) byDay.set(slot.day, [...(byDay.get(slot.day) ?? []), `${slot.start} às ${slot.end}`]);
    return ok({
      name: env.restaurant, address: env.address, phone: s.company.phone || null, whatsapp: s.company.whatsapp || null, slogan: s.company.slogan || null,
      openNow: isStoreOpen(s.hours, ctx.now), hoursMode: s.hours.mode, hoursText: hoursText(env), weeklyHours: [...byDay.entries()].map(([day, slots]) => ({ day: WEEKDAYS[day], slots })), timezone: tz, localNow: describeInstant(ctx.now, tz).human,
      pickup: f.allowPickup, delivery: f.allowDelivery, dineIn: f.allowDineIn,
      pickupMinutes: f.estimatedTime ? f.pickupMinutes : null, deliveryMinutes: f.estimatedTime ? f.deliveryMinutes : null, minDeliveryOrder: f.minDelivery || null, freeDeliveryFrom: f.freeDeliveryMin || null,
      scheduledOrders: s.scheduling.enabled ? { maxDaysAhead: s.scheduling.maxDaysAhead, leadTime: s.scheduling.leadTime } : null, orderWhenClosed: s.store.allowBuyWhenClosed, onlineMenuUrl: env.storeUrl,
    }, 'Dados do estabelecimento consultados');
  },
});

export const listPaymentMethods = defineTool({
  name: 'list_payment_methods', kind: 'READ', schema: none,
  description: 'Formas de pagamento aceitas pelo restaurante (dinheiro, Pix, débito, crédito etc., conforme a configuração). O pagamento é feito na entrega/retirada; o atendente não cobra nem recebe dados de cartão.',
  async run(ctx) {
    const rows = await ctx.db.paymentMethodConfig.findMany({ where: { tenantId: ctx.tenantId, active: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
    if (rows.length === 0) return ok({ configured: false, methods: ['Dinheiro', 'PIX', 'Cartão de crédito', 'Cartão de débito', 'Vale'].map(name => ({ name })), note: 'O restaurante ainda não cadastrou as formas de pagamento; estas são as usuais.' }, 'Formas de pagamento (padrão)');
    return ok({ configured: true, methods: rows.map(row => ({ id: row.id, name: row.name, type: row.equivalent, allowsChange: row.allowChange, forOnlineOrders: row.showStore })) }, `${rows.length} forma(s) de pagamento`);
  },
});

export const quoteDelivery = defineTool({
  name: 'quote_delivery', kind: 'MEMORY',
  schema: z.object({ neighborhood: z.string().trim().max(80).optional().describe('bairro ou região do cliente'), address: z.string().trim().max(300).optional().describe('endereço completo, se o cliente informou') }),
  description: 'Taxa de entrega, pedido mínimo, entrega grátis e tempo estimado. Informe o bairro/região (ou endereço) do cliente para saber a taxa da região dele; sem isso devolve as regiões atendidas. Guarda a região encontrada para o pedido.',
  async run(ctx, args) {
    const f = ctx.env.settings.fulfillment;
    if (!f.allowDelivery) return ok({ delivers: false, pickup: f.allowPickup }, 'O restaurante não faz entregas');
    const base = { delivers: true, mode: f.deliveryFeeMode, minOrder: f.minDelivery || null, freeDeliveryFrom: f.freeDeliveryMin || null, estimatedMinutes: f.estimatedTime ? f.deliveryMinutes : null };
    const zones = await ctx.db.deliveryZone.findMany({ where: { tenantId: ctx.tenantId, active: true, ...(ctx.unitId ? { OR: [{ unitId: ctx.unitId }, { unitId: null }] } : {}) }, orderBy: { name: 'asc' }, take: 60 });
    if (f.deliveryFeeMode === 'SINGLE' || f.deliveryFeeMode === 'UNMAPPED') return ok({ ...base, fee: num(f.singleFee), feeType: 'taxa única' }, `Taxa única ${money(f.singleFee)}`);
    if (zones.length === 0) return ok({ ...base, fee: 0, configured: false, note: 'Nenhuma taxa/região de entrega foi cadastrada; confirme com um atendente antes de prometer valores.' }, 'Sem taxas cadastradas');
    const needle = normalizeText(`${args.neighborhood ?? ''} ${args.address ?? ''}`);
    const view = (zone: typeof zones[number]) => ({ name: zone.name, fee: num(zone.fee), minOrder: num(zone.minOrder), estimatedMinutes: zone.estimatedMinutes, neighborhoods: zone.neighborhoods.slice(0, 25) });
    const hits = needle.length < 3 ? [] : zones.filter(zone => [zone.name, ...zone.neighborhoods].some(label => { const n = normalizeText(label); return n.length >= 3 && (needle.includes(n) || (n.includes(needle) && needle.length >= 4)); }));
    if (hits.length === 1) {
      const zone = hits[0];
      ctx.memory.delivery = { ...ctx.memory.delivery, neighborhood: args.neighborhood ?? ctx.memory.delivery.neighborhood, address: args.address ?? ctx.memory.delivery.address, zoneId: zone.id, zoneName: zone.name, fee: Number(zone.fee), updatedAt: touch(ctx.now) };
      if (args.address) addAddress(ctx.memory, args.address);
      return ok({ ...base, matched: true, zone: view(zone) }, `Região ${zone.name}: taxa ${money(zone.fee)}`);
    }
    if (hits.length > 1) return ok({ ...base, matched: false, ambiguous: true, zones: hits.map(view) }, 'Mais de uma região possível');
    return ok({ ...base, matched: false, zones: zones.slice(0, 25).map(view), note: needle.length >= 3 ? 'Não encontrei essa região entre as atendidas; pode estar fora da área de entrega.' : 'Informe o bairro do cliente para calcular a taxa.' }, 'Regiões de entrega listadas');
  },
});

export const listPromotions = defineTool({
  name: 'list_promotions', kind: 'READ', schema: none,
  description: 'Promoções e descontos vigentes agora (produtos em promoção e o desconto). Cupons não são listados; o cliente só pode usar um cupom que ele mesmo informar.',
  async run(ctx) {
    const rows = await ctx.db.promotion.findMany({ where: { tenantId: ctx.tenantId, active: true, startsAt: { lte: ctx.now }, OR: [{ endsAt: null }, { endsAt: { gte: ctx.now } }] }, include: { products: { select: { productId: true } } }, orderBy: { startsAt: 'desc' }, take: 20 });
    const ids = [...new Set(rows.flatMap(row => row.products.map(link => link.productId)))];
    const names = new Map((await ctx.db.product.findMany({ where: { id: { in: ids }, tenantId: ctx.tenantId, active: true, localOnly: false }, select: { id: true, name: true, price: true } })).map(product => [product.id, product]));
    const items = rows.map(row => ({ name: row.name, discount: row.type === 'PERCENT' ? `${Number(row.value)}%` : money(row.value), products: row.products.map(link => names.get(link.productId)).filter(Boolean).slice(0, 10).map(product => ({ name: product!.name, price: num(product!.price) })), endsAt: row.endsAt ? describeInstant(row.endsAt, tzOf(ctx)).human : null })).filter(item => item.products.length > 0);
    return ok({ promotions: items }, items.length ? `${items.length} promoção(ões) vigente(s)` : 'Nenhuma promoção vigente');
  },
});

export const searchKnowledge = defineTool({
  name: 'search_knowledge', kind: 'READ',
  schema: z.object({ query: z.string().trim().min(2).max(200).describe('o assunto ou a pergunta do cliente') }),
  description: 'Base de conhecimento do restaurante (respostas oficiais cadastradas pelo dono: estacionamento, políticas, eventos, alergênicos, regras da casa, perguntas frequentes). Consulte antes de dizer que não sabe algo.',
  async run(ctx, args) {
    const entries = await ctx.db.whatsappKnowledge.findMany({ where: { tenantId: ctx.tenantId, active: true }, take: 300 });
    const padded = ` ${normalizeText(args.query).replace(/[#:/.,-]/g, ' ')} `;
    const scored = entries.map(entry => {
      let score = matchScore(args.query, entry.title) * 1.5 + matchScore(args.query, entry.answer) * 0.5;
      for (const keyword of entry.keywords) { const k = normalizeText(keyword).replace(/[#:/.,-]/g, ' ').trim(); if (k && (padded.includes(` ${k} `) || (k.length >= 5 && padded.includes(k)))) score += 2 + k.split(' ').length * 0.5; }
      return { entry, score };
    }).filter(item => item.score >= 1).sort((a, b) => b.score - a.score).slice(0, 4);
    if (scored.length === 0) return ok({ found: false }, 'Nada na base de conhecimento');
    if (!ctx.dryRun) await ctx.db.whatsappKnowledge.update({ where: { id: scored[0].entry.id }, data: { hits: { increment: 1 } } }).catch(() => undefined);
    return ok({ found: true, entries: scored.map(item => ({ title: item.entry.title, answer: item.entry.answer })) }, `${scored.length} resposta(s) encontrada(s)`);
  },
});

export const resolveDatetime = defineTool({
  name: 'resolve_datetime', kind: 'READ',
  schema: z.object({ text: z.string().trim().min(2).max(120).describe('data e hora como o cliente escreveu, ex.: "sábado 20h", "amanhã 19:30", "25/12 21h"') }),
  description: 'Converte uma data/hora dita pelo cliente (hoje, amanhã, dia da semana, 25/12, 20h, 19:30) na data e hora exatas no fuso do restaurante. Use antes de reservas e pedidos agendados quando houver dúvida sobre o dia.',
  async run(ctx, args) {
    const parsed = parseWhen(args.text, tzOf(ctx), ctx.now);
    if ('error' in parsed) return fail(parsed.error, { NO_TIME: 'Não encontrei um horário no texto.', NO_DATE: 'Não encontrei o dia no texto.', INVALID: 'Data ou horário inválido.', PAST: 'Esse horário já passou ou está muito próximo (mínimo de 30 minutos à frente).', TOO_FAR: 'Só é possível para os próximos 90 dias.' }[parsed.error]);
    const d = describeInstant(parsed.at, tzOf(ctx));
    return ok({ date: d.date, time: d.time, weekday: d.weekday, human: d.human }, `Resolvido: ${d.human}`);
  },
});

export const infoTools: ToolDef[] = [getRestaurantInfo, listPaymentMethods, quoteDelivery, listPromotions, searchKnowledge, resolveDatetime];
export { clip };
