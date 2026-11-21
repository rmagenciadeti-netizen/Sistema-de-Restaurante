import { OrderChannel, OrderStatus, Prisma } from '@prisma/client';
import { z } from 'zod';
import { editOrder } from '../../order-edit';
import { OrderEngineError, priceOrderLines } from '../../order-engine';
import { OrderInventoryError } from '../../order-inventory';
import { applyStatusSideEffects } from '../../order-effects';
import { serializable } from '../../serializable';
import { placeStoreOrder, StoreOrderError } from '../../store-order';
import { normalizeText } from '../../whatsapp-text';
import { addAddress, touch } from '../memory';
import { defineTool, type ToolContext, type ToolDef } from '../types';
import { consumePending, requireConfirmation } from './confirm';
import { clip, describeInstant, fail, loadMyOrders, money, needPhone, num, ok, orderChangeability, orderRef, orderStatusTitle, tzOf, verifiedPhone, type OrderRow } from './common';
import { buildItem, explainOrderError, loadAgentMenu, orderDraftSchema, quoteDraft, type DraftQuote } from './menu';

const lineText = (line: DraftQuote['lines'][number]) => `${line.quantity}${line.weightKg ? ` (${line.weightKg} kg)` : 'x'} ${line.name}${line.options.length ? ` [${line.options.join(', ')}]` : ''} — ${money(line.total)}`;

const orderView = (ctx: ToolContext, order: OrderRow) => {
  const change = orderChangeability(ctx, order);
  const top = order.items.filter(item => !item.parentItemId);
  return {
    ref: orderRef(order), code: order.code, status: orderStatusTitle(ctx, order), kind: order.channel === 'DELIVERY' ? 'entrega' : order.channel === 'TAKEAWAY' ? 'retirada' : String(order.channel).toLowerCase(),
    placedAt: describeInstant(order.createdAt, tzOf(ctx)).human, scheduledFor: order.scheduledFor ? describeInstant(order.scheduledFor, tzOf(ctx)).human : null,
    items: top.map((item, index) => ({ line: index + 1, name: item.product.name, quantity: Number(item.quantity), options: item.modifiers.map(modifier => modifier.name), total: num(item.total) })),
    subtotal: num(order.subtotal), deliveryFee: num(order.deliveryFee), discount: num(order.discount), total: num(order.total), address: order.deliveryJob?.address ?? null,
    courier: order.deliveryJob?.status === 'PICKED_UP' ? order.deliveryJob.courierName : null, canChange: change.allowed, whyNot: change.allowed ? null : change.reason,
  };
};

export const getMyOrders = defineTool({
  name: 'get_my_orders', kind: 'READ', capability: 'orders',
  schema: z.object({ orderRef: z.string().trim().max(30).optional().describe('número (#42) ou código (P-ABC123) do pedido; omita para listar os mais recentes'), limit: z.number().int().min(1).max(10).optional() }),
  description: 'Pedidos recentes do cliente desta conversa (só os do telefone dele, últimos 30 dias): status atual, itens, valores, endereço, se ainda pode ser alterado/cancelado. É a única fonte do status de um pedido.',
  async run(ctx, args) {
    if (!verifiedPhone(ctx)) return needPhone();
    const rows = await loadMyOrders(ctx, { ref: args.orderRef, take: args.limit ?? 5 });
    if (rows.length === 0) return ok({ orders: [] }, args.orderRef ? 'Pedido não encontrado neste número' : 'Nenhum pedido recente neste número');
    return ok({ orders: rows.map(row => orderView(ctx, row)) }, `${rows.length} pedido(s)`);
  },
});

