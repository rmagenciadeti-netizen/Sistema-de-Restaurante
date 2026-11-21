import { randomBytes } from 'node:crypto';
import { OrderChannel, Prisma } from '@prisma/client';
import { z } from 'zod';
import { hiddenCategoryIds } from '../../menu-visibility';
import { OrderEngineError, priceOrderLines } from '../../order-engine';
import { effectiveUnitPrice, type ActivePromotion } from '../../promotions';
import { distinctiveWords, matchScore, normalizeText } from '../../whatsapp-text';
import { addAddress, touch, type DraftItem } from '../memory';
import { defineTool, type ToolContext, type ToolDef, type ToolOutput } from '../types';
import { clip, dateField, fail, money, num, ok, timeField, toInstant, tzOf, describeInstant } from './common';

export type MenuGroup = { id: string; name: string; min: number; max: number; options: { id: string; name: string; price: number }[] };
export type MenuProduct = { id: string; name: string; description: string | null; category: string; price: number; promo: number | null; byWeight: boolean; fractional: boolean; available: boolean; packaging: boolean; isCombo: boolean; groups: MenuGroup[] };

// The menu the customer may order from: same visibility rules as the virtual store (active, not venue-only, not a component, category schedule, unit prices, live promotions).
export async function loadAgentMenu(ctx: ToolContext): Promise<MenuProduct[]> {
  const unitScope = ctx.unitId ? { OR: [{ unitId: ctx.unitId }, { unitId: null }] } : {};
  const [products, hidden, promoRows, unitPrices] = await Promise.all([
    ctx.db.product.findMany({
      where: { tenantId: ctx.tenantId, active: true, localOnly: false, isComponent: false, ...unitScope },
      select: { id: true, name: true, description: true, price: true, soldByWeight: true, allowFractionalQuantity: true, stockControlled: true, stockQuantity: true, packagingEnabled: true, isCombo: true, category: { select: { id: true, name: true } }, modifierGroups: { select: { group: { select: { id: true, name: true, minSelect: true, maxSelect: true, active: true, options: { where: { active: true }, select: { id: true, name: true, price: true }, orderBy: { name: 'asc' } } } } } } },
      orderBy: { name: 'asc' }, take: 500,
    }),
    hiddenCategoryIds(ctx.db, ctx.tenantId, ctx.now),
    ctx.db.promotion.findMany({ where: { tenantId: ctx.tenantId, active: true, startsAt: { lte: ctx.now }, OR: [{ endsAt: null }, { endsAt: { gte: ctx.now } }] }, include: { products: { select: { productId: true } } } }),
    ctx.unitId ? ctx.db.productUnitPrice.findMany({ where: { tenantId: ctx.tenantId, unitId: ctx.unitId }, select: { productId: true, price: true } }) : Promise.resolve([]),
  ]);
  const promotions: ActivePromotion[] = promoRows.map(row => ({ type: row.type, value: row.value, startsAt: row.startsAt, endsAt: row.endsAt, active: row.active, productIds: row.products.map(link => link.productId) }));
  const override = new Map(unitPrices.map(row => [row.productId, row.price]));
  const out: MenuProduct[] = [];
  for (const product of products) {
    if (product.category && hidden.has(product.category.id)) continue;
    const base = override.get(product.id) ?? product.price;
    const price = effectiveUnitPrice(product.id, base, promotions, ctx.now);
    out.push({
      id: product.id, name: product.name, description: product.description, category: product.category?.name ?? 'Outros', price: Number(base), promo: price.lt(base) ? Number(price) : null,
      byWeight: product.soldByWeight, fractional: product.allowFractionalQuantity, available: !(product.stockControlled && Number(product.stockQuantity) <= 0), packaging: product.packagingEnabled, isCombo: product.isCombo,
      groups: product.modifierGroups.map(link => link.group).filter(group => group.active && group.options.length > 0).map(group => ({ id: group.id, name: group.name, min: group.minSelect, max: group.maxSelect, options: group.options.map(option => ({ id: option.id, name: option.name, price: Number(option.price) })) })),
    });
  }
  return out;
}

const view = (product: MenuProduct) => ({
  id: product.id, name: product.name, category: product.category, description: clip(product.description, 140), price: product.price, promoPrice: product.promo, unit: product.byWeight ? 'kg (preço por quilo; informe o peso)' : 'un', available: product.available,
  ...(product.groups.length ? { options: product.groups.map(group => ({ group: group.name, required: group.min > 0, min: group.min, max: group.max, choices: group.options.slice(0, 20).map(option => ({ id: option.id, name: option.name, extraPrice: option.price })) })) } : {}),
});

export const searchMenu = defineTool({
  name: 'search_menu', kind: 'READ',
  schema: z.object({
    query: z.string().trim().max(120).optional().describe('produto, ingrediente ou tipo de prato que o cliente citou (ex.: "hambúrguer", "algo sem carne", "suco")'),
    category: z.string().trim().max(80).optional().describe('nome da categoria, para listar o que há nela'),
    onlyPromotions: z.boolean().optional().describe('true para listar só itens em promoção'),
    limit: z.number().int().min(1).max(40).optional().describe('máximo de itens (padrão 12)'),
  }),
  description: 'Consulta o cardápio REAL: produtos, descrição, preço, preço promocional, disponibilidade e adicionais/opções (com ids e preços). Sem filtros devolve as categorias e os primeiros itens. Todo preço e adicional que você disser ao cliente deve vir daqui.',
  async run(ctx, args) {
    const menu = await loadAgentMenu(ctx);
    const limit = args.limit ?? 12;
    let items = menu;
    if (args.category) { const wanted = normalizeText(args.category); items = items.filter(product => { const c = normalizeText(product.category); return c === wanted || c.includes(wanted) || wanted.includes(c); }); }
    if (args.onlyPromotions) items = items.filter(product => product.promo !== null);
    if (args.query && distinctiveWords(args.query).length > 0) {
      const scored = items.map(product => ({ product, score: matchScore(args.query!, product.name) * 2 + matchScore(args.query!, product.category) + matchScore(args.query!, product.description ?? '') * 0.6 })).filter(entry => entry.score > 0).sort((a, b) => b.score - a.score);
      items = scored.map(entry => entry.product);
    }
    const categories = [...menu.reduce((map, product) => map.set(product.category, (map.get(product.category) ?? 0) + 1), new Map<string, number>())].map(([name, count]) => ({ name, items: count }));
    const shown = items.slice(0, limit);
    return ok({ totalProducts: menu.length, matching: items.length, categories, items: shown.map(view), ...(items.length > shown.length ? { note: `Mostrando ${shown.length} de ${items.length}; refine por categoria ou nome.` } : {}), ...(menu.length === 0 ? { note: 'Nenhum produto cadastrado no cardápio.' } : {}) }, `${items.length} item(ns) encontrado(s)`);
  },
});

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------
// Order draft: the cart being built in the conversation. Every change is validated and PRICED by the order engine, so the model never computes or guesses a price.
// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const ENGINE_MESSAGES: Record<string, string> = {
  PRODUCTS_UNAVAILABLE: 'Um dos produtos não está disponível para pedido por aqui.', MODIFIER_UNAVAILABLE: 'Um dos adicionais/opções escolhidos não existe ou não está disponível para esse produto.',
  MODIFIER_SELECTION_INVALID: 'A escolha de adicionais/opções não atende ao mínimo ou máximo exigido pelo produto.', WEIGHT_REQUIRED: 'Produto vendido por peso: informe o peso em kg.', WEIGHT_NOT_ALLOWED: 'Este produto não é vendido por peso.',
  FRACTIONAL_QUANTITY_NOT_ALLOWED: 'Este produto não permite quantidade fracionada.', COMBO_UNAVAILABLE: 'Um item do combo não está disponível.', PACKAGING_NOT_ALLOWED: 'Este produto não permite embalagem.',
  STORE_CLOSED: 'O restaurante está fechado agora e não recebe pedidos neste momento.', FULFILLMENT_NOT_ALLOWED: 'Este tipo de atendimento (entrega/retirada) não está disponível.', ADDRESS_REQUIRED: 'Para entrega é preciso o endereço completo.',
  DELIVERY_ZONE_REQUIRED: 'É preciso informar o bairro/região para calcular a entrega.', PAYMENT_METHOD_UNAVAILABLE: 'Essa forma de pagamento não está disponível para pedidos.', BELOW_DELIVERY_MINIMUM: 'O pedido está abaixo do valor mínimo para entrega.',
  COUPON_UNAVAILABLE: 'Cupom inválido, vencido ou esgotado.', SCHEDULING_DISABLED: 'O restaurante não aceita pedidos agendados.', SCHEDULE_TOO_SOON: 'O horário agendado está muito próximo.', SCHEDULE_TOO_FAR: 'O horário agendado está além do limite de dias.',
  SCHEDULE_BLOCKED: 'O restaurante não aceita agendamentos nessa data.', SCHEDULE_OUTSIDE_SLOTS: 'Esse horário está fora das faixas de agendamento.', INVALID_PHONE: 'Telefone inválido.', AGE_CONFIRMATION_REQUIRED: 'Este restaurante exige confirmação de maioridade; um atendente precisa concluir o pedido.',
  INSUFFICIENT_STOCK: 'Um dos itens acabou no estoque.', DELIVERY_ZONE_UNAVAILABLE: 'A região de entrega escolhida não está disponível.',
};
export const explainOrderError = (code: string) => ENGINE_MESSAGES[code] ?? `Não foi possível concluir (${code}).`;