const placeSchema = z.object({ confirmation: z.string().trim().max(200).optional().describe('palavras exatas do cliente que confirmam o pedido (só na segunda chamada, depois que ele viu o resumo)') });
export const placeOrder = defineTool({
  name: 'place_order', kind: 'WRITE', capability: 'orders', schema: placeSchema,
  description: 'Finaliza o pedido que está no rascunho (update_order_draft). Exige confirmação: a primeira chamada devolve o resumo oficial (itens, entrega, taxa, total) para o cliente confirmar; o pedido só é criado na chamada seguinte, depois que o cliente responder, com "confirmation". Só diga que o pedido foi feito depois que retornar status PLACED.',
  async run(ctx, args) {
    const d = ctx.memory.order;
    if (d.items.length === 0) return fail('EMPTY_ORDER', 'Não há itens no rascunho do pedido. Monte o pedido com update_order_draft.');
    const quoted = await quoteDraft(ctx);
    if (!quoted.ok) return fail(quoted.code, quoted.message);
    const q = quoted.quote;
    if (q.missing.length) return fail('MISSING_INFO', `Ainda falta: ${q.missing.join(', ')}. Pergunte só o que falta.`, { });
    if (q.warnings.length) return fail('ORDER_RULE', q.warnings.join(' '));
    const total = q.total ?? q.subtotal;
    if (ctx.agent.maxOrderTotal > 0 && total > ctx.agent.maxOrderTotal) return fail('ORDER_ABOVE_LIMIT', `Pedidos acima de ${money(ctx.agent.maxOrderTotal)} precisam ser fechados por um atendente. Chame request_human_handoff com o resumo do pedido.`);
    const when = d.scheduledFor ? describeInstant(new Date(d.scheduledFor), tzOf(ctx)).human : null;
    const summary = [
      ...q.lines.map(lineText), `Subtotal: ${money(q.subtotal)}`,
      d.fulfillment === 'DELIVERY' ? `Entrega em: ${ctx.memory.delivery.address}${ctx.memory.delivery.zoneName ? ` (${ctx.memory.delivery.zoneName})` : ''} — taxa ${q.deliveryFee === 0 ? 'grátis' : money(q.deliveryFee ?? 0)}` : 'Retirada no local',
      `Total: ${money(total)}`, `Pagamento: ${q.paymentMethodName ?? 'a combinar'}${ctx.memory.payment.changeFor ? ` (troco para ${money(ctx.memory.payment.changeFor)})` : ''}`, ...(when ? [`Agendado para: ${when}`] : []), ...(d.notes ? [`Obs.: ${d.notes}`] : []),
    ].join('\n');
    const snapshot = { items: d.items.map(item => [item.productId, item.quantity, item.weightKg ?? 0, [...item.optionIds].sort(), item.notes ?? '']), f: d.fulfillment, a: ctx.memory.delivery.address ?? '', z: q.zoneId, p: q.paymentMethodId, c: ctx.memory.payment.changeFor ?? 0, n: d.notes ?? '', s: d.scheduledFor ?? '', k: d.couponCode ?? '', total };
    const gate = requireConfirmation(ctx, { action: 'place_order', snapshot, summary, confirmation: args.confirmation });
    if (!gate.proceed) return gate.output;
    if (ctx.dryRun) return ok({ status: 'PLACED', simulated: true, ref: '#SIM', total, note: 'simulação: nada foi gravado' }, 'Pedido simulado', { wrote: 'order' });

    const phone = verifiedPhone(ctx) ?? ctx.memory.profile.phone!;
    const name = ctx.memory.profile.name ?? ctx.customer.name ?? 'Cliente WhatsApp';
    const key = `wa-${ctx.messageId}-${gate && JSON.stringify(snapshot).length}`;
    try {
      const order = await placeStoreOrder(ctx.db, {
        tenantId: ctx.tenantId, unitId: ctx.unitId!, fulfillment: d.fulfillment!, customer: { name, phone }, address: ctx.memory.delivery.address, deliveryZoneId: q.zoneId ?? undefined, couponCode: d.couponCode,
        scheduledFor: d.scheduledFor ? new Date(d.scheduledFor) : undefined, notes: d.notes, paymentMethodId: q.paymentMethodId ?? undefined, changeFor: ctx.memory.payment.changeFor,
        items: d.items.map(item => ({ productId: item.productId, quantity: item.quantity, ...(item.weightKg ? { weightKg: item.weightKg } : {}), ...(item.notes ? { notes: item.notes } : {}), ...(item.optionIds.length ? { modifiers: item.optionIds.map(optionId => ({ optionId })) } : {}) })),
        origin: { provider: 'WHATSAPP', label: 'WHATSAPP_AGENT', clientRequestId: key, notifyCustomer: false },
      });
      if (ctx.memory.delivery.address) addAddress(ctx.memory, ctx.memory.delivery.address);
      ctx.memory.profile.name = ctx.memory.profile.name ?? name;
      ctx.memory.order = { items: [], lastOrderId: order.id, lastOrderNumber: orderRef(order), lastOrderAt: touch(ctx.now), updatedAt: touch(ctx.now) };
      ctx.memory.payment = {}; consumePending(ctx, 'place_order');
      await ctx.saveMemory();
      const minutes = ctx.env.settings.fulfillment.estimatedTime ? (d.fulfillment === 'DELIVERY' ? ctx.env.settings.fulfillment.deliveryMinutes : ctx.env.settings.fulfillment.pickupMinutes) : null;
      return ok({ status: 'PLACED', ref: orderRef(order), code: order.code, total: num(order.total), deliveryFee: num(order.deliveryFee), scheduledFor: order.scheduledFor ? describeInstant(order.scheduledFor, tzOf(ctx)).human : null, estimatedMinutes: minutes, fulfillment: d.fulfillment }, `Pedido ${orderRef(order)} registrado`, { wrote: 'order' });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        const existing = await ctx.db.order.findFirst({ where: { tenantId: ctx.tenantId, clientRequestId: key } });
        if (existing) return ok({ status: 'PLACED', ref: orderRef(existing), code: existing.code, total: num(existing.total) }, `Pedido ${orderRef(existing)} já registrado`, { wrote: 'order', duplicate: true });
      }
      if (error instanceof StoreOrderError) return fail(error.code, explainOrderError(error.code));
      if (error instanceof OrderEngineError) return fail(error.reason, explainOrderError(error.reason));
      if (error instanceof OrderInventoryError) return fail('INSUFFICIENT_STOCK', explainOrderError('INSUFFICIENT_STOCK'));
      throw error;
    }
  },
});