const lineId = () => randomBytes(3).toString('hex');
const toEngineItems = (items: DraftItem[]) => items.map(item => ({ productId: item.productId, quantity: item.quantity, ...(item.weightKg ? { weightKg: item.weightKg } : {}), ...(item.notes ? { notes: item.notes } : {}), ...(item.optionIds.length ? { modifiers: item.optionIds.map(optionId => ({ optionId })) } : {}) }));

export type DraftQuote = {
  lines: { lineId: string; name: string; quantity: number; weightKg: number | null; options: string[]; unitPrice: number; total: number; notes?: string }[];
  subtotal: number; deliveryFee: number | null; total: number | null; goods: number;
  warnings: string[]; missing: string[]; zoneId: string | null; deliveryFeeOverride: boolean; paymentMethodId: string | null; paymentMethodName: string | null;
};

export async function resolvePaymentMethod(ctx: ToolContext, wanted: string) {
  const rows = await ctx.db.paymentMethodConfig.findMany({ where: { tenantId: ctx.tenantId, active: true, showStore: true }, orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }] });
  const n = normalizeText(wanted);
  const hint = /pix/.test(n) ? 'PIX' : /dinheiro|especie|cash/.test(n) ? 'CASH' : /credito|credit/.test(n) ? 'CREDIT_CARD' : /debito|debit/.test(n) ? 'DEBIT_CARD' : /vale|voucher|ticket|alimentacao|refeicao/.test(n) ? 'VOUCHER' : null;
  const found = !n ? undefined : rows.find(row => row.id === wanted) ?? rows.find(row => normalizeText(row.name) === n) ?? rows.find(row => normalizeText(row.name).includes(n) || n.includes(normalizeText(row.name))) ?? (hint ? rows.filter(row => row.equivalent === hint)[0] : undefined);
  return { rows, found };
}

// Prices the current draft with the real order engine and computes what is still missing for the order to be placed.
export async function quoteDraft(ctx: ToolContext): Promise<{ ok: true; quote: DraftQuote } | { ok: false; code: string; message: string }> {
  const d = ctx.memory.order; const f = ctx.env.settings.fulfillment;
  const channel = d.fulfillment === 'DELIVERY' ? OrderChannel.DELIVERY : OrderChannel.TAKEAWAY;
  let priced;
  try { priced = d.items.length ? await priceOrderLines(ctx.db, { tenantId: ctx.tenantId, unitId: ctx.unitId, channel }, toEngineItems(d.items), ctx.now) : { lines: [], subtotal: new Prisma.Decimal(0) }; }
  catch (error) { if (error instanceof OrderEngineError) return { ok: false, code: error.reason, message: explainOrderError(error.reason) }; throw error; }
  const lines = priced.lines.map((line, index) => ({ lineId: d.items[index].id, name: line.product.name, quantity: Number(line.quantity), weightKg: line.weightKg ? Number(line.weightKg) : null, options: line.selected.map(entry => `${entry.option.name}${entry.quantity > 1 ? ` x${entry.quantity}` : ''}`), unitPrice: Number(line.unitPrice), total: Number(line.total), ...(line.notes ? { notes: line.notes } : {}) }));
  const subtotal = Number(priced.subtotal);
  const warnings: string[] = []; const missing: string[] = [];
  if (d.items.length === 0) missing.push('itens do pedido');
  if (!d.fulfillment) missing.push('entrega ou retirada');
  let deliveryFee: number | null = d.fulfillment === 'TAKEAWAY' ? 0 : null; let zoneId: string | null = null; let override = false;
  if (d.fulfillment === 'DELIVERY') {
    if (!f.allowDelivery) warnings.push('O restaurante não faz entregas.');
    if (!ctx.memory.delivery.address) missing.push('endereço de entrega');
    if (f.deliveryFeeMode === 'SINGLE' || f.deliveryFeeMode === 'UNMAPPED') { deliveryFee = Number(f.singleFee); override = true; }
    else {
      const zones = await ctx.db.deliveryZone.count({ where: { tenantId: ctx.tenantId, active: true, ...(ctx.unitId ? { OR: [{ unitId: ctx.unitId }, { unitId: null }] } : {}) } });
      if (zones === 0) deliveryFee = 0;
      else if (ctx.memory.delivery.zoneId) {
        const zone = await ctx.db.deliveryZone.findFirst({ where: { id: ctx.memory.delivery.zoneId, tenantId: ctx.tenantId, active: true } });
        if (zone) { deliveryFee = Number(zone.fee); zoneId = zone.id; if (zone.minOrder && subtotal < Number(zone.minOrder)) warnings.push(`Pedido mínimo para ${zone.name}: ${money(zone.minOrder)}.`); } else missing.push('bairro/região de entrega');
      } else missing.push('bairro/região de entrega');
    }
    if (f.minDelivery > 0 && subtotal < f.minDelivery) warnings.push(`Pedido mínimo para entrega: ${money(f.minDelivery)} (faltam ${money(f.minDelivery - subtotal)}).`);
    if (f.freeDeliveryMin > 0 && deliveryFee && deliveryFee > 0 && subtotal >= f.freeDeliveryMin) deliveryFee = 0;
  }
  let paymentMethodId: string | null = null; let paymentMethodName: string | null = null;
  const methods = await resolvePaymentMethod(ctx, ctx.memory.payment.methodId ?? ctx.memory.payment.methodName ?? '');
  if (ctx.memory.payment.methodId || ctx.memory.payment.methodName) { if (methods.found) { paymentMethodId = methods.found.id; paymentMethodName = methods.found.name; } else missing.push('forma de pagamento válida'); }
  else if (methods.rows.length > 0) missing.push('forma de pagamento');
  if (!ctx.memory.profile.name && !ctx.customer.name) missing.push('nome do cliente');
  if (!(ctx.customer.phone && ctx.customer.phone.replace(/\D/g, '').length >= 8) && !ctx.memory.profile.phone) missing.push('telefone de contato');
  return { ok: true, quote: { lines, subtotal, deliveryFee, total: deliveryFee === null ? null : Number((subtotal + deliveryFee).toFixed(2)), goods: subtotal, warnings, missing, zoneId, deliveryFeeOverride: override, paymentMethodId, paymentMethodName } };
}

const draftView = (ctx: ToolContext, quote: DraftQuote) => ({
  lines: quote.lines, subtotal: quote.subtotal, deliveryFee: quote.deliveryFee, estimatedTotal: quote.total,
  fulfillment: ctx.memory.order.fulfillment ?? null, address: ctx.memory.delivery.address ?? null, region: ctx.memory.delivery.zoneName ?? ctx.memory.delivery.neighborhood ?? null,
  payment: quote.paymentMethodName ?? ctx.memory.payment.methodName ?? null, changeFor: ctx.memory.payment.changeFor ?? null, notes: ctx.memory.order.notes ?? null, scheduledFor: ctx.memory.order.scheduledFor ? describeInstant(new Date(ctx.memory.order.scheduledFor), tzOf(ctx)).human : null,
  missing: quote.missing, warnings: quote.warnings,
});

const itemSchema = z.object({
  productId: z.string().trim().min(1).max(60).describe('id do produto (de search_menu)'), quantity: z.number().positive().max(99).default(1), weightKg: z.number().positive().max(50).optional().describe('peso em kg, só para produtos vendidos por quilo'),
  optionIds: z.array(z.string().trim().max(60)).max(20).optional().describe('ids dos adicionais/opções escolhidos (de search_menu)'), notes: z.string().trim().max(200).optional().describe('observação do cliente para este item (ex.: sem cebola)'),
});