async function pickOrder(ctx: ToolContext, ref: string | undefined) {
  if (!verifiedPhone(ctx)) return { error: needPhone() };
  const rows = await loadMyOrders(ctx, { ref, take: 10 });
  const candidates = ref ? rows : rows.filter(row => orderChangeability(ctx, row).allowed);
  if (candidates.length === 0) return { error: fail('NOT_FOUND', ref ? 'Não encontrei esse pedido neste número.' : 'Não há pedido recente que ainda possa ser alterado ou cancelado neste número.') };
  if (candidates.length > 1 && !ref) return { error: fail('AMBIGUOUS', `Há mais de um pedido possível (${candidates.map(orderRef).join(', ')}). Pergunte qual.`) };
  return { order: candidates[0] };
}

const modifySchema = z.object({
  orderRef: z.string().trim().max(30).optional().describe('número do pedido (#42); pode omitir se só houver um que possa ser alterado'),
  addItems: orderDraftSchema.shape.addItems, removeItems: z.array(z.object({ line: z.number().int().min(1).max(40).describe('número da linha em get_my_orders') })).max(15).optional(), setQuantity: z.array(z.object({ line: z.number().int().min(1).max(40), quantity: z.number().positive().max(99) })).max(15).optional(),
  address: z.string().trim().max(300).optional().describe('novo endereço de entrega'), confirmation: z.string().trim().max(200).optional().describe('palavras exatas do cliente que confirmam a alteração (só na segunda chamada)'),
});
export const modifyOrder = defineTool({
  name: 'modify_order', kind: 'WRITE', capability: 'orderChanges', schema: modifySchema,
  description: 'Altera itens (incluir, remover, mudar quantidade/adicionais) ou o endereço de um pedido JÁ FEITO do próprio cliente, enquanto a cozinha ainda não começou e dentro do prazo. Exige confirmação (mesma regra de place_order) e mostra o novo total real. Se não for mais possível, explique e ofereça um atendente.',
  async run(ctx, args) {
    const picked = await pickOrder(ctx, args.orderRef);
    if (picked.error) return picked.error;
    const order = picked.order!;
    const change = orderChangeability(ctx, order);
    if (!change.allowed) return fail('NOT_CHANGEABLE', `${change.reason} Ofereça chamar um atendente.`);
    const top = order.items.filter(item => !item.parentItemId);
    type Line = { productId: string; quantity: number; weightKg?: number; withPackaging?: boolean; notes?: string; modifiers?: { optionId: string; quantity: number }[] };
    const original: (Line & { index: number })[] = top.map((item, index) => ({ index, productId: item.productId, quantity: Number(item.quantity), ...(item.weightKg ? { weightKg: Number(item.weightKg) } : {}), ...(item.withPackaging ? { withPackaging: true } : {}), ...(item.notes ? { notes: item.notes } : {}), ...(item.modifiers.length ? { modifiers: item.modifiers.map(modifier => ({ optionId: modifier.optionId!, quantity: modifier.quantity })) } : {}) }));
    for (const entry of args.setQuantity ?? []) { const target = original.find(line => line.index === entry.line - 1); if (target) target.quantity = entry.quantity; }
    const drop = new Set((args.removeItems ?? []).map(entry => entry.line - 1));
    let lines: Line[] = original.filter(line => !drop.has(line.index)).map(({ index: _index, ...line }) => line);
    if (args.addItems?.length) {
      const menu = await loadAgentMenu(ctx);
      for (const add of args.addItems) {
        const built = buildItem(menu, add);
        if (!built.ok) return built.out;
        lines.push({ productId: built.product.id, quantity: add.quantity, ...(add.weightKg ? { weightKg: add.weightKg } : {}), ...(add.notes ? { notes: add.notes } : {}), ...(built.chosen.length ? { modifiers: built.chosen.map(optionId => ({ optionId, quantity: 1 })) } : {}) });
      }
    }
    if (lines.length === 0) return fail('EMPTY_ORDER', 'Todos os itens seriam removidos; para isso o pedido deve ser cancelado (cancel_order).');
    if (args.address && order.channel !== OrderChannel.DELIVERY) return fail('DELIVERY_ONLY', 'Este pedido é para retirada; não há endereço de entrega.');
    let priced;
    try { priced = await priceOrderLines(ctx.db, { tenantId: ctx.tenantId, unitId: order.unitId, channel: order.channel }, lines, ctx.now); }
    catch (error) { if (error instanceof OrderEngineError) return fail(error.reason, explainOrderError(error.reason)); throw error; }
    const newTotal = Number(priced.subtotal.sub(order.discount).add(order.serviceFee).add(order.deliveryFee).add(order.couvertFee));
    const minDelivery = ctx.env.settings.fulfillment.minDelivery;
    if (order.channel === OrderChannel.DELIVERY && minDelivery > 0 && Number(priced.subtotal.sub(order.discount)) < minDelivery) return fail('BELOW_DELIVERY_MINIMUM', `O pedido ficaria abaixo do mínimo para entrega (${money(minDelivery)}).`);
    if (ctx.agent.maxOrderTotal > 0 && newTotal > ctx.agent.maxOrderTotal) return fail('ORDER_ABOVE_LIMIT', `Pedidos acima de ${money(ctx.agent.maxOrderTotal)} precisam ser alterados por um atendente.`);
    const summary = [`Pedido ${orderRef(order)} depois da alteração:`, ...priced.lines.map(line => `${Number(line.quantity)}x ${line.product.name}${line.selected.length ? ` [${line.selected.map(entry => entry.option.name).join(', ')}]` : ''} — ${money(line.total)}`), `Taxa de entrega: ${money(order.deliveryFee)}`, `Novo total: ${money(newTotal)} (antes ${money(order.total)})`, ...(args.address ? [`Novo endereço: ${args.address}`] : [])].join('\n');
    const gate = requireConfirmation(ctx, { action: 'modify_order', targetId: order.id, snapshot: { lines: lines.map(line => [line.productId, line.quantity, line.weightKg ?? 0, (line.modifiers ?? []).map(m => m.optionId).sort(), line.notes ?? '']), a: args.address ?? '', t: newTotal }, summary, confirmation: args.confirmation });
    if (!gate.proceed) return gate.output;
    if (ctx.dryRun) return ok({ status: 'MODIFIED', simulated: true, ref: orderRef(order), newTotal }, 'Alteração simulada', { wrote: 'modify' });
    try {
      await serializable(ctx.db, async tx => {
        await editOrder(tx, { orderId: order.id, tenantId: ctx.tenantId, unitId: null, actorUserId: null }, { items: lines, ...(args.address ? { address: args.address } : {}) });
        await tx.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: null, action: 'ORDER_EDITED_BY_WHATSAPP_AGENT', entityType: 'Order', entityId: order.id, metadata: { conversationId: ctx.conversationId, messageId: ctx.messageId } } });
      });
    } catch (error) {
      if (error instanceof OrderEngineError) return fail(error.reason, explainOrderError(error.reason));
      if (error instanceof OrderInventoryError) return fail('INSUFFICIENT_STOCK', explainOrderError('INSUFFICIENT_STOCK'));
      throw error;
    }
    consumePending(ctx, 'modify_order', order.id); await ctx.saveMemory();
    return ok({ status: 'MODIFIED', ref: orderRef(order), newTotal }, `Pedido ${orderRef(order)} alterado`, { wrote: 'modify' });
  },
});