type ItemAdd = z.infer<typeof itemSchema>;
// Checks one requested item against the real menu (exists, in stock, options belong to it and satisfy each group's minimum/maximum).
export function buildItem(menu: MenuProduct[], add: ItemAdd): { ok: true; product: MenuProduct; chosen: string[]; names: string[] } | { ok: false; out: ToolOutput } {
  const product = menu.find(item => item.id === add.productId);
  if (!product) return { ok: false, out: fail('PRODUCT_NOT_FOUND', `O produto "${add.productId}" não está no cardápio. Use o id retornado por search_menu.`) };
  if (!product.available) return { ok: false, out: fail('OUT_OF_STOCK', `${product.name} está indisponível no momento.`) };
  const chosen = add.optionIds ?? [];
  for (const group of product.groups) {
    const count = chosen.filter(id => group.options.some(option => option.id === id)).length;
    if (count < group.min || count > group.max) return { ok: false, out: fail('OPTIONS_REQUIRED', `${product.name}: o grupo "${group.name}" exige escolher de ${group.min} a ${group.max} opção(ões). Opções: ${group.options.map(option => `${option.name} [${option.id}]${option.price ? ` +${money(option.price)}` : ''}`).join('; ')}. Pergunte ao cliente.`) };
  }
  const known = new Set(product.groups.flatMap(group => group.options.map(option => option.id)));
  const stray = chosen.find(id => !known.has(id));
  if (stray) return { ok: false, out: fail('OPTION_NOT_FOUND', `A opção "${stray}" não existe para ${product.name}.`) };
  return { ok: true, product, chosen, names: chosen.map(id => product.groups.flatMap(group => group.options).find(option => option.id === id)!.name) };
}

export const orderDraftSchema = z.object({
  addItems: z.array(itemSchema).max(15).optional(),
  removeItems: z.array(z.object({ lineId: z.string().trim().max(40).optional(), productId: z.string().trim().max(60).optional() })).max(15).optional().describe('linhas a remover, pelo lineId do rascunho (ou todas as linhas de um productId)'),
  setQuantity: z.array(z.object({ lineId: z.string().trim().max(40), quantity: z.number().positive().max(99) })).max(15).optional(),
  fulfillment: z.enum(['DELIVERY', 'TAKEAWAY']).optional().describe('DELIVERY = entrega; TAKEAWAY = retirada no local'),
  address: z.string().trim().max(300).optional().describe('endereço completo de entrega'), neighborhood: z.string().trim().max(80).optional().describe('bairro/região de entrega'),
  paymentMethod: z.string().trim().max(60).optional().describe('forma de pagamento escolhida pelo cliente (id ou nome de list_payment_methods)'), changeFor: z.number().positive().max(99999).optional().describe('valor da nota para o troco, se pagar em dinheiro'),
  notes: z.string().trim().max(300).optional().describe('observação geral do pedido'), couponCode: z.string().trim().max(40).optional().describe('cupom informado pelo cliente'),
  scheduledDate: dateField.optional().describe('para pedido agendado: dia'), scheduledTime: timeField.optional().describe('para pedido agendado: hora'), unschedule: z.boolean().optional().describe('true para cancelar o agendamento e pedir para agora'),
  contactPhone: z.string().trim().max(20).optional().describe('telefone do cliente, SOMENTE se o WhatsApp não revela o número'), customerName: z.string().trim().max(60).optional(),
  clear: z.boolean().optional().describe('true para esvaziar o rascunho do pedido'),
});