const cancelSchema = z.object({ orderRef: z.string().trim().max(30).optional().describe('número do pedido (#42); pode omitir se só houver um que possa ser cancelado'), reason: z.string().trim().max(200).optional(), confirmation: z.string().trim().max(200).optional().describe('palavras exatas do cliente que confirmam o cancelamento (só na segunda chamada)') });
export const cancelOrder = defineTool({
  name: 'cancel_order', kind: 'WRITE', capability: 'orderChanges', schema: cancelSchema,
  description: 'Cancela um pedido do próprio cliente que ainda não entrou em preparo e está dentro do prazo. Exige confirmação (mesma regra de place_order). Se o pedido já estiver em preparo/pronto/entrega, não cancele: explique e chame um atendente.',
  async run(ctx, args) {
    const picked = await pickOrder(ctx, args.orderRef);
    if (picked.error) return picked.error;
    const order = picked.order!;
    const change = orderChangeability(ctx, order);
    if (!change.allowed) return fail('NOT_CANCELLABLE', `${change.reason} Ofereça chamar um atendente.`);
    const summary = `Cancelar o pedido ${orderRef(order)} (${order.items.filter(item => !item.parentItemId).map(item => `${Number(item.quantity)}x ${item.product.name}`).join(', ')}) no valor de ${money(order.total)}.`;
    const gate = requireConfirmation(ctx, { action: 'cancel_order', targetId: order.id, snapshot: { id: order.id, total: Number(order.total), status: order.status }, summary, confirmation: args.confirmation });
    if (!gate.proceed) return gate.output;
    if (ctx.dryRun) return ok({ status: 'CANCELLED', simulated: true, ref: orderRef(order) }, 'Cancelamento simulado', { wrote: 'cancel' });
    const outcome = await serializable(ctx.db, async tx => {
      const fresh = await tx.order.findFirst({ where: { id: order.id, tenantId: ctx.tenantId }, include: { customer: true, items: { include: { modifiers: true, product: { include: { recipe: { include: { ingredients: { include: { ingredient: true } } } } } } } } } });
      if (!fresh || fresh.status !== OrderStatus.OPEN) return 'NOT_OPEN' as const;
      if (await tx.payment.count({ where: { tenantId: ctx.tenantId, orderId: fresh.id, status: 'CONFIRMED' } }) > 0) return 'PAID' as const;
      await tx.order.update({ where: { id: fresh.id }, data: { status: OrderStatus.CANCELLED } });
      await applyStatusSideEffects(tx, fresh, OrderStatus.CANCELLED, null, { notifyCustomer: false });
      await tx.auditLog.create({ data: { tenantId: ctx.tenantId, actorUserId: null, action: 'ORDER_STATUS_CHANGED', entityType: 'Order', entityId: fresh.id, metadata: { status: 'CANCELLED', via: 'WHATSAPP_AGENT', reason: clip(args.reason ?? null, 200), conversationId: ctx.conversationId } } });
      return 'OK' as const;
    });
    if (outcome !== 'OK') return fail('NOT_CANCELLABLE', outcome === 'PAID' ? 'O pedido tem pagamento registrado; só a equipe pode cancelar.' : 'O pedido já mudou de situação (a cozinha começou). Chame um atendente.');
    consumePending(ctx, 'cancel_order', order.id); await ctx.saveMemory();
    return ok({ status: 'CANCELLED', ref: orderRef(order) }, `Pedido ${orderRef(order)} cancelado`, { wrote: 'cancel' });
  },
});

export const orderTools: ToolDef[] = [getMyOrders, placeOrder, modifyOrder, cancelOrder];
void normalizeText;