export const updateOrderDraft = defineTool({
  name: 'update_order_draft', kind: 'MEMORY', capability: 'orders', schema: orderDraftSchema,
  description: 'Monta e ajusta o pedido em andamento (rascunho). Valida cada item com o cardápio real, calcula preços, taxa de entrega e total, e informa o que ainda falta ("missing") para finalizar. Pode ser chamada várias vezes, a qualquer momento da conversa; nada é enviado à cozinha até o cliente confirmar. Para pedir algo "da mesma forma que antes", consulte get_my_orders.',
  async run(ctx, args) {
    const before = structuredClone({ order: ctx.memory.order, delivery: ctx.memory.delivery, payment: ctx.memory.payment, profile: ctx.memory.profile });
    const restore = () => { ctx.memory.order = before.order; ctx.memory.delivery = before.delivery; ctx.memory.payment = before.payment; ctx.memory.profile = before.profile; };
    const d = ctx.memory.order;
    if (args.clear) { ctx.memory.order = { items: [], lastOrderId: d.lastOrderId, lastOrderNumber: d.lastOrderNumber, lastOrderAt: d.lastOrderAt }; ctx.memory.delivery = {}; ctx.memory.payment = {}; ctx.memory.pending = ctx.memory.pending.filter(item => item.action !== 'place_order'); }
    const draft = ctx.memory.order;
    if (args.addItems?.length) {
      const menu = await loadAgentMenu(ctx);
      for (const add of args.addItems) {
        const built = buildItem(menu, add);
        if (!built.ok) { restore(); return built.out; }
        const { product, chosen, names } = built;
        const mergeable = !add.notes && !add.weightKg ? draft.items.find(item => item.productId === product.id && !item.notes && !item.weightKg && [...item.optionIds].sort().join() === [...chosen].sort().join()) : undefined;
        if (mergeable) mergeable.quantity = Math.min(999, mergeable.quantity + add.quantity);
        else draft.items.push({ id: lineId(), productId: product.id, name: product.name, quantity: add.quantity, ...(add.weightKg ? { weightKg: add.weightKg } : {}), optionIds: chosen, optionNames: names, ...(add.notes ? { notes: add.notes } : {}) });
      }
    }
    for (const removal of args.removeItems ?? []) draft.items = draft.items.filter(item => !(removal.lineId ? item.id === removal.lineId : removal.productId ? item.productId === removal.productId : false));
    for (const change of args.setQuantity ?? []) { const line = draft.items.find(item => item.id === change.lineId); if (line) line.quantity = change.quantity; }
    if (args.fulfillment) { draft.fulfillment = args.fulfillment; if (args.fulfillment === 'TAKEAWAY') ctx.memory.delivery = {}; }
    if (args.address) { ctx.memory.delivery.address = args.address; addAddress(ctx.memory, args.address); }
    if (args.neighborhood) {
      ctx.memory.delivery.neighborhood = args.neighborhood;
      const zones = await ctx.db.deliveryZone.findMany({ where: { tenantId: ctx.tenantId, active: true, ...(ctx.unitId ? { OR: [{ unitId: ctx.unitId }, { unitId: null }] } : {}) } });
      const n = normalizeText(args.neighborhood);
      const hits = zones.filter(zone => [zone.name, ...zone.neighborhoods].some(label => { const l = normalizeText(label); return l.length >= 3 && (n.includes(l) || l.includes(n)); }));
      if (hits.length === 1) { ctx.memory.delivery.zoneId = hits[0].id; ctx.memory.delivery.zoneName = hits[0].name; ctx.memory.delivery.fee = Number(hits[0].fee); }
      else { ctx.memory.delivery.zoneId = undefined; ctx.memory.delivery.zoneName = undefined; ctx.memory.delivery.fee = undefined; }
    }
    if (args.paymentMethod) {
      const { rows, found } = await resolvePaymentMethod(ctx, args.paymentMethod);
      if (rows.length > 0 && !found) { restore(); return fail('PAYMENT_METHOD_NOT_ACCEPTED', `"${args.paymentMethod}" não é aceita para pedidos. Aceitas: ${rows.map(row => row.name).join(', ')}.`); }
      ctx.memory.payment = { ...ctx.memory.payment, methodId: found?.id, methodName: found?.name ?? args.paymentMethod, updatedAt: touch(ctx.now) };
    }
    if (args.changeFor) ctx.memory.payment = { ...ctx.memory.payment, changeFor: args.changeFor };
    if (args.notes) draft.notes = args.notes;
    if (args.couponCode) draft.couponCode = args.couponCode.toUpperCase();
    if (args.unschedule) draft.scheduledFor = undefined;
    if (args.scheduledDate && args.scheduledTime) draft.scheduledFor = toInstant(args.scheduledDate, args.scheduledTime, tzOf(ctx)).toISOString();
    else if (args.scheduledDate || args.scheduledTime) { restore(); return fail('SCHEDULE_INCOMPLETE', 'Para agendar informe dia (scheduledDate) e hora (scheduledTime) juntos.'); }
    if (args.contactPhone && args.contactPhone.replace(/\D/g, '').length >= 8) ctx.memory.profile.phone = args.contactPhone.replace(/\D/g, '').slice(0, 15);
    if (args.customerName) ctx.memory.profile.name = args.customerName;
    draft.updatedAt = touch(ctx.now); ctx.memory.pending = ctx.memory.pending.filter(item => item.action !== 'place_order');
    const quoted = await quoteDraft(ctx);
    if (!quoted.ok) { restore(); return fail(quoted.code, quoted.message); }
    return ok(draftView(ctx, quoted.quote), draft.items.length ? `Pedido em andamento: ${draft.items.length} linha(s), faltam: ${quoted.quote.missing.join(', ') || 'nada'}` : 'Pedido vazio');
  },
});

export const menuTools: ToolDef[] = [searchMenu, updateOrderDraft];
export { draftView };
